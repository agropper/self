## Review: Temporary User Flow (Get Started → Work → Sign Out)

### Baseline Behavior (Current Requirement)

#### On Sign-Out of a temporary user

- Create a local IndexedDB database for the user (PouchDB snapshot).
- Console: `[LOCAL] Snapshot saved for <userId>`
- Destroy the knowledge base (privacy).
- Terminal: `[LOCAL] KB deleted for <userId>`
- Delete the user’s Spaces folder (privacy).
- Terminal: `[LOCAL] Spaces folder deleted for <userId>`
- Delete user documents in CouchDB (privacy).
- Terminal: `[LOCAL] CouchDB docs deleted for <userId>`
- Store the userId in localStorage for discovery on next visit.
- Console: `[LOCAL] Stored local backup userId: <userId>`
- Clear the temporary user cookie.
- Terminal: `[LOCAL] Temporary cookie cleared for <userId>`

#### On Get Started

- Check localStorage for a previous userId.
- Console: `[LOCAL] Found local backup userId: <userId>`
- If found, check for an existing agent whose name starts with that userId.
- Console: `[LOCAL] Agent lookup for <userId>: <found|missing>`
- If the agent matches:
  - Do not start the wizard.
  - Console: `[LOCAL] Wizard suppressed for rehydration`
  - Rehydrate all files into Spaces by prompting for each file
    (this becomes a new Saved Files feature).
    - Console: `[LOCAL] Rehydration started for <count> file(s)`
  - After rehydration, show the wizard if Stage 4 is incomplete.
  - Console: `[LOCAL] Rehydration complete; wizard re-evaluated`
- If localStorage has a userId but the agent is missing:
  - Show a modal with two options:
    - **Clear Local Storage**
    - **Start the Wizard Again** (create a new agent)
  - Console: `[LOCAL] Missing agent prompt shown for <userId>`

### Cookie behavior (local identity)

- When a new temporary user clicks **Get Started**, the frontend calls `POST /api/temporary/start`.
- The server sets the `maia_temp_user` cookie (90‑day max age) with the generated `userId`.
- On subsequent visits, `/api/temporary/start` will reuse that cookie to revive the same temp user if it still exists.
- On **sign out**, the server clears the temporary cookie (and the deep link cookie if present).

### CouchDB provisioning and app connection

- The droplet runs CouchDB/Cloudant for server persistence.
- The app connects to CouchDB via the backend (Cloudant client); the browser never talks to CouchDB directly.
- User state is stored in `maia_users`. Saved chats are stored in `maia_chats`. Sessions are stored in `maia_sessions`.
- For temporary users, the `maia_users` doc includes `temporaryAccount: true`.

### Spaces usage

- Spaces is the primary storage for uploaded files (Saved Files).
- The knowledge base is created from Spaces object paths and indexed in DigitalOcean.
- When a user goes dormant, only the KB is deleted; Spaces objects are not deleted by this flow.

### PouchDB usage (local backup)

- A local DB `maia-user-${userId}` is created in IndexedDB.
- On **sign out** (live or dormant), the app saves a `user_snapshot` document containing:
  - user profile
  - Saved Files metadata
  - saved chats
  - current chat draft/state
- The snapshot also stores the last snapshot user ID in `localStorage` for discovery.

### Cookie after sign out

- `maia_temp_user` is cleared on sign out.
- If the user returns and clicks **Get Started** again, a *new* temporary account is created.

### What can be destroyed if there are no other users

- **Knowledge Base** (always safe to delete when dormant).
- **Spaces objects** (optional; only if the user has local backups of all files).
- **CouchDB container** (optional; only if you intend to rely entirely on local backups and re‑uploads).
- **Private AI agent** does not need to be deleted (token‑billed).

### Rehydrate after sign out

1) User clicks **Get Started** → new temporary account created.
2) App detects a local snapshot and prompts to restore.
3) If restore is accepted:
   - saved chats are re‑saved to the server
   - current chat state is restored to the UI
4) Files must be re‑uploaded from local disk if Spaces was wiped.
5) KB is re‑indexed on demand when the user requests Private AI features.

## Goal

