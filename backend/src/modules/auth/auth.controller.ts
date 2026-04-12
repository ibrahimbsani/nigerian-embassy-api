import {
  Controller, Post, Get, Patch, Body, Request,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IsString, IsIn, IsEmail, IsOptional, Length, Matches } from 'class-validator';

class LoginDto {
  @IsString() identifier: string;
  @IsString() @IsIn(['passport', 'nin']) identifierType: 'passport' | 'nin';
  @IsString() @Length(6, 6) pin: string;
}

class RegisterDto {
  @IsString() passportNumber: string;
  @IsOptional() @IsString() nin?: string;
  @IsString() firstName: string;
  @IsString() lastName: string;
  @IsOptional() @IsString() middleName?: string;
  @IsString() dateOfBirth: string;
  @IsString() gender: string;
  @IsEmail() email: string;
  @IsString() phoneNumber: string;
  @IsString() countryOfResidence: string;
  @IsOptional() @IsString() cityOfResidence?: string;
  @IsOptional() @IsString() stateOfOrigin?: string;
  @IsOptional() @IsString() lgaOfOrigin?: string;
  @IsString() @Length(6, 6) @Matches(/^\d+$/) pin: string;
  @IsString() @Length(6, 6) confirmPin: string;
  @IsOptional() nextOfKin?: any;
}

class RefreshDto {
  @IsString() refreshToken: string;
}

class ChangePinDto {
  @IsString() currentPin: string;
  @IsString() @Length(6, 6) @Matches(/^\d+$/) newPin: string;
}

class FcmTokenDto {
  @IsString() fcmToken: string;
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    const result = await this.authService.login(dto.identifier, dto.identifierType, dto.pin);
    return { success: true, data: result };
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto) {
    const result = await this.authService.register(dto);
    return { success: true, data: result };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto) {
    const result = await this.authService.refresh(dto.refreshToken);
    return { success: true, data: result };
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async getProfile(@Request() req: any) {
    const result = await this.authService.getProfile(req.user.id);
    return { success: true, data: result };
  }

  @Patch('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async updateProfile(@Request() req: any, @Body() body: any) {
    const result = await this.authService.updateProfile(req.user.id, body);
    return { success: true, data: result };
  }

  @Patch('fcm-token')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async updateFcmToken(@Request() req: any, @Body() dto: FcmTokenDto) {
    const result = await this.authService.updateFcmToken(req.user.id, dto.fcmToken);
    return { success: true, data: result };
  }

  @Post('pin/change')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async changePin(@Request() req: any, @Body() dto: ChangePinDto) {
    const result = await this.authService.changePin(req.user.id, dto.currentPin, dto.newPin);
    return { success: true, data: result };
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  async logout(@Request() req: any) {
    const result = await this.authService.logout(req.user.id);
    return { success: true, data: result };
  }
}
