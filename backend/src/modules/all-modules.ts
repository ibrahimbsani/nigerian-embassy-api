// ─────────────────────────────────────────────────────────────────────────────
// All remaining modules — fixed import paths
// all-modules.ts is at src/modules/ so:
//   common/ = ../common/
//   notifications = ./notifications/notifications.module
// ─────────────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common';
import {
  Controller, Get, Post, Patch, Body, Param, Request,
  UseGuards, Query, HttpCode, HttpStatus, Logger, Injectable,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { NotificationsService } from './notifications/notifications.module';
import { NotificationsModule } from './notifications/notifications.module';
import Anthropic from '@anthropic-ai/sdk';
import * as Twilio from 'twilio';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// APPLICATIONS MODULE
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE_PROCESSING_DAYS: Record<string, number> = {
  passport_renewal: 21,
  passport_new: 30,
  birth_certificate: 14,
  marriage_certificate: 14,
  death_certificate: 7,
  notarization: 5,
  certificate_of_life: 3,
  document_attestation: 7,
};

@Injectable()
class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  async create(citizenId: string, dto: any) {
    const refNumber = `NE-${(dto.country ?? 'JO').toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
    const processingDays = SERVICE_PROCESSING_DAYS[dto.serviceType] ?? 14;
    const estimatedDate = new Date();
    estimatedDate.setDate(estimatedDate.getDate() + processingDays);

    const application = await this.prisma.application.create({
      data: {
        id: uuidv4(),
        referenceNumber: refNumber,
        citizenId,
        serviceType: dto.serviceType,
        serviceLabel: dto.serviceLabel,
        country: dto.country,
        formData: dto.formData ?? {},
        estimatedCompletionDate: estimatedDate.toISOString().split('T')[0],
        events: {
          create: [{ id: uuidv4(), status: 'submitted', message: `Application submitted. Ref: ${refNumber}`, actor: 'system' }],
        },
      },
      include: { events: true, documents: true },
    });

    const citizen = await this.prisma.citizen.findUnique({ where: { id: citizenId }, select: { fcmToken: true } });
    if (citizen?.fcmToken) {
      await this.notifications.sendToDevice(citizen.fcmToken, { title: '📋 Application Submitted', body: `${dto.serviceLabel} — Ref: ${refNumber}` });
    }
    this.logger.log(`Application created: ${refNumber}`);
    return application;
  }

  async findByCitizen(citizenId: string) {
    return this.prisma.application.findMany({
      where: { citizenId },
      include: { events: { orderBy: { timestamp: 'asc' } }, documents: true },
      orderBy: { submittedAt: 'desc' },
    });
  }

  async findOne(id: string, citizenId: string) {
    return this.prisma.application.findFirst({
      where: { id, citizenId },
      include: { events: { orderBy: { timestamp: 'asc' } }, documents: true },
    });
  }

  async getPresignedUploadUrl(applicationId: string, fileName: string, mimeType: string, docType: string) {
    const s3Key = `applications/${applicationId}/${docType}/${uuidv4()}-${fileName}`;
    const documentId = uuidv4();
    await this.prisma.applicationDocument.create({
      data: { id: documentId, applicationId, docType, name: fileName, s3Key, mimeType, sizeBytes: 0 },
    });
    return { uploadUrl: `https://placeholder-s3/${s3Key}`, documentId, s3Key };
  }
}

