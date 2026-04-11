// ─────────────────────────────────────────────────────────────────────────────
// NigerianEmbassy - Jordan | Iraq  — Backend API
// Notifications Service — Firebase FCM push + SendGrid email
// ─────────────────────────────────────────────────────────────────────────────

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import sgMail from '@sendgrid/mail';
import { PrismaService } from '../common/prisma.service';

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
}

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    // Initialise Firebase Admin SDK
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId:    this.config.get('FIREBASE_PROJECT_ID'),
          clientEmail:  this.config.get('FIREBASE_CLIENT_EMAIL'),
          privateKey:   this.config.get('FIREBASE_PRIVATE_KEY')?.replace(/\\n/g, '\n'),
        }),
      });
    }
    // Initialise SendGrid
    sgMail.setApiKey(this.config.get('SENDGRID_API_KEY') ?? '');
  }

  // ── Send to a single device ────────────────────────────────────────────────
  async sendToDevice(fcmToken: string, payload: PushPayload): Promise<boolean> {
    try {
      await admin.messaging().send({
        token: fcmToken,
        notification: { title: payload.title, body: payload.body, imageUrl: payload.imageUrl },
        data: payload.data,
        android: {
          priority: 'high',
          notification: { channelId: 'default', sound: 'default' },
        },
        apns: {
          payload: { aps: { sound: 'default', badge: 1 } },
        },
      });
      return true;
    } catch (error) {
      this.logger.warn(`FCM send failed for token: ${error.message}`);
      return false;
    }
  }

  // ── Send to a citizen by ID ────────────────────────────────────────────────
  async notifyCitizen(citizenId: string, payload: PushPayload): Promise<boolean> {
    const citizen = await this.prisma.citizen.findUnique({
      where: { id: citizenId },
      select: { fcmToken: true },
    });
    if (!citizen?.fcmToken) return false;
    return this.sendToDevice(citizen.fcmToken, payload);
  }

  // ── Send to all embassy staff ──────────────────────────────────────────────
  async notifyStaff(payload: PushPayload): Promise<void> {
    // In production, staff FCM tokens are stored in EmbassyStaff table
    // Here we use a topic subscription for simplicity
    try {
      await admin.messaging().send({
        topic: 'embassy-staff-alerts',
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
        android: { priority: 'high' },
      });
    } catch (error) {
      this.logger.error(`Staff topic notification failed: ${error.message}`);
    }
  }

  // ── Send application status update ────────────────────────────────────────
  async sendApplicationUpdate(
    citizenId: string,
    referenceNumber: string,
    status: string,
    message: string,
  ): Promise<void> {
    const citizen = await this.prisma.citizen.findUnique({
      where: { id: citizenId },
      select: { fcmToken: true, email: true, firstName: true },
    });
    if (!citizen) return;

    // Push notification
    if (citizen.fcmToken) {
      await this.sendToDevice(citizen.fcmToken, {
        title: `Application Update — ${referenceNumber}`,
        body: message,
        data: { type: 'application_update', referenceNumber, status },
      });
    }

    // Email
    await this.sendEmail({
      to: citizen.email,
      subject: `Application Update: ${referenceNumber} — NigerianEmbassy`,
      html: applicationUpdateEmailTemplate(
        citizen.firstName, referenceNumber, status, message
      ),
    });
  }

  // ── Send appointment reminder ─────────────────────────────────────────────
  async sendAppointmentReminder(
    citizenId: string,
    referenceNumber: string,
    scheduledDate: Date,
    serviceLabel: string,
  ): Promise<void> {
    const citizen = await this.prisma.citizen.findUnique({
      where: { id: citizenId },
      select: { fcmToken: true, email: true, firstName: true },
    });
    if (!citizen) return;

    const dateStr = scheduledDate.toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });

    if (citizen.fcmToken) {
      await this.sendToDevice(citizen.fcmToken, {
        title: 'Appointment Reminder — Tomorrow',
        body: `${serviceLabel} — ${dateStr}`,
        data: { type: 'appointment_reminder', referenceNumber },
      });
    }

    await this.sendEmail({
      to: citizen.email,
      subject: `Appointment Reminder: ${serviceLabel} — NigerianEmbassy`,
      html: appointmentReminderEmailTemplate(
        citizen.firstName, referenceNumber, serviceLabel, dateStr
      ),
    });
  }

  // ── Generic email send ────────────────────────────────────────────────────
  async sendEmail(payload: EmailPayload): Promise<boolean> {
    try {
      await sgMail.send({
        to: payload.to,
        from: {
          email: this.config.get('SENDGRID_FROM_EMAIL') ?? 'noreply@nigerianembassy-jo.gov.ng',
          name: 'NigerianEmbassy — Jordan & Iraq',
        },
        subject: payload.subject,
        html: payload.html,
        text: payload.text ?? payload.html.replace(/<[^>]*>/g, ''),
      });
      return true;
    } catch (error) {
      this.logger.error(`Email send failed to ${payload.to}: ${error.message}`);
      return false;
    }
  }
}

