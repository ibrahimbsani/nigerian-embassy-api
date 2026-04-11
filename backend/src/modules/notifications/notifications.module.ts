// ─────────────────────────────────────────────────────────────────────────────
// Notifications Module — Firebase FCM + SendGrid email
// ─────────────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import * as sgMail from '@sendgrid/mail';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private firebaseInitialized = false;

  constructor(private config: ConfigService) {
    this.initFirebase();
    const sgKey = this.config.get('SENDGRID_API_KEY');
    if (sgKey) sgMail.setApiKey(sgKey);
  }

  private initFirebase() {
    try {
      const projectId = this.config.get('FIREBASE_PROJECT_ID');
      if (!projectId || admin.apps.length > 0) return;
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail: this.config.get('FIREBASE_CLIENT_EMAIL'),
          privateKey: this.config.get('FIREBASE_PRIVATE_KEY')?.replace(/\\n/g, '\n'),
        }),
      });
      this.firebaseInitialized = true;
      this.logger.log('Firebase Admin initialized');
    } catch (err) {
      this.logger.warn(`Firebase init skipped: ${err.message}`);
    }
  }

  async sendToDevice(fcmToken: string, payload: PushPayload): Promise<boolean> {
    if (!this.firebaseInitialized || !fcmToken) return false;
    try {
      await admin.messaging().send({
        token: fcmToken,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
        android: { priority: 'high', notification: { channelId: 'default', sound: 'default' } },
        apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      });
      return true;
    } catch (err) {
      this.logger.warn(`FCM send failed: ${err.message}`);
      return false;
    }
  }

  async notifyCitizen(citizenId: string, payload: PushPayload): Promise<boolean> {
    // Imported lazily to avoid circular deps
    const { PrismaService } = await import('../../common/prisma.service');
    return false; // Will be called with prisma injected in concrete modules
  }

  async notifyCitizenByToken(fcmToken: string | null, payload: PushPayload) {
    if (!fcmToken) return;
    await this.sendToDevice(fcmToken, payload);
  }

  async notifyStaff(payload: PushPayload) {
    if (!this.firebaseInitialized) return;
    try {
      await admin.messaging().send({
        topic: 'embassy-staff-alerts',
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
        android: { priority: 'high' },
      });
    } catch (err) {
      this.logger.warn(`Staff notification failed: ${err.message}`);
    }
  }

  async sendApplicationUpdate(citizenId: string, refNumber: string, status: string, message: string) {
    this.logger.log(`Application update: ${refNumber} -> ${status}`);
    // Push and email are handled by the calling service which has prisma access
  }

  async sendEmail(to: string, subject: string, html: string): Promise<boolean> {
    const fromEmail = this.config.get('SENDGRID_FROM_EMAIL');
    if (!fromEmail) { this.logger.warn('SendGrid not configured'); return false; }
    try {
      await (sgMail as any).send({
        to,
        from: { email: fromEmail, name: 'NigerianEmbassy — Jordan & Iraq' },
        subject,
        html,
        text: html.replace(/<[^>]*>/g, ''),
      });
      return true;
    } catch (err) {
      this.logger.error(`Email failed to ${to}: ${err.message}`);
      return false;
    }
  }

  buildApplicationUpdateEmail(name: string, ref: string, status: string, message: string): string {
    return `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1A5C38;padding:20px;text-align:center;">
          <h1 style="color:#fff;margin:0;">🇳🇬 NigerianEmbassy</h1>
          <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;">Jordan | Iraq</p>
        </div>
        <div style="background:#f9f9f9;padding:24px;border:1px solid #e2e6ea;">
          <p>Dear <strong>${name}</strong>,</p>
          <p>Your application <strong>${ref}</strong> has been updated:</p>
          <div style="background:#E8F5EE;border-left:4px solid #1A5C38;padding:12px 16px;margin:16px 0;">
            <p style="margin:0;font-weight:bold;color:#1A5C38;">Status: ${status}</p>
            <p style="margin:8px 0 0;">${message}</p>
          </div>
          <p>Log in to the NigerianEmbassy app to view full details.</p>
          <hr style="border:none;border-top:1px solid #e2e6ea;margin:20px 0;">
          <p style="color:#8A96A3;font-size:12px;text-align:center;">
            Nigerian Embassy, Amman — Accredited to Jordan and Iraq
          </p>
        </div>
      </div>
    `;
  }

  buildAppointmentReminderEmail(name: string, ref: string, service: string, date: string): string {
    return `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1A5C38;padding:20px;text-align:center;">
          <h1 style="color:#fff;margin:0;">🇳🇬 NigerianEmbassy</h1>
          <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;">Appointment Reminder</p>
        </div>
        <div style="background:#f9f9f9;padding:24px;border:1px solid #e2e6ea;">
          <p>Dear <strong>${name}</strong>,</p>
          <p>Reminder: you have an appointment <strong>tomorrow</strong>:</p>
          <div style="background:#E8F5EE;border-left:4px solid #1A5C38;padding:12px 16px;margin:16px 0;">
            <p style="margin:0;font-weight:bold;color:#1A5C38;">${service}</p>
            <p style="margin:4px 0 0;">${date}</p>
            <p style="margin:4px 0 0;">Ref: ${ref}</p>
          </div>
          <p>Location: Nigerian Embassy, 5th Circle, Amman, Jordan</p>
          <p style="font-size:13px;">Please bring all original documents.</p>
        </div>
      </div>
    `;
  }
}

@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
