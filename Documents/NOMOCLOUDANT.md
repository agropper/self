# NOMOCLOUDANT

## Summary

We are moving CouchDB to a small DigitalOcean Droplet because this is a single‑user,
low‑usage app and a managed database would add ~$12/month with no real benefit. A
Droplet keeps the CouchDB API and reduces cost while the added ops burden is acceptable
for this usage pattern.

We are making the Spaces bucket ephemeral because DO GenAI Knowledge Bases only accept
`spaces_data_source` (bucket name + region), not a custom S3 endpoint. Therefore the
bucket must exist for KB indexing, but it does not need to be persistent. The plan is
to keep files on the Droplet and copy them to Spaces only during indexing, then delete
them to avoid month‑long storage charges.

## Goals

- Reduce monthly cost while keeping OpenSearch + App Platform online.
- Preserve current app behavior with minimal disruption.
- Keep the user in control of files and storage (visible local folder).
- Make KB indexing work with DO’s Spaces‑only datasource requirement.
- Ensure deep‑link viewers can open source PDFs via durable links.
- Make it explicit which file(s) seeded the current My Stuff Index.

## Non‑goals

- Multi‑user or high‑availability scaling.
- Eliminating OpenSearch or DO GenAI KB entirely.

## Target architecture (high level)

- **App Platform app**: unchanged; remains public entrypoint and API.
- **Droplet**: runs CouchDB and MinIO for local file storage.
- **OpenSearch**: stays managed and persistent.
- **Spaces**: used only as a temporary KB datasource during indexing.

## Local file control UX

- First‑time prompt: create/select local folder `{AG} Medical Records`.
- Auto‑create subfolders that mirror current bucket structure:
  - `{root}/{userId}/`
  - `{root}/{userId}/archived/`
  - `{root}/{userId}/{kbName}/`
  - `{root}/{userId}/index/` (index source + manifests)
- Store the chosen root path and never prompt again unless missing.

## Storage layout and naming

- **MinIO bucket**: mirrors Spaces paths for continuity with existing `bucketKey` logic.
- **Index source**:
  - Fixed slot: `{root}/{userId}/index/health-export/`
  - Apple Health Export PDF (if present) stored here.
- **Manifest** (JSON): `{root}/{userId}/index/index-manifest.json`
  - `sourceFiles`: list of file keys used for current index
  - `indexedAt`: timestamp
  - `kbName`, `kbId`, `datasourceUuids`

## Data flow details

### Upload / file management

1. User uploads a file.
2. App writes file to MinIO (local S3‑compatible store).
3. UserDoc stores `bucketKey`‑like path for consistency.

### KB indexing (Spaces bucket on‑demand)

1. User requests “Update and Index KB”.
2. App creates a **temporary Spaces bucket** for this run.
3. App copies file(s) from MinIO to Spaces under `userId/<kbName>/`.
4. App creates/updates KB datasource using `spaces_data_source`.
5. App starts indexing and waits for completion.
6. App deletes objects and the temporary bucket.
7. App keeps local files as the source of truth.

### Page links to original PDFs

- UI uses `bucketKey` + page number to open PDF via proxy endpoint.
- Proxy reads from MinIO (not Spaces) for PDF viewing.
- **Decision:** deep‑link access requires the Droplet to be online.

## Storage choices on Droplet

**Decision: MinIO (S3‑compatible)**
- Minimal app change: reuse existing S3 client with a new endpoint.
- Requires TLS + credentials for MinIO.

## Security + ops (Droplet)

- Enable firewall; only allow HTTPS (and CouchDB admin if needed).
- TLS termination (Caddy/Nginx) for MinIO or file proxy.
- CouchDB admin auth only; no public admin party.
- Log rotation and disk usage alerts (small storage budget).

## Recovery + restore (single‑user, no migration)

- No migration or rollback is required; the self version starts fresh.
- Primary restore source is the user’s local folder (including index manifest).
- **No CouchDB backups during initial rollout.**
- After the self version is stable, add a **local PouchDB replica**:
  - Use CouchDB↔PouchDB sync as the primary backup/restore mechanism.
  - Restore path: re‑provision Droplet → replicate back from local PouchDB → re‑index KB from local files.
- If OpenSearch/KB is missing or inconsistent:
  - Recreate KB and re‑index from local source files.
  - Use the manifest to confirm the current index source file(s).

## Implementation plan (fresh single‑user, no migration)

### Phase 0: Prep (no code changes)
- MinIO selected for local storage.
- Define local folder naming and root path policy.
- Confirm OpenSearch cluster stays persistent.
- Create a new repo for major changes (per decision).

### Phase 1: Infrastructure
- Provision Droplet (1–2 GB RAM).
- Install CouchDB and secure it.
- Install MinIO; configure TLS and credentials.
- Set firewall rules.

### Phase 2: App config & adapters
- Add env vars for MinIO endpoint + credentials and CouchDB host.
- Implement local storage adapter (S3‑compatible for MinIO).
- Update file proxy endpoint to read from MinIO.

### Phase 3: KB indexing workflow
- Implement “create Spaces bucket → copy → index → delete bucket” flow.
- Verify indexing works and that the temporary bucket is removed afterward.

### Phase 4: Local UX + manifest
- Add `{AG} Medical Records` prompt and folder initialization.
- Persist the index manifest and update it on each indexing run.

## Local testing before cloud move

- **App + UI**: run locally with mock data and confirm upload, preview, and page‑link flows.
- **MinIO**: run locally (Docker) and point the S3 client to it; verify upload, list, proxy PDF.
- **CouchDB**: run locally and validate auth/session flows.
- **Indexing flow (dry run)**: exercise “copy to Spaces → index → delete” using a test bucket.

## Current self LOC baseline

- Total lines (non‑node_modules, code + docs): **42,824**
- Core app code (src/server/lib/scripts): **33,276**

## Risks

- Droplet is a single point of failure without backups.
- Spaces creation/deletion failures could stall indexing if not handled cleanly.