// ── Email templates ───────────────────────────────────────────────────────────

function applicationUpdateEmailTemplate(
  name: string, ref: string, status: string, message: string
): string {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <div style="background:#1A5C38;padding:20px;border-radius:8px 8px 0 0;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:20px;">🇳🇬 NigerianEmbassy</h1>
        <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;">Jordan | Iraq</p>
      </div>
      <div style="background:#f9f9f9;padding:24px;border:1px solid #e2e6ea;border-top:none;border-radius:0 0 8px 8px;">
        <p style="color:#2C2C2A;">Dear <strong>${name}</strong>,</p>
        <p style="color:#2C2C2A;">Your application <strong>${ref}</strong> has been updated:</p>
        <div style="background:#E8F5EE;border-left:4px solid #1A5C38;padding:12px 16px;border-radius:4px;margin:16px 0;">
          <p style="margin:0;font-weight:bold;color:#1A5C38;">Status: ${status}</p>
          <p style="margin:8px 0 0;color:#4A5568;">${message}</p>
        </div>
        <p style="color:#4A5568;font-size:13px;">Log in to the NigerianEmbassy app to view full details and take any required action.</p>
        <hr style="border:none;border-top:1px solid #e2e6ea;margin:20px 0;">
        <p style="color:#8A96A3;font-size:12px;text-align:center;">
          Nigerian Embassy, Amman — Accredited to Jordan and Iraq<br>
          This is an automated message. Please do not reply to this email.
        </p>
      </div>
    </div>
  `;
}

function appointmentReminderEmailTemplate(
  name: string, ref: string, service: string, date: string
): string {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <div style="background:#1A5C38;padding:20px;border-radius:8px 8px 0 0;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:20px;">🇳🇬 NigerianEmbassy</h1>
        <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;">Appointment Reminder</p>
      </div>
      <div style="background:#f9f9f9;padding:24px;border:1px solid #e2e6ea;border-top:none;border-radius:0 0 8px 8px;">
        <p style="color:#2C2C2A;">Dear <strong>${name}</strong>,</p>
        <p style="color:#2C2C2A;">This is a reminder that you have an appointment tomorrow:</p>
        <div style="background:#E8F5EE;border-left:4px solid #1A5C38;padding:12px 16px;border-radius:4px;margin:16px 0;">
          <p style="margin:0;font-weight:bold;color:#1A5C38;">${service}</p>
          <p style="margin:4px 0 0;color:#4A5568;">${date}</p>
          <p style="margin:4px 0 0;color:#4A5568;">Ref: <strong>${ref}</strong></p>
        </div>
        <p style="color:#4A5568;">Location: Nigerian Embassy, 5th Circle, Amman, Jordan</p>
        <p style="color:#4A5568;font-size:13px;">Please bring all original documents. If you need to reschedule, open the NigerianEmbassy app.</p>
      </div>
    </div>
  `;
}
