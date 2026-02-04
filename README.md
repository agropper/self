# MAIA User Portal

## Top 20 User Features

1. **Get Started** simple, passwordless entry for new users with self-provisioning wizard.
2. **Passkey registration** optional to create web-accessible account.
3. **Local only/no‑passkey or password mode** for private devices.
4. **Sign Out** with optional local snapshot for deleted account restoration.
5. **Setup Wizard** with multi‑page guidance and feature review.
6. **My Stuff** dialog for private AI agent instruction, document and privacy management.
7. **Saved Files** list with KB inclusion checkboxes.
8. **Saved Files** indexing status and KB summary.
9. **Upload file** from paperclip / file picker.
10. **PDF Viewer** modal with paging.
11. **Text/Markdown Viewer** with page links for source confirmation.
12. **My Lists** linked to PDF source pages.
13. **Create Categorized Lists** from Apple Health file.
14. **AI-assisted Current Medications** patient-reconciled and verified.
15. **Generate Patient Summary** with editing and verification.
16. **Switch AI provider** dropdown (Private AI + public models).
17. **Saved Chats** to local computer and as ddep links.
18. **Open deep link** as guest (isolated view).
19. **Privacy Filtering** substitutes all names in a chat for pseudonimity.
20. **Admin Account** and user management page.
---

## Key User Account Provisioning Steps

1. **Passkey registration** creates the user document and session.
2. **Agent provisioning** (admin-triggered or auto in some flows):
   - Creates agent, waits for deployment, stores endpoint + API key.
3. **File import**:
   - Uploads land in root, metadata stored in Cloudant.
4. **KB build and indexing**:
   - Files are moved into `userId/<kbName>/`.
   - Indexing starts on the folder datasource.
   - Polling persists status to `userDoc.kbIndexingStatus`.
5. **KB attachment**:
   - Automatically attaches when agent is ready and indexing is complete.
6. **Current Medications / Patient Summary**:
   - Generated and verified through My Lists and Patient Summary flows.

---

## Hosting Configuration Notes (Key Env Vars)

### Passkeys / WebAuthn
- `PASSKEY_RPID`  
  Domain scope for credentials (use apex domain to cover subdomains).
- `PASSKEY_ORIGIN`  
  Single allowed origin for WebAuthn verification.
- `PASSKEY_ORIGINS`  
  Optional comma-separated allowlist for multiple origins.

### Cloudant (users, sessions, audit log)
- `CLOUDANT_URL`, `CLOUDANT_USERNAME`, `CLOUDANT_PASSWORD`  
  Required for user docs, sessions, and audit logs.

### DigitalOcean GenAI (agents, KBs, indexing)
- `DIGITALOCEAN_TOKEN`  
  Auth for DO GenAI REST API.
- `DO_REGION`, `DO_PROJECT_ID`  
  Required to create agents and KBs.
- `DO_DATABASE_ID`  
  DO database ID used when creating KBs.
- `DO_EMBEDDING_MODEL_ID` (optional)  
  Overrides default embedding model.

### DigitalOcean Spaces (file storage)
- `DIGITALOCEAN_BUCKET`  
  Bucket name or URL for user files.
- `DIGITALOCEAN_AWS_ACCESS_KEY_ID`, `DIGITALOCEAN_AWS_SECRET_ACCESS_KEY`, `DIGITALOCEAN_ENDPOINT_URL`  
  S3-compatible access to Spaces.

### OpenSearch (optional, clinical notes)
- `OPENSEARCH_ENDPOINT`, `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD`  
  Enables clinical notes indexing/search.

### App + Email
- `PUBLIC_APP_URL`  
  Canonical app URL for links.
- `PORT`  
  Server listen port.

---

## Hosting Environment

- **App Platform**: Runs the frontend + Node server.
- **Droplet with Dockerized CouchDB**: Cloudant-compatible data store for users, chats, sessions, and audit log.
- **GenAI Agent**: DigitalOcean Private AI agent per user.
- **Knowledge Base**: DigitalOcean KB per user, indexed from the Spaces folder datasource.
- **OpenSearch 2 Database**: Clinical notes indexing/search store.
- **Spaces File Store**: S3-compatible storage for all user files and lists.

---

## Local Development

```bash
npm install
cp .env.example .env
npm run dev       # Vite (frontend)
npm run start     # Node (backend)
```

Health check:

```bash
curl http://localhost:3001/health
```
