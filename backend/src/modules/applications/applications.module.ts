// ─────────────────────────────────────────────────────────────────────────────
// Applications Module — full CRUD for consular service applications
// ─────────────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common';
import { Controller, Get, Post, Patch, Body, Param, Request, UseGuards, Query } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../common/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { NotificationsService } from '../notifications/notifications.service';
import { v4 as uuidv4 } from 'uuid';

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
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async create(citizenId: string, dto: any) {
    const refNumber = `NE-${dto.country?.toUpperCase() ?? 'JO'}-${Date.now().toString(36).toUpperCase()}`;

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
          create: [{
            id: uuidv4(),
            status: 'submitted',
            message: `Application submitted successfully. Reference: ${refNumber}`,
            actor: 'system',
          }],
        },
      },
      include: { events: true, documents: true },
    });

    // Push notification
    await this.notifications.notifyCitizen(citizenId, {
      title: '📋 Application Submitted',
      body: `${dto.serviceLabel} — Ref: ${refNumber}`,
      data: { type: 'application_submitted', applicationId: application.id },
    }).catch(() => {});

    this.logger.log(`Application created: ${refNumber} for citizen ${citizenId}`);
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
      include: {
        events: { orderBy: { timestamp: 'asc' } },
        documents: true,
        appointment: true,
      },
    });
  }

  async updateStatus(id: string, status: string, message: string, officerId: string) {
    const application = await this.prisma.application.update({
      where: { id },
      data: {
        status: status as any,
        handledByOfficerId: officerId,
        events: {
          create: [{
            id: uuidv4(),
            status: status as any,
            message,
            actor: 'officer',
            actorId: officerId,
          }],
        },
      },
      include: { citizen: { select: { id: true, firstName: true } } },
    });

    // Notify citizen
    await this.notifications.sendApplicationUpdate(
      application.citizenId,
      application.referenceNumber,
      status,
      message,
    ).catch(() => {});

    return application;
  }

  async getPresignedUploadUrl(applicationId: string, fileName: string, mimeType: string, docType: string) {
    const s3Key = `applications/${applicationId}/${docType}/${uuidv4()}-${fileName}`;
    // In production, generate real S3 presigned URL
    // For now return a placeholder
    const documentId = uuidv4();
    await this.prisma.applicationDocument.create({
      data: {
        id: documentId,
        applicationId,
        docType,
        name: fileName,
        s3Key,
        mimeType,
        sizeBytes: 0,
      },
    });
    return {
      uploadUrl: `https://your-s3-bucket.s3.amazonaws.com/${s3Key}`,
      documentId,
      s3Key,
    };
  }
}

@ApiTags('Applications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('applications')
export class ApplicationsController {
  constructor(private service: ApplicationsService) {}

  @Post()
  async create(@Request() req: any, @Body() dto: any) {
    const result = await this.service.create(req.user.id, dto);
    return { success: true, data: result };
  }

  @Get()
  async findAll(@Request() req: any) {
    const data = await this.service.findByCitizen(req.user.id);
    return { success: true, data };
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id') id: string) {
    const data = await this.service.findOne(id, req.user.id);
    return { success: true, data };
  }

  @Post('documents/presign')
  async presign(@Body() body: any) {
    const data = await this.service.getPresignedUploadUrl(
      body.applicationId, body.fileName, body.mimeType, body.docType,
    );
    return { success: true, data };
  }

  @Post('documents/:id/confirm')
  async confirmUpload(@Param('id') id: string) {
    const doc = await this.service['prisma'].applicationDocument.findUnique({ where: { id } });
    return { success: true, data: doc };
  }
}

@Module({
  imports: [],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, PrismaService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
