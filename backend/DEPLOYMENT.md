# NigerianEmbassy Backend — Deployment Guide
## Deploy to Railway (Free Tier) in ~15 minutes

---

## Prerequisites
- GitHub account
- Railway account (railway.app — free signup, no credit card needed for trial)
- The backend folder from the NigerianEmbassy project

---

## Step 1 — Push backend to GitHub

```bash
cd ~/Desktop/NigerianEmbassy/backend

git init
git add .
git commit -m "Initial NigerianEmbassy backend"

# Create a new repo on github.com called "nigerian-embassy-api"
# Then:
git remote add origin https://github.com/YOUR_USERNAME/nigerian-embassy-api.git
git push -u origin main
```

---

## Step 2 — Create Railway project

1. Go to **railway.app** and sign in with GitHub
2. Click **New Project**
3. Select **Deploy from GitHub repo**
4. Choose your `nigerian-embassy-api` repo
5. Railway will detect it as a Node.js project and start building

---

## Step 3 — Add PostgreSQL database

1. In your Railway project, click **New Service**
2. Select **Database → PostgreSQL**
3. Railway creates the database and gives you a `DATABASE_URL`
4. Click on the PostgreSQL service → **Variables** → copy `DATABASE_URL`

---

## Step 4 — Set environment variables

In your Railway **API service** → **Variables**, add these one by one:

### Required (app won't start without these)
```
NODE_ENV=production
DATABASE_URL=<paste from PostgreSQL service above>
JWT_SECRET=<generate: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
JWT_REFRESH_SECRET=<generate another one>
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d
```

### For SMS distress alerts (Twilio — free trial at twilio.com)
```
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_FROM_NUMBER=+1xxxxxxxxxx
DUTY_OFFICER_JORDAN=+962777770001
DUTY_OFFICER_IRAQ=+962777770002
```

### For AI chatbot (Anthropic — console.anthropic.com)
```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
```

### For push notifications (Firebase — console.firebase.google.com)
```
FIREBASE_PROJECT_ID=nigerian-embassy-app
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

### For email (SendGrid — sendgrid.com, free: 100/day)
```
SENDGRID_API_KEY=SG.xxxxxxxx
SENDGRID_FROM_EMAIL=noreply@nigerianembassy-jo.gov.ng
```

### For currency & weather (both free tier)
```
OPEN_EXCHANGE_RATES_APP_ID=xxxxxxxx
OPENWEATHER_API_KEY=xxxxxxxx
```

---

## Step 5 — Run database migrations

Railway runs migrations automatically via `railway.toml`:
```
npm run db:migrate && node dist/main
```

But to seed the initial staff accounts, open Railway's terminal:
```bash
npx ts-node prisma/seed.ts
```

Or locally (with DATABASE_URL set):
```bash
DATABASE_URL="your-railway-db-url" npm run db:seed
```

---

## Step 6 — Get your API URL

Railway gives you a public URL like:
```
https://nigerian-embassy-api-production.up.railway.app
```

Test it:
```
https://your-url.up.railway.app/api/v1/health
```

Should return:
```json
{ "status": "ok", "service": "NigerianEmbassy API" }
```

---

## Step 7 — Connect mobile app to backend

On your Mac, update the mobile app's API URL.
Open `src/services/api.ts` and change:

```typescript
const api: AxiosInstance = axios.create({
  baseURL: __DEV__
    ? 'http://localhost:3000/api/v1'          // local dev
    : 'https://YOUR-RAILWAY-URL.up.railway.app/api/v1',  // production
```

Then restart Expo:
```bash
npx expo start --clear
```

Now **Sign In** and **Create Account** will work with real data!

---

## Step 8 — Seed staff accounts (initial login credentials)

After seeding, embassy staff can log in to the admin panel with:

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@nigerianembassy-jo.gov.ng | Admin@Embassy2026! |
| Duty Officer (Jordan) | duty.jordan@nigerianembassy-jo.gov.ng | Officer@Embassy2026! |
| Duty Officer (Iraq) | duty.iraq@nigerianembassy-jo.gov.ng | Officer@Embassy2026! |
| Consular Officer | consular@nigerianembassy-jo.gov.ng | Officer@Embassy2026! |

**⚠️ Change all passwords immediately after first login in production!**

---

## Local development (optional)

To run the backend locally alongside the app:

```bash
cd backend

# Install PostgreSQL locally or use a free cloud DB (supabase.com)
cp .env.example .env
# Edit .env with your values

npm install
npm run db:generate
npm run db:migrate:dev
npm run db:seed
npm run start:dev
```

Backend runs at: `http://localhost:3000`
Swagger docs at: `http://localhost:3000/api/docs`

---

## API Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/v1/auth/login | Citizen login |
| POST | /api/v1/auth/register | Citizen registration |
| POST | /api/v1/auth/refresh | Refresh JWT token |
| GET | /api/v1/auth/profile | Get citizen profile |
| PATCH | /api/v1/auth/profile | Update profile |
| POST | /api/v1/auth/pin/change | Change PIN |
| POST | /api/v1/auth/logout | Logout |
| GET | /api/v1/applications | Get all applications |
| POST | /api/v1/applications | Submit application |
| GET | /api/v1/applications/:id | Get single application |
| POST | /api/v1/appointments | Book appointment |
| GET | /api/v1/appointments | Get appointments |
| PATCH | /api/v1/appointments/:id | Update appointment |
| POST | /api/v1/distress/alert | Send distress alert |
| GET | /api/v1/distress/active | Active alerts (staff) |
| POST | /api/v1/support/chat | AI chatbot |
| POST | /api/v1/support/tickets | Create support ticket |
| GET | /api/v1/support/tickets | Get tickets |
| GET | /api/v1/news | Get news & alerts |
| GET | /api/v1/tourism/rates | Currency rates |
| GET | /api/v1/tourism/weather | Weather data |
| GET | /api/v1/health | Health check |

Full interactive docs at: `https://your-url/api/docs`
