import {
  Injectable, UnauthorizedException, BadRequestException,
  ConflictException, NotFoundException, Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  // ── Login ─────────────────────────────────────────────────────────────────
  async login(identifier: string, identifierType: 'passport' | 'nin', pin: string) {
    // Find citizen by passport or NIN
    const citizen = await this.prisma.citizen.findFirst({
      where: identifierType === 'passport'
        ? { passportNumber: identifier.toUpperCase() }
        : { nin: identifier },
      include: {
        nextOfKin: true,
        passportDetails: true,
        notifPrefs: true,
      },
    });

    if (!citizen) {
      throw new UnauthorizedException('No account found with those credentials.');
    }

    if (!citizen.isActive) {
      throw new UnauthorizedException('Your account has been suspended. Please contact the embassy.');
    }

    // Verify PIN
    const pinMatch = await bcrypt.compare(pin, citizen.pinHash);
    if (!pinMatch) {
      throw new UnauthorizedException('Incorrect PIN. Please try again.');
    }

    const tokens = await this.generateTokens(citizen.id);

    // Remove pinHash from response
    const { pinHash, ...citizenData } = citizen;

    return { ...tokens, citizen: citizenData };
  }

  // ── Register ──────────────────────────────────────────────────────────────
  async register(dto: any) {
    // Check for existing account
    const existing = await this.prisma.citizen.findFirst({
      where: {
        OR: [
          { passportNumber: dto.passportNumber.toUpperCase() },
          { email: dto.email.toLowerCase() },
          ...(dto.nin ? [{ nin: dto.nin }] : []),
        ],
      },
    });

    if (existing) {
      if (existing.passportNumber === dto.passportNumber.toUpperCase()) {
        throw new ConflictException('An account with this passport number already exists.');
      }
      if (existing.email === dto.email.toLowerCase()) {
        throw new ConflictException('An account with this email address already exists.');
      }
      throw new ConflictException('An account with these details already exists.');
    }

    if (dto.pin !== dto.confirmPin) {
      throw new BadRequestException('PINs do not match.');
    }

    if (dto.pin.length !== 6 || !/^\d{6}$/.test(dto.pin)) {
      throw new BadRequestException('PIN must be exactly 6 digits.');
    }

    const pinHash = await bcrypt.hash(dto.pin, 12);

    const citizen = await this.prisma.citizen.create({
      data: {
        id: uuidv4(),
        passportNumber: dto.passportNumber.toUpperCase(),
        nin: dto.nin || null,
        firstName: dto.firstName,
        lastName: dto.lastName,
        middleName: dto.middleName || null,
        dateOfBirth: dto.dateOfBirth,
        gender: dto.gender,
        email: dto.email.toLowerCase(),
        phoneNumber: dto.phoneNumber,
        countryOfResidence: dto.countryOfResidence,
        cityOfResidence: dto.cityOfResidence || '',
        stateOfOrigin: dto.stateOfOrigin || '',
        lgaOfOrigin: dto.lgaOfOrigin || '',
        pinHash,
        isVerified: false, // Embassy verifies manually
        notifPrefs: {
          create: {
            id: uuidv4(),
          },
        },
        ...(dto.nextOfKin ? {
          nextOfKin: {
            create: {
              id: uuidv4(),
              name: dto.nextOfKin.name,
              relationship: dto.nextOfKin.relationship,
              phoneNumber: dto.nextOfKin.phoneNumber,
              email: dto.nextOfKin.email,
            },
          },
        } : {}),
      },
      include: {
        nextOfKin: true,
        passportDetails: true,
        notifPrefs: true,
      },
    });

    this.logger.log(`New citizen registered: ${citizen.passportNumber} — ${citizen.firstName} ${citizen.lastName}`);

    const tokens = await this.generateTokens(citizen.id);
    const { pinHash: _, ...citizenData } = citizen;

    return { ...tokens, citizen: citizenData };
  }

  // ── Refresh token ─────────────────────────────────────────────────────────
  async refresh(refreshToken: string) {
    try {
      const payload = this.jwt.verify(refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });

      if (payload.type !== 'refresh') {
        throw new UnauthorizedException('Invalid token');
      }

      // Check token in DB
      const stored = await this.prisma.refreshToken.findFirst({
        where: { citizenId: payload.sub, expiresAt: { gt: new Date() } },
      });

      if (!stored) throw new UnauthorizedException('Token expired. Please sign in again.');

      const tokens = await this.generateTokens(payload.sub);
      return tokens;
    } catch {
      throw new UnauthorizedException('Invalid refresh token. Please sign in again.');
    }
  }

  // ── Get profile ───────────────────────────────────────────────────────────
  async getProfile(citizenId: string) {
    const citizen = await this.prisma.citizen.findUnique({
      where: { id: citizenId },
      include: { nextOfKin: true, passportDetails: true, notifPrefs: true },
    });
    if (!citizen) throw new NotFoundException('Citizen not found.');
    const { pinHash, ...rest } = citizen;
    return rest;
  }

  // ── Update profile ────────────────────────────────────────────────────────
  async updateProfile(citizenId: string, updates: any) {
    const citizen = await this.prisma.citizen.update({
      where: { id: citizenId },
      data: {
        firstName: updates.firstName,
        lastName: updates.lastName,
        email: updates.email,
        phoneNumber: updates.phoneNumber,
        countryOfResidence: updates.countryOfResidence,
        cityOfResidence: updates.cityOfResidence,
        preferredLanguage: updates.preferredLanguage,
        fcmToken: updates.fcmToken,
      },
      include: { nextOfKin: true, passportDetails: true, notifPrefs: true },
    });
    const { pinHash, ...rest } = citizen;
    return rest;
  }

  // ── Update FCM token ──────────────────────────────────────────────────────
  async updateFcmToken(citizenId: string, fcmToken: string) {
    await this.prisma.citizen.update({
      where: { id: citizenId },
      data: { fcmToken },
    });
    return { success: true };
  }

  // ── Change PIN ────────────────────────────────────────────────────────────
  async changePin(citizenId: string, currentPin: string, newPin: string) {
    const citizen = await this.prisma.citizen.findUnique({ where: { id: citizenId } });
    if (!citizen) throw new NotFoundException('Citizen not found.');

    const match = await bcrypt.compare(currentPin, citizen.pinHash);
    if (!match) throw new UnauthorizedException('Current PIN is incorrect.');

    if (!/^\d{6}$/.test(newPin)) throw new BadRequestException('New PIN must be exactly 6 digits.');

    const pinHash = await bcrypt.hash(newPin, 12);
    await this.prisma.citizen.update({ where: { id: citizenId }, data: { pinHash } });
    return { success: true, message: 'PIN updated successfully.' };
  }

  // ── Logout ────────────────────────────────────────────────────────────────
  async logout(citizenId: string) {
    await this.prisma.refreshToken.deleteMany({ where: { citizenId } });
    return { success: true };
  }

  // ── Token generation ──────────────────────────────────────────────────────
  private async generateTokens(citizenId: string) {
    const accessToken = this.jwt.sign(
      { sub: citizenId, type: 'access' },
      { expiresIn: this.config.get('JWT_EXPIRES_IN', '15m') },
    );

    const refreshToken = this.jwt.sign(
      { sub: citizenId, type: 'refresh' },
      {
        secret: this.config.get('JWT_REFRESH_SECRET'),
        expiresIn: this.config.get('JWT_REFRESH_EXPIRES_IN', '30d'),
      },
    );

    // Store refresh token hash
    const tokenHash = await bcrypt.hash(refreshToken, 8);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await this.prisma.refreshToken.create({
      data: { id: uuidv4(), citizenId, tokenHash, expiresAt },
    });

    // Clean old tokens
    await this.prisma.refreshToken.deleteMany({
      where: { citizenId, expiresAt: { lt: new Date() } },
    });

    return { token: accessToken, refreshToken };
  }
}