Make **dormant accounts the default** by adding a local PouchDB backup for each user.
When a user signs out, they can choose to keep their server resources live or go dormant.
Dormant mode deletes the expensive cloud resource (KB) and keeps only a local snapshot
that can be rehydrated later. The Private AI agent does not need to be deleted since it
is billed by token usage.

We will use **filtered replication** (single shared CouchDB/Cloudant DB) for simplicity.

## Core Principles

- **Dormant-first UX**: default to saving a local snapshot and tearing down cloud resources.
- **Simple flow**: keep the UI as close to current behavior as possible.
- **Scoped sync**: only replicate documents for the authenticated `userId`.
- **No deep link users**: dormant mode is blocked if the user has active deep links.
- **Source of truth**: Cloudant/CouchDB remains the server source of truth while live.

## Why PouchDB

The **only** reason to introduce PouchDB is to support dormant accounts as the default
without losing user state. PouchDB acts as a local backup that can quickly restore:

- user profile and preferences
- file metadata and Saved Files state
- lists and patient summary data
- chat history snapshots (if desired)

## Dormant Account Flow

### Sign Out

If the user has active deep links:

- Offer a choice:
  - **Keep server live** (do nothing, preserve KB + agent)
  - **Go dormant** (disable deep links, export, and deallocate resources)

If no active deep links:

- Default to **Go dormant**.

### Go Dormant (Server)

1) Server exports user-scoped documents via filtered replication.
2) Server deletes / deallocates:
   - Knowledge base
3) Server marks account as dormant (in user doc).

### Reactivate

1) User signs in and local snapshot is detected.
2) App restores user state from PouchDB.
3) User triggers KB re-indexing and agent deployment (or waits for auto-provision).

## What Can Run Without KB + Agent

Some parts of the app should work without a live Private AI:

- Saved Files list and file management
- Lists tab (if derived from stored data)
- Patient summary viewing/editing
- Chat history viewing (if cached locally)
 - Current chat draft and local chat state

If the user wants Private AI features:

- Start KB indexing and agent deployment on demand.

## Filtered Replication Design

### Server-Side

- Use a shared DB (e.g., `maia_users`).
- Expose a replication endpoint with a filter:
  - only `doc.userId === session.userId`
  - and/or `doc._id === session.userId`
- Never accept `userId` from the client for replication.

### Client-Side

- Create a local DB per user:
  - `maia-user-${userId}`
- Start replication after authentication.
- Stop replication and close DB on sign out.

## PWA Consideration

A PWA is **optional**, not required.

Pros:

- Better offline behavior
- App-like install, consistent local storage
- Background sync potential

Cons:

- Additional complexity (service worker, caching strategy, updates)
- Risk of stale UI if not careful

Recommendation:

- Start without PWA.
- Add PWA only if offline usage becomes a primary requirement.

## Data Model Requirements

To make filtered replication safe:

- Every user-scoped doc must include:
  - `userId`
  - `type`
- Avoid cross-user data in any user-scoped doc.

## Implementation Phases

### Phase 1: Local Snapshot

- Add PouchDB to frontend.
- Create a local DB per user.
- Store key user data after login.
- Read-through cache for Saved Files and MyStuff.

### Phase 2: Filtered Replication

- Add server replication endpoint.
- Implement filtered replication scoped to session user.
- Sync on login; stop on logout.

### Phase 3: Dormant Default

- Add sign-out flow:
  - If deep links active: prompt live vs dormant.
  - If none: default dormant.
- Deallocate KB on dormancy (keep agent).
- Reactivation flow from local snapshot.

## Open Questions

- How to detect and revoke active deep links on dormancy?
- Which data should be cached locally by default (chat history + current chat)?
- How to handle conflicts if local snapshot is old?

## Disaster Recovery Note

If the entire server is destroyed (CouchDB container and Spaces), a user can recreate
their account provided they have local backups of their files and a PouchDB snapshot.
The app should support rehydration by re-uploading files and re-indexing a new KB.

## Minimal Implementation Checklist

- [ ] Add `pouchdb` to frontend dependencies.
- [ ] Create `src/utils/localDb.ts` helper.
- [ ] Save and read userDoc from PouchDB.
- [ ] Add a feature flag to enable/disable local cache.
- [ ] Implement server-side filtered replication endpoint.
- [ ] Add replication start/stop hooks on login/logout.

