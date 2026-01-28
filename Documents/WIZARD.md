## Wizard: End-to-End Behavior

This document describes the Setup Wizard flow, what each stage does, and how
wizard state is stored, persisted on sign-out, and restored on return.

---

## Entry Points and Visibility Rules

- The Wizard is shown inside the Chat UI when:
  - the user is authenticated, and
  - the account is not an admin account, and
  - a restore/rehydration flow is not actively suppressing the wizard.
- Admin users are routed to `/admin` and never see the Wizard or chat UI.
- During file rehydration (restore flow), the Wizard is suppressed until files
  are re-uploaded and rehydration completes.

---

## Stages and UI Actions

### Stage 1 — Create Private AI Agent
**Purpose:** ensure the user has a private agent in DO.

**When complete:**
- Stage 1 checks off after agent provisioning + polling finishes.
- The agent availability is verified via `/api/user-status` and related polling.

**UI behavior:**
- Buttons are disabled while Stage 1 is incomplete.
- If provisioning times out, the Wizard remains visible with an error state.

---

### Stage 2 — Add Apple Health “Export PDF”
**Purpose:** establish the initial file used for Lists and Current Medications.

**Actions:**
- **OK** → opens file chooser and sets:
  - `sessionStorage.autoProcessInitialFile = "true"`
  - `sessionStorage.wizardMyListsAuto = "true"`
  - opens **My Lists** tab after selection.

**When complete:**
- Stage 2 checks off only after Current Medications are **verified/edited** and
  saved to the user doc.

**Key state sources:**
- `userDoc.initialFile` (bucketKey, fileName)
- `userDoc.currentMedications`
- `sessionStorage.verify-meds-<userId>` (verification prompt state)

---

### Stage 3 — Add Other Health Records
**Purpose:** add additional files to the KB.

**Actions:**
- **OK** → file chooser for non-Apple files; these go to Saved Files and can be
  checked for KB indexing.
- **Not yet** → dismisses Wizard for the session, but does not mark complete.

**When complete:**
- Stage 3 checks off automatically after indexing completes and DO reports the
  files are in the KB.

**Key state sources:**
- DO KB API (source of truth for indexed data sources)
- `localStorage.wizard-completion-<userId>.stage3Complete` (sticky UI state)

---

### Stage 4 — Review and Verify Patient Summary
**Purpose:** confirm the Patient Summary generated from the KB.

**Actions:**
- **VERIFY** → marks Stage 4 complete and hides the Wizard.
- **EDIT** → save edits; marks Stage 4 complete and hides the Wizard.

**Important:** Summary generation **does not** dismiss the Wizard. Only explicit
verify/edit actions complete Stage 4.

**Key state sources:**
- `/api/patient-summary`
- In‑session verified state via `patient-summary-verified` event

---

## Local State and Storage Keys

### LocalStorage
- `maia_last_snapshot_user`
  - userId of the most recent local snapshot.
- `wizard-completion-<userId>`
  - JSON: `{ stage3Complete: boolean }`
- `wizardKbPendingFileName-<userId>`
  - tracks a pending file name for Stage 3 KB add.

### SessionStorage
- `autoProcessInitialFile`
  - triggers automatic Lists processing after initial file selection.
- `wizardMyListsAuto`
  - flags that the Wizard is controlling the Lists tab.
- `verify-meds-<userId>`
  - JSON: `{ needsVerifyAction: boolean }` for Current Medications verification.

### IndexedDB (PouchDB)
- Database name: `maia-user-<userId>`
- Document `_id: "user_snapshot"` stores:
  - user profile
  - Saved Files metadata + chip state
  - saved chats
  - current chat draft/state
  - current medications
  - patient summary
  - initial file metadata

---

## Sign‑Out and Local Snapshot

### On Sign‑Out (Temporary User)
- Save local snapshot to IndexedDB (PouchDB).
- Store `maia_last_snapshot_user` in localStorage.
- Delete KB and user docs on the server (privacy).
- Clear temp user cookie.

### Shared Computer Mode
- If the user chooses **Shared** on Get Started:
  - Local snapshot is **not** saved.
  - User is prompted to set a Passkey.

---

## Restore Flow

### Get Started (no snapshot)
- New temporary user created.
- Wizard runs normally from Stage 1.
- Private/Shared device prompt appears (no local DB found).

### Get Started (snapshot exists)
- Check for matching agent:
  - If found: restore user, suppress Wizard.
  - If missing: show modal to clear local backup or start Wizard again.

### Rehydration
- Saved Files list shows a restore queue with chip status.
- User re‑uploads each file.
- When rehydration finishes:
  - Wizard re-evaluates.
  - Lists auto‑processing is triggered if an initial file exists.

---

## Summary of API Endpoints Used

- `POST /api/temporary/start`
- `POST /api/temporary/restore`
- `POST /api/temporary/delete`
- `GET /api/agent-exists`
- `GET /api/user-status`
- `GET /api/user-files`
- `POST /api/user-file-metadata`
- `POST /api/files/lists/process-initial-file`
- `GET /api/patient-summary`
- `POST /api/patient-summary`

---

## Known Fragility Points

- Stale `initialFile.bucketKey` after re‑uploads can block Lists processing.
- Wizard Stage 2 depends on current meds save and verify state.
- Stage 3 and 4 depend on DO KB API state and explicit user actions.

This document should be kept up-to-date as wizard behavior changes.
