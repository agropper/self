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

✅ **Production Ready**
- Tested with real Cloudant and DigitalOcean APIs
- Session management with Cloudant
- Error handling and validation

### Configuration

`.env`:
```
PASSKEY_RPID=user.agropper.xyz
PASSKEY_ORIGIN=http://localhost:3001

CLOUDANT_URL=https://...
CLOUDANT_USERNAME=...
CLOUDANT_PASSWORD=...

DIGITALOCEAN_TOKEN=...
DO_REGION=tor1

PORT=3001
SESSION_SECRET=change-this-in-production
NODE_ENV=development
```

## Next Steps

- [ ] Add chat interface
- [ ] Add KB management
- [ ] Add agent configuration
- [ ] Deploy to DigitalOcean App Platform

## Status

🚧 In Progress - MVP backend and frontend complete
