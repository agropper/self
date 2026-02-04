## Wizard: End-to-End Behavior (Current)

This document describes the current Setup Wizard behavior as implemented in
`src/components/ChatInterface.vue` and backed by `NEW-AGENT.txt`.

---

## Entry Points and Visibility Rules

- The Wizard is shown inside the Chat UI when:
  - the user is authenticated,
  - the account is not an admin account, and
  - rehydration is not actively suppressing the wizard.
- Admin users are routed to `/admin` and never see the Wizard.

---

## Wizard Pages (Slides)

- **Page 1**: live wizard UI with files box and status lines.
  - Header and intro copy are read from `NEW-AGENT.txt` (section `## Private AI Setup Wizard`).
- **Pages 2–4**: static PNGs served from `public/wizard-slides/slide-2.png`, `slide-3.png`, `slide-4.png`.
- Page navigation:
  - dots at the footer, plus inline dots attached to the last bullet on Page 1.

---

## Page 1: Core Flow

### Stage 1 — Agent Deployment
**Purpose:** ensure a private agent is provisioned.

**Signals:**
- `GET /api/user-status` → `agentReady`
- status line shown until the agent is ready.

### Stage 2 — Files to be indexed (KB build)
**Purpose:** choose files, move into KB folder, and index.

**Flow:**
- Files are listed from `/api/user-files?source=wizard` (server-canonical).
- “Add a file” uploads to root → persisted in user doc.
- Checking a file toggles KB membership via `/api/toggle-file-knowledge-base`.
- “No more files to add – Index now” starts indexing via `/api/update-knowledge-base`.

**Indexing status:**
- Derived from server-canonical `kbIndexingStatus` persisted in the user doc.
- Status line shows elapsed time + files/tokens; remains after completion.

### Stage 3 — Current Medications
**Purpose:** extract and verify current medications when an Apple Health export exists.

**Signals and actions:**
- If no Apple Health file is present, the stage is skipped.
- If present, “Create and Verify your Current Medications” launches Lists processing.
- Verification state is tracked in the user doc and reflected in the wizard status lines.

### Stage 4 — Patient Summary
**Purpose:** generate and verify the patient summary after KB indexing.

**Signals and actions:**
- “Create and Verify your Patient Summary” generates and opens the summary.
- Verification is explicit; generation alone does not mark verified.

---

## Local State and Storage Keys

### LocalStorage
- `wizard-completion-<userId>`
  - JSON: `{ stage3Complete: boolean }` (legacy guard)
- `wizardKbPendingFileName-<userId>`
  - pending KB file name for auto-check in Stage 2

### SessionStorage
- `wizardStage2NoDevice-<userId>`
  - flags Apple Health not present (skip Stage 3)

### IndexedDB (PouchDB)
Local snapshot behavior remains the same; see `Documents/POUCHDB.md`.

---

## API Endpoints Used

- `GET /api/user-status`
- `GET /api/user-files`
- `POST /api/user-file-metadata`
- `POST /api/toggle-file-knowledge-base`
- `POST /api/update-knowledge-base`
- `GET /api/patient-summary`
- `POST /api/generate-patient-summary`
- `POST /api/files/lists/process-initial-file`

---

## Notes

- KB attachment is automatic once both agent readiness and indexing completion are true.
- KB indexing status is server-canonical (`userDoc.kbIndexingStatus`).
