# maia-cloud-user-app

Authenticated User app for MAIA (Medical AI Assistant) - `user.agropper.xyz`

## Purpose

Simplified, maintainable user-facing app with passkey authentication, chat interface, agent management, and knowledge base operations.

## Local Development

### Prerequisites

- Node.js 18+ 
- npm
- Cloudant credentials
- DigitalOcean API token (optional for basic testing)
- Resend API key (for registration email notifications)

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/agropper/maia-cloud-user-app.git
   cd maia-cloud-user-app
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

4. **Copy libraries** (until we publish npm packages)
   ```bash
   # Libraries need to be in ../lib-maia-do-client, ../lib-maia-cloudant, ../lib-maia-passkey
   # Or copy them to ./lib/ manually
   ```

### Running Locally

**Terminal 1: Start backend**
```bash
npm run start
# Server runs on http://localhost:3001
```

**Terminal 2: Start frontend dev server**
```bash
npm run dev
# Frontend runs on http://localhost:5173
```

**Open in browser:**
```
http://localhost:5173
```

### Testing

1. **Test backend APIs**
   ```bash
   node test-backend.js      # Tests Cloudant, Passkey, DO clients
   node test-do-integration.js  # Tests DigitalOcean integration
   ```

2. **Health check**
   ```bash
   curl http://localhost:3001/health
   ```

3. **Test authentication**
   - Open http://localhost:5173
   - Click "Get Started"
   - Click "Create New Passkey"
   - Enter a User ID
   - Complete passkey registration

### Features

✅ **Passkey Authentication**
- Secure WebAuthn registration and login
- No passwords needed
- Browser-native security

✅ **Clean Architecture**
- 3 extracted libraries: DO client, Cloudant, Passkey
- < 2,000 lines of code total
- No legacy complexity or debug messages

✅ **Registration Email Notifications**
- Automatic admin notification when new users register
- Provisioning deep link with secure token for user setup
- Email sent via Resend API service
- Graceful fallback if email service is not configured

✅ **Chat Interface with Streaming**
- Real-time streaming chat responses with incremental updates
- Multiple AI providers (Anthropic Claude 4.5 supported)
- Clean, full-width interface with anchored bottom toolbar
- File attachments support for PDFs and text files

✅ **File Management**
- PDF upload with text extraction via pdf-parse
- Binary storage in DigitalOcean Spaces
- PDF viewer modal with pagination and zoom controls
- Text files automatically added to chat context
- Selectable text layer in PDF viewer

✅ **Production Ready**
- Tested with real Cloudant and DigitalOcean APIs
- Session management with Cloudant (sessions stored by userId for easy viewing)
- Security audit logging for authentication events
- Error handling and validation

### Configuration

`.env`:
```
# Passkey Configuration (local development)
PASSKEY_RPID=localhost
PASSKEY_ORIGIN=http://localhost:5173

# Passkey Configuration (production)
# PASSKEY_RPID=user.agropper.xyz
# PASSKEY_ORIGIN=https://user.agropper.xyz

# Cloudant Database
CLOUDANT_URL=https://your-instance.cloudantnosqldb.appdomain.cloud
CLOUDANT_USERNAME=apikey-v2-...
CLOUDANT_PASSWORD=your-api-key

# DigitalOcean API
DIGITALOCEAN_TOKEN=dop_v1_...
DO_REGION=tor1

# Server Configuration
PORT=3001
SESSION_SECRET=change-this-in-production
NODE_ENV=development
PUBLIC_APP_URL=http://localhost:3001

# Email Service (Resend) - for admin notifications
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=noreply@yourdomain.com
RESEND_ADMIN_EMAIL=admin@yourdomain.com

# File Upload (DigitalOcean Spaces)
DIGITALOCEAN_BUCKET=https://maia.tor1.digitaloceanspaces.com
DIGITALOCEAN_AWS_ACCESS_KEY_ID=...
DIGITALOCEAN_AWS_SECRET_ACCESS_KEY=...

# Anthropic AI (for chat)
ANTHROPIC_API_KEY=sk-ant-...
```

**Note**: The server automatically creates `maia_sessions`, `maia_users`, and `maia_audit_log` databases on startup if they don't exist.

## Architecture

### Session Management
- Sessions stored in Cloudant with `userId` as document `_id` for easy viewing in dashboard
- Session mapping documents maintain express-session compatibility
- Automatic session expiration and cleanup

### Security Audit Log
- All authentication events logged to `maia_audit_log` database
- Event types: `login_success`, `login_failure`, `logout`, `passkey_registered`
- Each log includes: userId, timestamp, IP address, user agent
- Queryable in Cloudant dashboard for security audits

### Email Notifications
- When a new user registers with passkey, an email notification is sent to the admin
- Email contains user info and a secure provisioning deep link
- Provisioning token is stored in the user document for secure access
- Email service uses Resend API with graceful fallback if not configured
- Admin can click the deep link to provision the user (create agent, Spaces folder, etc.)

### File Upload Architecture
- Files uploaded as binary data to DigitalOcean Spaces
- PDFs parsed on server using pdf-parse library
- File metadata stored in user documents (`maia_users` database) in `files` array
- Signed URLs generated for secure file access (7-day expiration)
- PDF viewer uses @tato30/vue-pdf with pdfjs-dist for rendering
- Selectable text layer enabled for PDF extraction
- Files support KB tracking via `knowledgeBases` array

### Libraries Used
- `lib-maia-do-client`: DigitalOcean GenAI API client
- `lib-maia-cloudant`: Cloudant document operations and session store
- `lib-maia-passkey`: WebAuthn/passkey authentication service
- `lib-maia-chat`: Unified chat interface with streaming support
- `pdf-parse`: PDF text extraction on server
- `@tato30/vue-pdf`: PDF viewer component
- `pdfjs-dist`: PDF.js for PDF rendering and text layer

## Next Steps

- [ ] Add more AI providers (OpenAI, Gemini, DeepSeek)
- [ ] Add KB management UI
- [ ] Add agent configuration
- [ ] Implement knowledge base integration with chat
- [ ] Deploy to DigitalOcean App Platform

## Status

✅ **MVP Complete** - Passkey authentication, chat with streaming, and file uploads working
