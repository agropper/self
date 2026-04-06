# Claude Code Project Instructions

## Repository
- **Primary remote:** `origin` = `HIEofOne/self` (all PRs and pushes go here)
- **Upstream fork:** `upstream` = `agropper/self` (do NOT push or create PRs here without explicit permission)
- When creating PRs, always use `--repo HIEofOne/self`

## Branching
- Feature branches: `claude/<short-description>`
- PRs target `main`

## Version Bumping
- A pre-commit hook (`scripts/pre-commit-version-bump.sh`) auto-increments the patch version in `package.json` when `server/` or `src/` files are staged
- Do not manually bump versions unless doing a minor or major release

## Stack
- **Frontend:** Vue 3 (SFC, Composition API), Vite, TypeScript for utilities
- **Backend:** Express.js (ESM), CouchDB/Cloudant, DigitalOcean GenAI agents + Spaces (S3)
- **Auth:** Passkey/WebAuthn with temporary (no-passkey) user fallback
- **Local storage:** File System Access API (primary, Chrome 122+), PouchDB/IndexedDB (fallback)

## Key files
- `server/index.js` — main backend (~9,800 lines)
- `src/App.vue` — main frontend entry, auth, welcome page
- `src/components/ChatInterface.vue` — wizard, chat UI
- `src/components/MyStuffDialog.vue` — saved files management
- `server/routes/auth.js` — passkey auth, agent provisioning
- `server/routes/files.js` — file upload, PDF parsing
- `server/routes/chat.js` — chat providers, deep link resolution

## Environment Variables

The goal is to minimize secrets. Several values are **derived from the DO token** at startup so they don't need separate env vars.

### Production (DO App Platform) — required env vars

| Variable | Purpose |
|---|---|
| `DIGITALOCEAN_TOKEN` | Master secret. Used for DO API calls and to derive CouchDB password, session secret, and admin passphrase. |
| `SPACES_AWS_ACCESS_KEY_ID` | S3-compatible access key for DO Spaces (cannot be derived from DO token). |
| `SPACES_AWS_SECRET_ACCESS_KEY` | S3-compatible secret key for DO Spaces. |
| `OPENSEARCH_URL` | OpenSearch database URL (used to extract the database ID). |
| `PUBLIC_APP_URL` | The public URL of the app (e.g. `https://test.agropper.xyz`). |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude chat provider. |
| Chat provider keys | `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `CHATGPT_API_KEY` — optional, one per provider. |

### Derived from DO token (no env var needed in production)

| Value | Derivation | Fallback env var (local dev only) |
|---|---|---|
| CouchDB password | `HMAC-SHA256(token, 'maia-couchdb-admin')` | `CLOUDANT_PASSWORD` |
| Session secret | `HMAC-SHA256(token, 'maia-session-secret')` | `SESSION_SECRET` |
| Admin passphrase | DO token used directly (pasted once at first admin login, then passkey takes over) | `ADMIN_SECRET` |
| Admin username | Hard-coded to `admin` | `ADMIN_USERNAME` |
| CouchDB username | Hard-coded to `admin` | `CLOUDANT_USERNAME` |
| Port | Defaults to `3001`; DO App Platform sets `PORT` automatically | `PORT` |

### Local development — additional env vars

| Variable | Typical value | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Disables secure cookies, etc. |
| `PUBLIC_APP_URL` | `http://localhost:5173` | Local Vite dev server. |
| `CLOUDANT_URL` | `http://localhost:5984` | Local CouchDB instance. |
| `CLOUDANT_USERNAME` | `admin` | Must match local CouchDB config. |
| `CLOUDANT_PASSWORD` | `adminpass` | Must match local CouchDB config. |

### DO token rotation warning

If the DO token is rotated, the derived CouchDB password changes but the CouchDB droplet still has the old one. Before or after rotating, update the CouchDB admin password:
- Via the CouchDB config API (using the old credentials): `PUT /_node/_local/_config/admins/admin`
- Or via SSH to the droplet

Session secret rotation simply logs out all users (they re-authenticate with passkeys).

## Testing
- No automated test suite currently; test manually via the running app
- Build check: `npx vite build`
