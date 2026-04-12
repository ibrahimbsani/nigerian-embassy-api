import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_SECRET'),
    });
  }

  async validate(payload: { sub: string; type: string }) {
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }
    const citizen = await this.prisma.citizen.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        passportNumber: true,
        firstName: true,
        lastName: true,
        email: true,
        countryOfResidence: true,
        isActive: true,
        isVerified: true,
      },
    });

    if (!citizen || !citizen.isActive) {
      throw new UnauthorizedException('Account not found or disabled.');
    }
    return citizen;
  }
}
