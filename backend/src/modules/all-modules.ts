// ─────────────────────────────────────────────────────────────────────────────
// All remaining modules in one file for brevity
// Each exports its Module class
// ─────────────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common';
import {
  Controller, Get, Post, Patch, Body, Param, Request,
  UseGuards, Query, HttpCode, HttpStatus, Logger, Injectable,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { NotificationsService } from '../notifications/notifications.service';
import Anthropic from '@anthropic-ai/sdk';
import * as Twilio from 'twilio';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// DISTRESS MODULE
// ─────────────────────────────────────────────────────────────────────────────

const DUTY_NUMBERS = {
  jordan: process.env.DUTY_OFFICER_JORDAN ?? '+962777770001',
  iraq:   process.env.DUTY_OFFICER_IRAQ   ?? '+962777770002',
};

@Injectable()
class DistressService {
  private readonly logger = new Logger(DistressService.name);
  private twilio: Twilio.Twilio;

  constructor(private prisma: PrismaService, private config: ConfigService, private notifications: NotificationsService) {
    const sid = this.config.get('TWILIO_ACCOUNT_SID');
    const token = this.config.get('TWILIO_AUTH_TOKEN');
    if (sid && token) this.twilio = (Twilio as any)(sid, token);
  }

  async sendAlert(dto: any) {
    const citizen = await this.prisma.citizen.findUnique({ where: { id: dto.citizenId } });
    if (!citizen) throw new Error('Citizen not found');

    const alert = await this.prisma.distressAlert.create({
      data: {
        id: uuidv4(),
        citizenId: citizen.id,
        categoryId: dto.categoryId,
        categoryLabel: dto.categoryLabel,
        country: dto.country,
        latitude: dto.latitude,
        longitude: dto.longitude,
        accuracy: dto.accuracy,
        address: dto.address,
        status: 'sent',
        smsSent: false,
      },
    });

    let smsSent = false;
    if (this.twilio) {
      try {
        const locationText = dto.latitude
          ? `GPS: ${dto.latitude.toFixed(5)},${dto.longitude.toFixed(5)}${dto.address ? ` (${dto.address})` : ''}`
          : 'Location: Not available';
        const body = [
          `🚨 DISTRESS ALERT — NigerianEmbassy`,
          `Citizen: ${citizen.firstName} ${citizen.lastName}`,
          `Passport: ${citizen.passportNumber}`,
          `Phone: ${citizen.phoneNumber}`,
          `Country: ${dto.country?.toUpperCase()}`,
          `Emergency: ${dto.categoryLabel}`,
          locationText,
          `Alert ID: ${alert.id.slice(0, 8).toUpperCase()}`,
        ].join('\n');
        await this.twilio.messages.create({
          body,
          from: this.config.get('TWILIO_FROM_NUMBER'),
          to: DUTY_NUMBERS[dto.country as 'jordan' | 'iraq'],
        });
        smsSent = true;
      } catch (err) {
        this.logger.error(`SMS failed: ${err.message}`);
      }
    }

    await this.prisma.distressAlert.update({ where: { id: alert.id }, data: { smsSent } });
    await this.notifications.notifyStaff({ title: '🚨 DISTRESS ALERT', body: `${citizen.firstName} ${citizen.lastName} — ${dto.categoryLabel}`, data: { type: 'distress_alert', alertId: alert.id } });

    if (citizen.fcmToken) {
      await this.notifications.sendToDevice(citizen.fcmToken, { title: 'Alert Sent', body: 'The duty officer has been notified. Stay safe.' });
    }

    return { id: alert.id, smsSent, status: 'sent' };
  }

  async getActive() {
    return this.prisma.distressAlert.findMany({
      where: { status: { in: ['sent', 'acknowledged'] } },
      include: { citizen: { select: { firstName: true, lastName: true, phoneNumber: true, passportNumber: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async acknowledge(id: string, officerId: string) {
    return this.prisma.distressAlert.update({ where: { id }, data: { status: 'acknowledged', acknowledgedBy: officerId } });
  }

  async resolve(id: string) {
    return this.prisma.distressAlert.update({ where: { id }, data: { status: 'resolved', resolvedAt: new Date() } });
  }
}

@ApiTags('Distress')
@Controller('distress')
export class DistressController {
  constructor(private service: DistressService) {}

  @Post('alert')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async sendAlert(@Body() dto: any) {
    const data = await this.service.sendAlert(dto);
    return { success: true, data };
  }

  @Get('active')
  @UseGuards(JwtAuthGuard)
  async getActive() {
    return { success: true, data: await this.service.getActive() };
  }

  @Post(':id/acknowledge')
  @UseGuards(JwtAuthGuard)
  async acknowledge(@Param('id') id: string, @Request() req: any) {
    return { success: true, data: await this.service.acknowledge(id, req.user.id) };
  }

  @Post(':id/resolve')
  @UseGuards(JwtAuthGuard)
  async resolve(@Param('id') id: string) {
    return { success: true, data: await this.service.resolve(id) };
  }
}

@Module({ imports: [], controllers: [DistressController], providers: [DistressService, PrismaService], exports: [DistressService] })
export class DistressModule {}

// ─────────────────────────────────────────────────────────────────────────────
// SUPPORT MODULE
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
class SupportService {
  private readonly logger = new Logger(SupportService.name);
  private anthropic: Anthropic;

  constructor(private prisma: PrismaService, private config: ConfigService, private notifications: NotificationsService) {
    const key = this.config.get('ANTHROPIC_API_KEY');
    if (key) this.anthropic = new Anthropic({ apiKey: key });
  }

  async chat(messages: any[], systemPrompt: string) {
    if (!this.anthropic) return { content: "I'm temporarily unavailable. Please use 'Send a Message' to contact us." };
    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      });
      const content = response.content.filter(b => b.type === 'text').map(b => (b as any).text).join('');
      return { content };
    } catch (err) {
      this.logger.error(`Claude API error: ${err.message}`);
      return { content: "I'm having trouble connecting. Please try again or send us a message directly." };
    }
  }

  async createTicket(citizenId: string, dto: any) {
    const ticketNumber = `NE-${Date.now().toString(36).toUpperCase()}`;
    const citizen = await this.prisma.citizen.findUnique({ where: { id: citizenId } });

    const ticket = await this.prisma.supportTicket.create({
      data: {
        id: uuidv4(),
        ticketNumber,
        citizenId,
        subject: dto.subject ?? 'Chat inquiry',
        category: dto.category ?? 'general',
        status: 'open',
        country: citizen?.countryOfResidence ?? 'jordan',
        messages: dto.transcript ? {
          create: [{ id: uuidv4(), sender: 'citizen', senderName: `${citizen?.firstName} ${citizen?.lastName}`, content: dto.transcript }]
        } : dto.message ? {
          create: [{ id: uuidv4(), sender: 'citizen', senderName: `${citizen?.firstName} ${citizen?.lastName}`, content: dto.message }]
        } : undefined,
      },
    });

    await this.notifications.notifyStaff({ title: '💬 New Ticket', body: `${ticketNumber}: ${dto.subject}`, data: { type: 'new_ticket', ticketId: ticket.id } });
    return { ticketNumber: ticket.ticketNumber, id: ticket.id };
  }

  async getTickets(citizenId: string) {
    return this.prisma.supportTicket.findMany({
      where: { citizenId },
      include: { messages: { orderBy: { timestamp: 'desc' }, take: 1 } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getTicketMessages(ticketId: string) {
    return this.prisma.ticketMessage.findMany({ where: { ticketId }, orderBy: { timestamp: 'asc' } });
  }
}

@ApiTags('Support')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@Controller('support')
export class SupportController {
  constructor(private service: SupportService) {}

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  async chat(@Body() body: any) {
    const data = await this.service.chat(body.messages, body.systemPrompt);
    return { success: true, data };
  }

  @Post('tickets')
  @HttpCode(HttpStatus.CREATED)
  async createTicket(@Request() req: any, @Body() dto: any) {
    const data = await this.service.createTicket(req.user.id, dto);
    return { success: true, data };
  }

  @Get('tickets')
  async getTickets(@Request() req: any) {
    return { success: true, data: await this.service.getTickets(req.user.id) };
  }

  @Get('tickets/:id/messages')
  async getMessages(@Param('id') id: string) {
    return { success: true, data: await this.service.getTicketMessages(id) };
  }
}

@Module({ imports: [], controllers: [SupportController], providers: [SupportService, PrismaService], exports: [SupportService] })
export class SupportModule {}

// ─────────────────────────────────────────────────────────────────────────────
// NEWS MODULE
// ─────────────────────────────────────────────────────────────────────────────

@ApiTags('News')
@Controller('news')
export class NewsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async findAll(@Query('country') country: string) {
    const items = await this.prisma.newsItem.findMany({
      where: {
        isActive: true,
        OR: [{ country: 'both' }, ...(country ? [{ country }] : [])],
      },
      orderBy: [{ priority: 'desc' }, { publishedAt: 'desc' }],
    });
    return { success: true, data: items };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const item = await this.prisma.newsItem.findUnique({ where: { id } });
    return { success: true, data: item };
  }
}

@Module({ controllers: [NewsController], providers: [PrismaService] })
export class NewsModule {}

// ─────────────────────────────────────────────────────────────────────────────
// TOURISM MODULE (weather + currency proxy)
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
class TourismService {
  private ratesCache: any = null;
  private ratesCacheTime = 0;

  constructor(private config: ConfigService) {}

  async getRates() {
    if (this.ratesCache && Date.now() - this.ratesCacheTime < 30 * 60 * 1000) return this.ratesCache;
    try {
      const appId = this.config.get('OPEN_EXCHANGE_RATES_APP_ID');
      const { data } = await axios.get(`https://openexchangerates.org/api/latest.json?app_id=${appId}&base=USD&symbols=NGN,JOD,IQD,GBP,EUR`);
      const ngnRate = data.rates.NGN;
      this.ratesCache = { base: 'NGN', rates: { JOD: data.rates.JOD / ngnRate, IQD: data.rates.IQD / ngnRate, USD: 1 / ngnRate, GBP: data.rates.GBP / ngnRate, EUR: data.rates.EUR / ngnRate }, timestamp: data.timestamp * 1000 };
      this.ratesCacheTime = Date.now();
      return this.ratesCache;
    } catch {
      return { base: 'NGN', rates: { JOD: 0.000849, IQD: 1.638, USD: 0.0006, GBP: 0.00048, EUR: 0.00056 }, timestamp: Date.now() };
    }
  }

  async getWeather(city: string, country: string) {
    try {
      const apiKey = this.config.get('OPENWEATHER_API_KEY');
      const { data } = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${city},${country}&appid=${apiKey}&units=metric`);
      return { city: data.name, country: data.sys.country, temp: data.main.temp, feelsLike: data.main.feels_like, condition: data.weather[0].description, conditionCode: data.weather[0].id, humidity: data.main.humidity, windKph: Math.round(data.wind.speed * 3.6) };
    } catch { return null; }
  }
}

@ApiTags('Tourism')
@Controller('tourism')
export class TourismController {
  constructor(private service: TourismService) {}

  @Get('rates')
  async getRates() { return { success: true, data: await this.service.getRates() }; }

  @Get('weather')
  async getWeather(@Query('city') city: string, @Query('country') country: string) {
    return { success: true, data: await this.service.getWeather(city, country) };
  }
}

@Module({ controllers: [TourismController], providers: [TourismService] })
export class TourismModule {}

// ─────────────────────────────────────────────────────────────────────────────
// APPOINTMENTS MODULE
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
class AppointmentsService {
  private readonly logger = new Logger(AppointmentsService.name);

  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  async create(citizenId: string, dto: any) {
    const refNum = `NE-APT-${Date.now().toString(36).toUpperCase()}`;
    const scheduledDateTime = new Date(`${dto.scheduledDate}T${dto.scheduledTime}:00`);

    const appointment = await this.prisma.appointment.create({
      data: {
        id: uuidv4(),
        referenceNumber: refNum,
        citizenId,
        serviceType: dto.serviceType,
        serviceLabel: dto.serviceLabel,
        country: dto.country,
        scheduledDate: scheduledDateTime,
        scheduledTime: dto.scheduledTime,
        notes: dto.notes,
        location: dto.country === 'jordan'
          ? 'Nigerian Embassy, 5th Circle, Amman, Jordan'
          : 'Nigerian Embassy (Amman) — Iraq Remote Service',
      },
    });

    const citizen = await this.prisma.citizen.findUnique({ where: { id: citizenId }, select: { fcmToken: true } });
    if (citizen?.fcmToken) {
      await this.notifications.sendToDevice(citizen.fcmToken, { title: '📅 Appointment Confirmed', body: `${dto.serviceLabel} — ${dto.scheduledDate} at ${dto.scheduledTime}` });
    }

    return appointment;
  }

  async findByCitizen(citizenId: string) {
    return this.prisma.appointment.findMany({ where: { citizenId }, orderBy: { scheduledDate: 'asc' } });
  }

  async update(id: string, dto: any) {
    return this.prisma.appointment.update({ where: { id }, data: { status: dto.status, notes: dto.notes } });
  }

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async sendDueReminders() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const start = new Date(tomorrow); start.setHours(0, 0, 0, 0);
    const end = new Date(tomorrow); end.setHours(23, 59, 59, 999);

    const appointments = await this.prisma.appointment.findMany({
      where: { scheduledDate: { gte: start, lte: end }, status: { in: ['scheduled', 'confirmed'] }, reminderSent: false },
      include: { citizen: { select: { fcmToken: true, email: true, firstName: true } } },
    });

    for (const appt of appointments) {
      if (appt.citizen.fcmToken) {
        await this.notifications.sendToDevice(appt.citizen.fcmToken, {
          title: '📅 Appointment Tomorrow',
          body: `${appt.serviceLabel} — ${appt.scheduledTime}`,
        });
      }
      await this.prisma.appointment.update({ where: { id: appt.id }, data: { reminderSent: true } });
    }
    this.logger.log(`Sent ${appointments.length} appointment reminders`);
  }
}

@ApiTags('Appointments')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@Controller('appointments')
export class AppointmentsController {
  constructor(private service: AppointmentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Request() req: any, @Body() dto: any) {
    return { success: true, data: await this.service.create(req.user.id, dto) };
  }

  @Get()
  async findAll(@Request() req: any) {
    return { success: true, data: await this.service.findByCitizen(req.user.id) };
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: any) {
    return { success: true, data: await this.service.update(id, dto) };
  }
}

@Module({ controllers: [AppointmentsController], providers: [AppointmentsService, PrismaService] })
export class AppointmentsModule {}

// ─────────────────────────────────────────────────────────────────────────────
// CITIZENS MODULE
// ─────────────────────────────────────────────────────────────────────────────

@ApiTags('Citizens')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@Controller('citizens')
export class CitizensController {
  constructor(private prisma: PrismaService) {}

  @Get('me')
  async getMe(@Request() req: any) {
    const citizen = await this.prisma.citizen.findUnique({
      where: { id: req.user.id },
      include: { nextOfKin: true, passportDetails: true, notifPrefs: true },
    });
    return { success: true, data: citizen };
  }

  @Patch('me/notifications')
  async updateNotifPrefs(@Request() req: any, @Body() dto: any) {
    const prefs = await this.prisma.notificationPreference.upsert({
      where: { citizenId: req.user.id },
      update: dto,
      create: { id: uuidv4(), citizenId: req.user.id, ...dto },
    });
    return { success: true, data: prefs };
  }
}

@Module({ controllers: [CitizensController], providers: [PrismaService] })
export class CitizensModule {}