@ApiTags('Applications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('applications')
class ApplicationsController {
  constructor(private service: ApplicationsService) {}

  @Post()
  async create(@Request() req: any, @Body() dto: any) {
    return { success: true, data: await this.service.create(req.user.id, dto) };
  }

  @Get()
  async findAll(@Request() req: any) {
    return { success: true, data: await this.service.findByCitizen(req.user.id) };
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id') id: string) {
    return { success: true, data: await this.service.findOne(id, req.user.id) };
  }

  @Post('documents/presign')
  async presign(@Body() body: any) {
    return { success: true, data: await this.service.getPresignedUploadUrl(body.applicationId, body.fileName, body.mimeType, body.docType) };
  }

  @Post('documents/:id/confirm')
  async confirmUpload(@Param('id') id: string) {
    return { success: true, data: { id, confirmed: true } };
  }
}

@Module({ imports: [NotificationsModule], controllers: [ApplicationsController], providers: [ApplicationsService, PrismaService], exports: [ApplicationsService] })
export class ApplicationsModule {}

// ─────────────────────────────────────────────────────────────────────────────
// DISTRESS MODULE
// ─────────────────────────────────────────────────────────────────────────────

const DUTY_NUMBERS: Record<string, string> = {
  jordan: process.env.DUTY_OFFICER_JORDAN ?? '+962777770001',
  iraq:   process.env.DUTY_OFFICER_IRAQ   ?? '+962777770002',
};

@Injectable()
class DistressService {
  private readonly logger = new Logger(DistressService.name);
  private twilio: any;

  constructor(private prisma: PrismaService, private config: ConfigService, private notifications: NotificationsService) {
    const sid = this.config.get('TWILIO_ACCOUNT_SID');
    const token = this.config.get('TWILIO_AUTH_TOKEN');
    if (sid && token) {
      try { this.twilio = (Twilio as any)(sid, token); } catch {}
    }
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
        const locationText = dto.latitude ? `GPS: ${dto.latitude.toFixed(5)},${dto.longitude.toFixed(5)}` : 'Location: Not available';
        const body = [`🚨 DISTRESS ALERT`, `Citizen: ${citizen.firstName} ${citizen.lastName}`, `Passport: ${citizen.passportNumber}`, `Phone: ${citizen.phoneNumber}`, `Country: ${(dto.country ?? '').toUpperCase()}`, `Emergency: ${dto.categoryLabel}`, locationText, `Alert ID: ${alert.id.slice(0, 8).toUpperCase()}`].join('\n');
        await this.twilio.messages.create({ body, from: this.config.get('TWILIO_FROM_NUMBER'), to: DUTY_NUMBERS[dto.country] ?? DUTY_NUMBERS.jordan });
        smsSent = true;
      } catch (err) {
        this.logger.error(`SMS failed: ${err.message}`);
      }
    }

    await this.prisma.distressAlert.update({ where: { id: alert.id }, data: { smsSent } });
    await this.notifications.notifyStaff({ title: '🚨 DISTRESS ALERT', body: `${citizen.firstName} ${citizen.lastName} — ${dto.categoryLabel}`, data: { type: 'distress_alert', alertId: alert.id } });
    if (citizen.fcmToken) await this.notifications.sendToDevice(citizen.fcmToken, { title: 'Alert Sent', body: 'The duty officer has been notified. Stay safe.' });

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
class DistressController {
  constructor(private service: DistressService) {}

  @Post('alert')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async sendAlert(@Body() dto: any) { return { success: true, data: await this.service.sendAlert(dto) }; }

  @Get('active')
  @UseGuards(JwtAuthGuard)
  async getActive() { return { success: true, data: await this.service.getActive() }; }

  @Post(':id/acknowledge')
  @UseGuards(JwtAuthGuard)
  async acknowledge(@Param('id') id: string, @Request() req: any) { return { success: true, data: await this.service.acknowledge(id, req.user.id) }; }

  @Post(':id/resolve')
  @UseGuards(JwtAuthGuard)
  async resolve(@Param('id') id: string) { return { success: true, data: await this.service.resolve(id) }; }
}

@Module({ imports: [NotificationsModule], controllers: [DistressController], providers: [DistressService, PrismaService], exports: [DistressService] })
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
    if (!this.anthropic) return { content: "I'm temporarily unavailable. Please send us a message directly." };
    try {
      const response = await this.anthropic.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 1024, system: systemPrompt, messages });
      const content = response.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      return { content };
    } catch (err) {
      this.logger.error(`Claude API error: ${err.message}`);
      return { content: "I'm having trouble connecting. Please try again shortly." };
    }
  }

  async createTicket(citizenId: string, dto: any) {
    const ticketNumber = `NE-${Date.now().toString(36).toUpperCase()}`;
    const citizen = await this.prisma.citizen.findUnique({ where: { id: citizenId } });
    const ticket = await this.prisma.supportTicket.create({
      data: {
        id: uuidv4(), ticketNumber, citizenId,
        subject: dto.subject ?? 'Chat inquiry',
        category: dto.category ?? 'general',
        status: 'open',
        country: citizen?.countryOfResidence ?? 'jordan',
        ...(dto.transcript || dto.message ? {
          messages: { create: [{ id: uuidv4(), sender: 'citizen', senderName: `${citizen?.firstName ?? ''} ${citizen?.lastName ?? ''}`.trim(), content: dto.transcript ?? dto.message }] }
        } : {}),
      },
    });
    await this.notifications.notifyStaff({ title: '💬 New Ticket', body: `${ticketNumber}: ${dto.subject ?? 'Chat inquiry'}`, data: { type: 'new_ticket', ticketId: ticket.id } });
    return { ticketNumber: ticket.ticketNumber, id: ticket.id };
  }

  async getTickets(citizenId: string) {
    return this.prisma.supportTicket.findMany({
      where: { citizenId },
      include: { messages: { orderBy: { timestamp: 'desc' }, take: 1 } },
      orderBy: { updatedAt: 'desc' },
    });
  }
}

