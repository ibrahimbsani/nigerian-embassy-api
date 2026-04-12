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
  private firebaseReady = false;

  constructor(private config: ConfigService) {
    this.initFirebase();
    const sgKey = this.config.get<string>('SENDGRID_API_KEY');
    if (sgKey) (sgMail as any).setApiKey(sgKey);
  }

  private initFirebase() {
    try {
      const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');
      if (!projectId || admin.apps.length > 0) return;
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail: this.config.get('FIREBASE_CLIENT_EMAIL'),
          privateKey: this.config.get<string>('FIREBASE_PRIVATE_KEY')?.replace(/\\n/g, '\n'),
        }),
      });
      this.firebaseReady = true;
      this.logger.log('Firebase Admin initialized');
    } catch (err) {
      this.logger.warn(`Firebase init skipped: ${err.message}`);
    }
  }

  async sendToDevice(fcmToken: string, payload: PushPayload): Promise<boolean> {
    if (!this.firebaseReady || !fcmToken) return false;
    try {
      await admin.messaging().send({
        token: fcmToken,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
        android: { priority: 'high' as const, notification: { channelId: 'default', sound: 'default' } },
        apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      });
      return true;
    } catch (err) {
      this.logger.warn(`FCM send failed: ${err.message}`);
      return false;
    }
  }

  async notifyStaff(payload: PushPayload) {
    if (!this.firebaseReady) return;
    try {
      await admin.messaging().send({
        topic: 'embassy-staff-alerts',
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
        android: { priority: 'high' as const },
      });
    } catch (err) {
      this.logger.warn(`Staff notification failed: ${err.message}`);
    }
  }

  async sendEmail(to: string, subject: string, html: string): Promise<boolean> {
    const fromEmail = this.config.get<string>('SENDGRID_FROM_EMAIL');
    if (!fromEmail) return false;
    try {
      await (sgMail as any).send({ to, from: { email: fromEmail, name: 'NigerianEmbassy — Jordan & Iraq' }, subject, html });
      return true;
    } catch (err) {
      this.logger.error(`Email failed to ${to}: ${err.message}`);
      return false;
    }
  }
}

@Module({ providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
