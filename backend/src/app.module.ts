import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaService } from './common/prisma.service';
import { HealthController } from './common/health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import {
  CitizensModule,
  ApplicationsModule,
  AppointmentsModule,
  DistressModule,
  SupportModule,
  NewsModule,
  TourismModule,
} from './modules/all-modules';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    ScheduleModule.forRoot(),
    AuthModule,
    NotificationsModule,
    CitizensModule,
    ApplicationsModule,
    AppointmentsModule,
    DistressModule,
    SupportModule,
    NewsModule,
    TourismModule,
  ],
  controllers: [HealthController],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class AppModule {}
