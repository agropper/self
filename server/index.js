/**
 * maia-cloud-user-app server
 * User app backend with passkey authentication
 */

import express from 'express';
import dotenv from 'dotenv';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import { CloudantClient, CloudantSessionStore, AuditLogService } from '../lib/cloudant/index.js';
import { DigitalOceanClient } from '../lib/do-client/index.js';
import { PasskeyService } from '../lib/passkey/index.js';
import { EmailService } from './utils/email-service.js';
import setupAuthRoutes from './routes/auth.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize clients
const cloudant = new CloudantClient({
  url: process.env.CLOUDANT_URL,
  username: process.env.CLOUDANT_USERNAME,
  password: process.env.CLOUDANT_PASSWORD
});

// Initialize databases
(async () => {
  try {
    await cloudant.createDatabase('maia_sessions');
    console.log('✅ Created maia_sessions database');
  } catch (error) {
    // Already exists, that's fine
  }
  try {
    await cloudant.createDatabase('maia_users');
    console.log('✅ Created maia_users database');
  } catch (error) {
    // Already exists, that's fine
  }
  try {
    await cloudant.createDatabase('maia_audit_log');
    console.log('✅ Created maia_audit_log database');
  } catch (error) {
    // Already exists, that's fine
  }
})();

const auditLog = new AuditLogService(cloudant, 'maia_audit_log');

const emailService = new EmailService({
  apiKey: process.env.RESEND_API_KEY,
  fromEmail: process.env.RESEND_FROM_EMAIL,
  adminEmail: process.env.RESEND_ADMIN_EMAIL,
  baseUrl: process.env.PUBLIC_APP_URL || `http://localhost:${PORT}`
});

const doClient = new DigitalOceanClient(process.env.DIGITALOCEAN_TOKEN, {
  region: process.env.DO_REGION || 'tor1'
});

const passkeyService = new PasskeyService({
  rpID: process.env.PASSKEY_RPID || 'user.agropper.xyz',
  origin: process.env.PASSKEY_ORIGIN || `http://localhost:${PORT}`
});

// Middleware
app.use(cors({
  origin: 'http://localhost:5173',
  credentials: true
}));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  },
  store: new CloudantSessionStore({
    cloudantClient: cloudant,
    dbName: 'maia_sessions'
  })
}));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'maia-cloud-user-app' });
});

// Passkey routes
setupAuthRoutes(app, passkeyService, cloudant, doClient, auditLog, emailService);

// Serve static files from dist in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`User app server running on port ${PORT}`);
  console.log(`Passkey rpID: ${passkeyService.rpID}`);
  console.log(`Passkey origin: ${passkeyService.origin}`);
});

export default app;