@ApiTags('Support')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@Controller('support')
class SupportController {
  constructor(private service: SupportService) {}

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  async chat(@Body() body: any) { return { success: true, data: await this.service.chat(body.messages, body.systemPrompt) }; }

  @Post('tickets')
  @HttpCode(HttpStatus.CREATED)
  async createTicket(@Request() req: any, @Body() dto: any) { return { success: true, data: await this.service.createTicket(req.user.id, dto) }; }

  @Get('tickets')
  async getTickets(@Request() req: any) { return { success: true, data: await this.service.getTickets(req.user.id) }; }
}

@Module({ imports: [NotificationsModule], controllers: [SupportController], providers: [SupportService, PrismaService], exports: [SupportService] })
export class SupportModule {}

// ─────────────────────────────────────────────────────────────────────────────
// NEWS MODULE
// ─────────────────────────────────────────────────────────────────────────────

@ApiTags('News')
@Controller('news')
class NewsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async findAll(@Query('country') country: string) {
    const items = await this.prisma.newsItem.findMany({
      where: { isActive: true, OR: [{ country: 'both' }, ...(country ? [{ country }] : [])] },
      orderBy: [{ priority: 'desc' }, { publishedAt: 'desc' }],
    });
    return { success: true, data: items };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return { success: true, data: await this.prisma.newsItem.findUnique({ where: { id } }) };
  }
}

@Module({ controllers: [NewsController], providers: [PrismaService] })
export class NewsModule {}

// ─────────────────────────────────────────────────────────────────────────────
// TOURISM MODULE
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
      if (!appId) throw new Error('No API key');
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
      if (!apiKey) return null;
      const { data } = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${city},${country}&appid=${apiKey}&units=metric`);
      return { city: data.name, country: data.sys.country, temp: data.main.temp, feelsLike: data.main.feels_like, condition: data.weather[0].description, conditionCode: data.weather[0].id, humidity: data.main.humidity, windKph: Math.round(data.wind.speed * 3.6) };
    } catch { return null; }
  }
}

@ApiTags('Tourism')
@Controller('tourism')
class TourismController {
  constructor(private service: TourismService) {}
  @Get('rates') async getRates() { return { success: true, data: await this.service.getRates() }; }
  @Get('weather') async getWeather(@Query('city') city: string, @Query('country') country: string) { return { success: true, data: await this.service.getWeather(city, country) }; }
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
        id: uuidv4(), referenceNumber: refNum, citizenId,
        serviceType: dto.serviceType, serviceLabel: dto.serviceLabel,
        country: dto.country, scheduledDate: scheduledDateTime,
        scheduledTime: dto.scheduledTime, notes: dto.notes,
        location: dto.country === 'jordan' ? 'Nigerian Embassy, 5th Circle, Amman' : 'Nigerian Embassy (Amman) — Iraq Remote Service',
      },
    });
    const citizen = await this.prisma.citizen.findUnique({ where: { id: citizenId }, select: { fcmToken: true } });
    if (citizen?.fcmToken) await this.notifications.sendToDevice(citizen.fcmToken, { title: '📅 Appointment Confirmed', body: `${dto.serviceLabel} — ${dto.scheduledDate} at ${dto.scheduledTime}` });
    return appointment;
  }

  async findByCitizen(citizenId: string) {
    return this.prisma.appointment.findMany({ where: { citizenId }, orderBy: { scheduledDate: 'asc' } });
  }

  async update(id: string, dto: any) {
    return this.prisma.appointment.update({ where: { id }, data: { status: dto.status, notes: dto.notes } });
  }
}

@ApiTags('Appointments')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@Controller('appointments')
class AppointmentsController {
  constructor(private service: AppointmentsService) {}
  @Post() @HttpCode(HttpStatus.CREATED) async create(@Request() req: any, @Body() dto: any) { return { success: true, data: await this.service.create(req.user.id, dto) }; }
  @Get() async findAll(@Request() req: any) { return { success: true, data: await this.service.findByCitizen(req.user.id) }; }
  @Patch(':id') async update(@Param('id') id: string, @Body() dto: any) { return { success: true, data: await this.service.update(id, dto) }; }
}

@Module({ imports: [NotificationsModule], controllers: [AppointmentsController], providers: [AppointmentsService, PrismaService], exports: [AppointmentsService] })
export class AppointmentsModule {}

// ─────────────────────────────────────────────────────────────────────────────
// CITIZENS MODULE
// ─────────────────────────────────────────────────────────────────────────────

@ApiTags('Citizens')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@Controller('citizens')
class CitizensController {
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
