// prisma/seed.ts — Seeds initial embassy staff accounts
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create admin staff account
  const adminHash = await bcrypt.hash('Admin@Embassy2026!', 12);
  await prisma.embassyStaff.upsert({
    where: { email: 'admin@nigerianembassy-jo.gov.ng' },
    update: {},
    create: {
      email: 'admin@nigerianembassy-jo.gov.ng',
      name: 'Embassy Administrator',
      role: 'admin',
      passwordHash: adminHash,
      isActive: true,
    },
  });

  // Duty officer - Jordan
  const officerHash = await bcrypt.hash('Officer@Embassy2026!', 12);
  await prisma.embassyStaff.upsert({
    where: { email: 'duty.jordan@nigerianembassy-jo.gov.ng' },
    update: {},
    create: {
      email: 'duty.jordan@nigerianembassy-jo.gov.ng',
      name: 'Duty Officer - Jordan',
      role: 'duty_officer',
      passwordHash: officerHash,
      country: 'jordan',
      isActive: true,
    },
  });

  // Duty officer - Iraq
  await prisma.embassyStaff.upsert({
    where: { email: 'duty.iraq@nigerianembassy-jo.gov.ng' },
    update: {},
    create: {
      email: 'duty.iraq@nigerianembassy-jo.gov.ng',
      name: 'Duty Officer - Iraq',
      role: 'duty_officer',
      passwordHash: officerHash,
      country: 'iraq',
      isActive: true,
    },
  });

  // Consular officer
  await prisma.embassyStaff.upsert({
    where: { email: 'consular@nigerianembassy-jo.gov.ng' },
    update: {},
    create: {
      email: 'consular@nigerianembassy-jo.gov.ng',
      name: 'Consular Officer',
      role: 'consular_officer',
      passwordHash: officerHash,
      isActive: true,
    },
  });

  // Sample news items
  await prisma.newsItem.createMany({
    skipDuplicates: true,
    data: [
      {
        id: 'news-001',
        title: 'Welcome to NigerianEmbassy App',
        body: 'The Nigerian Embassy, Amman is pleased to launch the NigerianEmbassy mobile app — your gateway to consular services in Jordan and Iraq. You can now apply for passport renewal, track applications, and reach us in an emergency — all from your phone.',
        category: 'announcement',
        country: 'both',
        priority: 'high',
        publishedById: 'system',
        isActive: true,
      },
      {
        id: 'news-002',
        title: 'Embassy Office Hours — Ramadan Schedule',
        body: 'During the Holy Month of Ramadan, the Nigerian Embassy, Amman will operate from 9:00 AM to 1:00 PM, Monday to Thursday. Friday services will be suspended. Normal hours resume after Eid al-Fitr.',
        category: 'office_closure',
        country: 'both',
        priority: 'normal',
        publishedById: 'system',
        isActive: true,
      },
      {
        id: 'news-003',
        title: 'Security Advisory — Travel in Northern Iraq',
        body: 'Nigerian citizens are advised to exercise heightened caution when travelling to northern Iraq provinces, particularly areas near the Syrian border. Please register your travel with the embassy and maintain regular contact with your next of kin.',
        category: 'security_alert',
        country: 'iraq',
        priority: 'urgent',
        publishedById: 'system',
        isActive: true,
      },
    ],
  });

  console.log('Seeding complete!');
  console.log('Staff accounts created:');
  console.log('  admin@nigerianembassy-jo.gov.ng / Admin@Embassy2026!');
  console.log('  duty.jordan@nigerianembassy-jo.gov.ng / Officer@Embassy2026!');
  console.log('  duty.iraq@nigerianembassy-jo.gov.ng / Officer@Embassy2026!');
  console.log('  consular@nigerianembassy-jo.gov.ng / Officer@Embassy2026!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
