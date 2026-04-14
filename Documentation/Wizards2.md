# Wizards2 — Setup & Restore Redesign

## 1. API Endpoints Inventory

Every endpoint used by the Setup wizard, Restore wizard, and MyStuff dialog tabs.

### 1.1 Setup Wizard (`ChatInterface.vue`)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/setup-wizard-messages` | Load wizard instruction messages |
| GET | `/api/user-status` | Get user workflow status, KB name |
| GET | `/api/user-files?source=wizard` | List uploaded files with indexing state |
| GET | `/api/chat/providers` | Get available chat providers |
| GET | `/api/agent-setup-status` | Check if agent is deployed and ready |
| GET | `/api/kb-indexing-status/:jobId` | Poll KB indexing progress |
| POST | `/api/files/upload` | Upload medical record PDFs |
| POST | `/api/user-file-metadata` | Register file metadata (name, bucket key, size) |
| POST | `/api/toggle-file-knowledge-base` | Include/exclude files from KB indexing |
| POST | `/api/update-knowledge-base` | Trigger KB indexing after file uploads |
| POST | `/api/generate-patient-summary` | AI-generate patient summary from documents |
| POST | `/api/save-group-chat` | Save wizard chat conversation |
| POST | `/api/wizard-log` | Log wizard events and progress |
| POST | `/api/files/lists/process-initial-file` | Process lists from initial upload |
| GET/POST | `/api/patient-summary` | Load or save patient summary |
| GET/PUT | `/api/user-settings` | Get/save user preferences (provider selection) |

### 1.2 Restore Wizard (`RestoreWizard.vue`)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/user-status` | Resolve KB name from user document |
| GET | `/api/agent-setup-status` | Poll agent deployment status |
| GET | `/api/kb-indexing-status/:jobId` | Poll KB indexing progress |
| POST | `/api/files/upload` | Upload backup files to cloud storage |
| POST | `/api/files/register` | Register uploaded files in user document |
| POST | `/api/sync-agent` | Deploy/recreate user's AI agent |
| POST | `/api/update-knowledge-base` | Trigger KB indexing for uploaded files |
| POST | `/api/restore` | Batch restore metadata (medications, summary, chats, instructions) |
| POST | `/api/files/lists/restore-markdown` | Restore My Lists markdown content |

### 1.3 MyStuff Dialog (`MyStuffDialog.vue`)

#### My Files tab

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/user-files?source=saved` | List all user files |
| GET | `/api/files/parse-pdf-first-page/:bucketKey` | Extract first page for preview |
| GET | `/api/kb-indexing-status/:jobId` | Monitor KB indexing |
| POST | `/api/files/upload` | Upload new files |
| POST | `/api/user-file-metadata` | Register file metadata |
| POST | `/api/toggle-file-knowledge-base` | Include/exclude from KB |
| POST | `/api/update-knowledge-base` | Trigger KB re-indexing |
| POST | `/api/cancel-kb-indexing` | Cancel in-progress indexing |
| POST | `/api/files/delete` | Delete file from storage |
| POST | `/api/archive-user-files` | Archive selected files |
| DELETE | `/api/delete-file` | Delete file (alternative route) |

#### My Lists / Medications tab

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/user-status` | Get verified medications from user doc |
| POST | `/api/user-current-medications` | Save current medications list |
| POST | `/api/generate-patient-summary` | AI-generate from medications |

#### Patient Summary tab

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/patient-summary` | Load patient summary |
| POST | `/api/patient-summary` | Save patient summary |
| POST | `/api/patient-summary/swap` | Swap summary versions |
| POST | `/api/generate-patient-summary` | AI-generate summary |

#### My Chats tab

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/shared-group-chats` | List shared chats for user |
| GET | `/api/load-chat/:chatId` | Load full chat conversation |
| GET | `/api/load-chat-by-share/:shareId` | Load chat by share ID |
| POST | `/api/save-group-chat` | Save new chat |
| POST | `/api/attach-kb-to-agent` | Attach KB to agent for chat context |

#### Agent Instructions tab

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/agent-instructions` | Get agent system instructions |
| PUT | `/api/agent-instructions` | Save agent system instructions |
| POST | `/api/toggle-kb-connection` | Connect/disconnect KB to agent |
| GET | `/api/user-settings` | Get `allowDeepLinkPrivateAI` toggle state |
| PUT | `/api/user-settings` | Save `allowDeepLinkPrivateAI` toggle state |

#### Privacy Filter / Patient Diary tab

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/privacy-filter-mapping` | Get privacy name mappings |
| POST | `/api/privacy-filter-mapping` | Update privacy name mappings |
| GET | `/api/patient-diary` | Get diary entries |
| POST | `/api/patient-diary` | Create diary entries |
| POST | `/api/patient-diary/mark-posted` | Mark diary entries as posted |
| POST | `/api/patient-diary/delete` | Delete diary entries |
| GET | `/api/random-names` | Get random placeholder names |
| POST | `/api/chat/digitalocean` | Query Private AI with privacy filters |

### 1.4 App-Level (`App.vue`) — Auth, Account, Orchestration

| Method | Endpoint | Purpose | Used By |
|--------|----------|---------|---------|
| GET | `/api/current-user` | Get current authenticated user | Session check |
| GET | `/api/welcome-status` | Get user onboarding status | App startup |
| GET | `/api/passkey/check-user` | Check if passkey exists for user | Auth |
| GET | `/api/agent-exists` | Check if agent deployed for user | Setup flow |
| GET | `/api/cloud-health` | Check cloud services status (DB, agent, KB, files) | Health check |
| GET | `/api/admin-username` | Get admin username | Admin setup |
| GET | `/api/user-deep-links` | Get user's shared chat deep links | Deep links |
| GET | `/api/user-chats` | List user's chats | Chat management |
| GET | `/api/files/lists/markdown` | Get My Lists markdown content | Lists retrieval |
| POST | `/api/sign-out` | Sign out user | Auth |
| POST | `/api/account/recreate` | Recreate user document for restore | Restore flow |
| POST | `/api/account/dormant` | Mark account as dormant | Account mgmt |
| POST | `/api/self/delete` | Delete user account and all data | Destroy flow |
| POST | `/api/local/delete` | Delete local snapshot data | Local cleanup |
| POST | `/api/temporary/start` | Start temporary session for new user | Onboarding |
| POST | `/api/temporary/restore` | Restore from temporary session | Session recovery |
| POST | `/api/auth/clear-temp-cookie` | Clear temporary user cookie | Auth cleanup |
| GET/POST | `/api/user-status` | Get/update user document, workflow status | Status tracking |
| POST | `/api/user-current-medications` | Save medications | Medications |
| GET/POST | `/api/patient-summary` | Get/save patient summary | Summary |

### 1.5 Shared Endpoints (used by multiple components)

| Endpoint | Setup | Restore | MyStuff | App |
|----------|:-----:|:-------:|:-------:|:---:|
| `/api/user-status` | x | x | x | x |
| `/api/files/upload` | x | x | x | |
| `/api/update-knowledge-base` | x | x | x | |
| `/api/kb-indexing-status/:jobId` | x | x | x | |
| `/api/agent-setup-status` | x | x | | |
| `/api/patient-summary` | x | | x | x |
| `/api/generate-patient-summary` | x | | x | |
| `/api/user-current-medications` | | | x | x |
| `/api/save-group-chat` | x | | x | |
| `/api/user-settings` | x | | x | |
| `/api/user-file-metadata` | x | | x | |
| `/api/toggle-file-knowledge-base` | x | | x | |

**Total: ~60 unique endpoints across all components.**

---

## 2. The Problem

Setup and Restore are two paths to the same end state: a user with files, an agent, a knowledge base, medications, a patient summary, saved chats, and agent instructions. But they are implemented as completely separate flows with divergent state management, and the wizard's client-side state leaks into MyStuff rendering.

### 2.0 Critical Bug: "verified" instead of actual content — ✅ FIXED (v1.2.x)

`saveStateToLocalFolder()` in ChatInterface.vue previously wrote:
```javascript
currentMedications: wizardCurrentMedications.value ? 'verified' : null,
patientSummary: wizardPatientSummary.value ? 'verified' : null,
```

`wizardCurrentMedications` and `wizardPatientSummary` are **booleans**, not the actual text. So `maia-state.json` stored the literal string `"verified"`. During restore, RestoreWizard sent `"verified"` to `POST /api/restore`, which wrote it into CouchDB as the medications and summary content.

**Fix:** `saveStateToLocalFolder()` now fetches actual content from the server before writing `maia-state.json`. See Section 3.6. Additionally, RestoreWizard now normalizes both `{chats:[...]}` wrapper format and bare array format for `savedChats`.

### 2.1 Current State Tracking (the mess)

**Setup wizard** tracks progress via ~15 refs in ChatInterface.vue:
- `wizardFlowPhase` ('running' | 'medications' | 'summary' | 'done')
- `wizardStage1Complete`, `indexingStatus`, `stage3IndexingStartedAt`, `stage3IndexingCompletedAt`
- `wizardCurrentMedications`, `wizardPatientSummary` (booleans — not the data itself)
- `wizardRequestAction` (signals MyStuff to generate/update summary)
- `setupLogLines` (persisted to local maia-state.json)
- localStorage keys for completion timestamps

**Restore wizard** tracks progress via its own internal refs in RestoreWizard.vue:
- `phase` ('prepare' | 'execute' | 'complete')
- Per-item status ('pending' | 'running' | 'done' | 'error' | 'skipped')
- `restoreSummary` (completion text)

**MyStuff** receives wizard state via props:
- `wizardActive` — suppresses medications-consistency checks, shows wizard summary actions
- `requestAction` — tells MyStuff to generate or update summary on behalf of the wizard
- `restoreActive` — triggers provider reload on completion

**The server** has its own `workflowStage` field on the user doc:
- 'unknown' → 'approved' → 'agent_named' → 'agent_deployed' → 'patient_summary' → etc.

### 2.2 Why It Breaks

1. **Restore doesn't set wizard refs.** After restore writes medications and summary to CouchDB, the wizard refs (`wizardCurrentMedications`, `wizardPatientSummary`) remain false. When MyStuff opens, it loads data from the server but the wizard layer doesn't know about it, causing display/logging inconsistencies.

2. **Two components race to load the same data.** The tab watcher in MyStuff calls `loadPatientSummary()` while the `requestAction` watcher calls `requestNewSummary()`. Both fire when the summary tab opens during wizard flow.

3. **Logging is split across three layers.** ChatInterface logs wizard events, RestoreWizard emits log events that get buffered/flushed through App.vue, and MyStuff logs its own tab events. Log entries get lost when components aren't mounted yet.

4. **The server `workflowStage` is write-only.** It's set during setup/restore but never read back to drive UI decisions. The client re-derives everything from scattered signals.

5. **Chats are silently dropped during restore.** The `/api/restore` endpoint accepts `savedChats` but RestoreWizard may not send them correctly, and there's no verification that the saved chats actually made it into CouchDB.

---

## 3. Redesign: Server-Side Provisioning Status

> **Implementation status:** The provisioningLog endpoint and event catalog (Sections 3.2–3.5) are implemented. The maia-state.json fix (Section 3.6) is implemented. PDF generation (Section 3.7) is partially implemented — uses client-side setupLogLines with color coding rather than rendering from the server log. The old code removal (Section 3.8) is future work — a dual-write pattern is in place today.

### 3.1 Core Principle

> **The server is the single source of truth. The client is a renderer.**

Both Setup and Restore update a `provisioningLog` array on the CouchDB user document. Each entry is a timestamped, immutable event. MyStuff never reads from or writes to this log — it loads tab data from its own existing endpoints. No wizard props (`wizardActive`, `requestAction`, `restoreActive`) flow into MyStuff.

### 3.2 Server: `provisioningLog` on the user document

Replace the scattered `workflowStage` string with a structured log array:

```json
{
  "_id": "lauren87",
  "provisioningLog": [
    {
      "id": 1,
      "time": "2026-04-12T20:46:41Z",
      "event": "setup-started",
      "method": "setup",
      "client": {
        "browser": "Chrome 146 on macOS",
        "appUrl": "http://localhost:5173",
        "folder": "AG MAIA files",
        "version": "1.2.0"
      }
    },
    { "id": 2, "time": "...", "event": "files-uploaded", "count": 4, "totalKB": 11071,
      "files": ["GROPPER_ADRIAN_09_24_25_1314-1.PDF", "GROPPER_ADRIAN_6KB.PDF", "GROPPER_ADRIAN_26KB.PDF", "Apple - Adrian Gropper - 2025-11-17.pdf"],
      "appleHealthCount": 1 },
    { "id": 3, "time": "...", "event": "apple-health-detected", "fileName": "Apple - Adrian Gropper - 2025-11-17.pdf" },
    { "id": 4, "time": "...", "event": "agent-deployed", "agentId": "...", "elapsedMs": 69000 },
    { "id": 5, "time": "...", "event": "kb-indexed", "tokens": 177996, "fileCount": 4, "elapsedMs": 341000 },
    { "id": 6, "time": "...", "event": "summary-generated", "lines": 38, "chars": 2941 },
    { "id": 7, "time": "...", "event": "medications-offered", "lines": 12 },
    { "id": 8, "time": "...", "event": "medications-saved", "lines": 12 },
    { "id": 9, "time": "...", "event": "summary-saved", "lines": 24, "chars": 1847 },
    { "id": 10, "time": "...", "event": "setup-complete" },
    { "id": 11, "time": "...", "event": "account-deleted" },
    { "id": 12, "time": "...", "event": "restore-started", "method": "restore",
      "client": { "browser": "Chrome 146 on macOS", "appUrl": "http://localhost:5173", "folder": "AG MAIA files", "version": "1.2.0" }
    },
    { "id": 13, "time": "...", "event": "files-uploaded", "count": 4, "totalKB": 11071,
      "files": ["..."], "appleHealthCount": 1 },
    { "id": 14, "time": "...", "event": "agent-deployed", "agentId": "...", "elapsedMs": 45000 },
    { "id": 15, "time": "...", "event": "kb-indexed", "tokens": 177996, "fileCount": 4, "elapsedMs": 270000 },
    { "id": 16, "time": "...", "event": "medications-restored", "lines": 12 },
    { "id": 17, "time": "...", "event": "summary-restored", "lines": 24, "chars": 1847 },
    { "id": 18, "time": "...", "event": "chats-restored", "count": 1 },
    { "id": 19, "time": "...", "event": "instructions-restored" },
    { "id": 20, "time": "...", "event": "lists-restored" },
    { "id": 21, "time": "...", "event": "restore-complete" }
  ]
}
```

### 3.3 Event Catalog

Every possible `event` value, with required fields:

#### Lifecycle events (Setup or Restore)

| Event | Extra Fields | When |
|-------|-------------|------|
| `setup-started` | `method: "setup"`, `client: {...}` | User clicks GET STARTED, folder selected |
| `restore-started` | `method: "restore"`, `client: {...}` | User clicks RESTORE, folder read |
| `setup-complete` | — | All setup steps done, user verified summary |
| `restore-complete` | — | All restore steps done |
| `account-deleted` | — | User clicks DELETE CLOUD ACCOUNT |
| `error` | `step: string`, `message: string` | Any step fails |

#### Resource events (same for Setup and Restore)

| Event | Extra Fields | Description |
|-------|-------------|-------------|
| `files-uploaded` | `count`, `totalKB`, `files[]`, `appleHealthCount`, `failedCount?`, `failedFiles?[]` | All files uploaded to S3 |
| `apple-health-detected` | `fileName` | Apple Health export found among uploaded files (setup only) |
| `agent-deployed` | `agentId`, `elapsedMs` | Agent ready with endpoint. `elapsedMs` is milliseconds for m:ss display. |
| `kb-indexed` | `tokens`, `fileCount`, `elapsedMs` | KB indexing complete. `elapsedMs` is milliseconds for m:ss display. |

#### Data events

| Event | Extra Fields | Description |
|-------|-------------|-------------|
| `summary-generated` | `lines`, `chars` | Provisional AI-generated patient summary (before medications extraction). Setup only. |
| `medications-offered` | `lines` | AI-extracted medications offered to user for verification. Setup only. |
| `medications-saved` | `lines` | Medications written to CouchDB (setup: user verified/edited) |
| `medications-restored` | `lines` | Medications written to CouchDB (from backup) |
| `summary-saved` | `lines`, `chars` | Final patient summary written (setup: user verified/edited) |
| `summary-restored` | `lines`, `chars` | Patient summary written (from backup) |
| `chats-restored` | `count` | Saved chats written to maia_chats DB |
| `instructions-restored` | — | Agent instructions restored |
| `lists-restored` | — | My Lists markdown restored |

All `elapsedMs` fields are stored in milliseconds. The PDF renderer formats them as `Xm YYs` (e.g., `1m 09s`, `5m 41s`).

### 3.4 New Endpoint: `POST /api/provisioning-log`

Appends one event to the `provisioningLog` array on the user doc.

```
POST /api/provisioning-log
Content-Type: application/json

{
  "event": "files-uploaded",
  "count": 4,
  "totalKB": 11071,
  "files": ["file1.pdf", "file2.pdf", "file3.pdf", "file4.pdf"],
  "appleHealthCount": 1
}
```

Server logic:
1. Read user doc
2. Auto-assign `id` (max existing id + 1) and `time` (server timestamp)
3. Append to `provisioningLog` array
4. Save with conflict retry
5. Return `{ success: true, id: <assigned> }`

### 3.5 New Endpoint: `GET /api/provisioning-log`

Returns the full log. Used by the client on load to render progress and determine current state.

```
GET /api/provisioning-log?userId=lauren87

Response:
{
  "success": true,
  "log": [ ... ],
  "currentState": {
    "method": "setup" | "restore" | null,
    "inProgress": true | false,
    "filesUploaded": 4,
    "agentReady": true,
    "kbIndexed": true,
    "kbTokens": 177996,
    "medicationsDone": true,
    "medicationsLines": 12,
    "summaryDone": true,
    "summaryLines": 24,
    "chatCount": 1,
    "instructionsDone": true,
    "listsDone": true
  }
}
```

The `currentState` summary is **derived** from the log on read — it scans for the latest `setup-started` or `restore-started`, then checks which events follow it. This avoids a separate state field that can get out of sync.

### 3.6 `maia-state.json` Fix: Store Actual Content — ✅ IMPLEMENTED

The old code saved booleans as the string `"verified"`. The fix fetches actual content from the server:

```javascript
// Fetch actual content from server before saving to local backup
const medsResp = await fetch(`/api/user-status?userId=${userId}`);
const medsData = await medsResp.json();

const summaryResp = await fetch(`/api/patient-summary?userId=${userId}`);
const summaryData = await summaryResp.json();

currentMedications: medsData.currentMedications || null,
patientSummary: summaryData.summary || null,
```

Additionally, `savedChats` is now wrapped as `{ chats: [...] }` to match RestoreWizard's expected format. RestoreWizard also normalizes both formats for backward compatibility.

`maia-state.json` must contain the **actual text** so restore can write it back verbatim. The `saveStateToLocalFolder` function is called:
- After setup-complete (all data finalized on server)
- After any MyStuff save (medications edited, summary edited, chat saved)
- Before account-deleted (final backup snapshot)

### 3.7 Setup Log PDF (maia-log.pdf) — Partially Implemented

> **Current implementation:** The PDF is generated client-side from the `setupLogLines` ref array in ChatInterface.vue using jsPDF. Each line has a `step`, `detail`, and `ok` field. Lines are color-coded by category. TEST mode entries are also written to setupLogLines via the dual-write `addTestLog()` helper.
>
> **Future (Phase D):** Rewrite PDF generation to render from `GET /api/provisioning-log` server events instead of client-side setupLogLines. This would make the PDF reproducible from the server and eliminate the need for the client-side logging system.

#### Color Coding (implemented)

Lines in maia-log.pdf are color-coded using `getLineColor()`:

| Color | Category | When |
|-------|----------|------|
| **Red** (200,0,0) | Errors | Any line with `ok: false` |
| **Red** (200,0,0) | Account events | `step === 'Account'` (e.g., "Cloud account deleted") |
| **Orange** (200,100,0) | Test events | `step === 'TEST'` |
| **Green** (0,120,0) | User data events | `step === 'My Stuff'`, `step === 'Current Medications'`, or Dialog lines mentioning "My Stuff" |
| **Black** (0,0,0) | Everything else | Wizard steps, system events |

#### Target Format (from server provisioning log — future)

The sections below describe the ideal PDF format when rendered from the server provisioning log. This is aspirational — the current implementation produces a similar but not identical layout from client-side `setupLogLines`.

```
--- Setup ---
[8:46:41 PM] Setup started
[8:46:55 PM] Files uploaded: 4 files (10,821 KB total), 1 Apple Health
[8:47:51 PM] Agent deployed (1m 09s)
[8:52:45 PM] Knowledge Base indexed: 4 files, 177,996 tokens (5m 41s)
[8:52:49 PM] Patient Summary generated (38 lines, 2,941 chars)
[9:02:36 PM] Current Medications saved (12 lines)
[9:02:50 PM] Patient Summary saved (24 lines, 1,847 chars)
[9:02:54 PM] Setup complete

[9:03:14 PM] Cloud account deleted

--- Restore ---
[9:03:30 PM] Restore started
[9:04:15 PM] Files uploaded: 4 files (10,821 KB total), 1 Apple Health
[9:05:01 PM] Agent deployed (0m 45s)
[9:09:30 PM] Knowledge Base indexed: 4 files, 177,996 tokens (4m 30s)
[9:09:31 PM] Current Medications restored (12 lines)
[9:09:31 PM] Patient Summary restored (24 lines, 1,847 chars)
[9:09:31 PM] Saved chats restored (1)
[9:09:31 PM] Restore complete
```

### 3.8 What Was Removed — ✅ DONE (Phase C/D)

#### Phase C: Wizard props removed from MyStuffDialog.vue

| Removed | Replacement |
|---------|-------------|
| `wizardActive` prop | Removed — `showSummaryAttention` now uses only `summaryNeedsVerify` |
| `requestAction` prop + watcher | Replaced by `wizardGenerateSummary()` method exposed via `defineExpose`, called through template ref from ChatInterface |
| `showWizardSummaryActions` computed | Removed — was `wizardActive && tab === 'summary'`, no longer needed |
| `request-action-done` emit | Removed — no prop to acknowledge |
| `wizardActive` guard on meds consistency check | Removed — check now runs whenever `summaryCount > 1` |

Note: `pendingSummaryRegeneration` ref stays — it prevents the tab watcher from racing with `requestNewSummary()` and is still used by `handleShowPatientSummary()`. `restoreActive` was never on MyStuffDialog (it's on ChatInterface, suppressing dialogs during restore).

#### Phase D: Old client-side logging system removed

| Removed | Notes |
|---------|-------|
| `setupLogLines` ref + 77 `addSetupLogLine()` calls | All logging now via `logProvisioningEvent()` |
| `addSetupLogLine()` function, `oneTimeLogSteps` set | Gone |
| `restoreSetupLogFromState()` + session-change divider logic | Gone |
| `setupLog` field in `maia-state.json` | No longer written or read |
| `generateSetupLogPdf()` body | Rewritten to fetch from `GET /api/provisioning-log` and render server events |
| `restoreLogBuffer` + `flushRestoreLogBuffer` + `handleRestoreLog` in App.vue | Gone |
| `@restore-log` event binding in App.vue | Gone |
| `logStep()` function + 21 calls + `restore-log` emit in RestoreWizard.vue | Gone — `logProvisioningEvent()` already existed alongside each call |
| `addSetupLogLine` in `defineExpose` | Removed — `generateSetupLogPdf` still exposed |

### 3.9 MyStuff Independence

MyStuff tabs load data from their existing endpoints. No wizard props. No special behavior during or after setup/restore.

| Tab | Data Source | How It Works |
|-----|-----------|-------------|
| Saved Files | `GET /api/user-files` | Lists files. Always works — files are there or not. |
| My AI Agent | `GET /api/agent-instructions`, `GET /api/user-settings` | Shows instructions, KB connection toggle, deep link toggle. |
| Saved Chats | `GET /api/shared-group-chats` | Lists chats. Empty if none saved yet. |
| Patient Summary | `GET /api/patient-summary` | Shows summary. Empty state if not yet generated. |
| My Lists | `GET /api/files/lists/markdown` | Shows lists. Empty state if none. |
| Privacy Filter | `GET /api/privacy-filter-mapping` | Shows mappings. Empty state if none. |
| Patient Diary | `GET /api/patient-diary` | Shows diary entries. Empty state if none. |
| References | (static content) | No data loading. |

**The guided review flow** (verify medications → verify summary) stays in the wizard component. The wizard opens MyStuff to a specific tab, but MyStuff doesn't know or care that it was opened by the wizard. When MyStuff closes, the wizard checks the server (`GET /api/provisioning-log` → `currentState.medicationsDone`) and moves to the next step.

### 3.10 Setup Flow (revised)

```
 1. User clicks GET STARTED, selects local folder
 2. POST /api/provisioning-log { event: "setup-started", client: {...} }
 3. Upload files → POST /api/files/upload (existing, per file)
 4. POST /api/provisioning-log { event: "files-uploaded", count, files, totalKB, appleHealthCount }
 5. If Apple Health file found:
    POST /api/provisioning-log { event: "apple-health-detected", fileName }
 6. Deploy agent → POST /api/sync-agent (existing)
    Poll /api/agent-setup-status until ready, track start time
 7. POST /api/provisioning-log { event: "agent-deployed", agentId, elapsedMs }
 8. Index KB → POST /api/update-knowledge-base (existing)
    Poll /api/kb-indexing-status/:jobId until done, track start time
 9. POST /api/provisioning-log { event: "kb-indexed", tokens, fileCount, elapsedMs }
10. Generate summary → POST /api/generate-patient-summary (existing)
    Count lines of generated text
    POST /api/provisioning-log { event: "summary-generated", lines, chars }
11. Extract medications from summary, count lines offered
    POST /api/provisioning-log { event: "medications-offered", lines }
12. Open MyStuff to Medications tab (user verifies/edits, saves)
    On save: POST /api/user-current-medications (existing)
    POST /api/provisioning-log { event: "medications-saved", lines: <final count> }
13. Switch MyStuff to Summary tab (user verifies/edits, saves)
    On save: POST /api/patient-summary (existing)
    POST /api/provisioning-log { event: "summary-saved", lines, chars }
14. POST /api/provisioning-log { event: "setup-complete" }
15. Save maia-state.json with ACTUAL content (fetch from server)
16. Generate maia-log.pdf from GET /api/provisioning-log
```

### 3.11 Restore Flow (revised)

```
1. User clicks RESTORE on orange badge
2. Read maia-state.json from local folder (actual content now)
3. POST /api/account/recreate (existing)
4. POST /api/provisioning-log { event: "restore-started", client: {...} }
5. Upload files from local folder → POST /api/files/upload (per file)
6. POST /api/provisioning-log { event: "files-uploaded", count, files, ... }
7. Deploy agent → POST /api/sync-agent
   Poll until ready
8. POST /api/provisioning-log { event: "agent-deployed", agentId, elapsed }
9. Index KB → POST /api/update-knowledge-base
   Poll until done
10. POST /api/provisioning-log { event: "kb-indexed", tokens, fileCount, elapsed }
11. Restore metadata → POST /api/restore {
      currentMedications: <actual text from maia-state.json>,
      patientSummary: <actual text from maia-state.json>,
      savedChats: <actual chat objects from maia-state.json>,
      agentInstructions: <actual text from maia-state.json>
    }
12. POST /api/provisioning-log { event: "medications-restored", lines: <count> }
13. POST /api/provisioning-log { event: "summary-restored", lines: <count>, chars: <count> }
14. POST /api/provisioning-log { event: "chats-restored", count: <n> }
15. POST /api/provisioning-log { event: "instructions-restored" }  (if applicable)
16. Restore lists → POST /api/files/lists/restore-markdown (existing)
17. POST /api/provisioning-log { event: "lists-restored" }  (if applicable)
18. POST /api/provisioning-log { event: "restore-complete" }
19. Re-save maia-state.json (confirms round-trip)
20. Generate maia-log.pdf from GET /api/provisioning-log
```

### 3.12 Delete Cloud Account Flow

```
1. User clicks DELETE CLOUD ACCOUNT
2. Save maia-state.json with ACTUAL content (fetch all from server first)
3. POST /api/self/delete (existing)
4. POST /api/provisioning-log { event: "account-deleted" }
   (This goes to the recreated-minimal user doc, or is appended before deletion
    and preserved in maia-state.json as part of the setupLog field)
5. Welcome page shows orange badge (existing discoverUsers logic)
```

Note: The `account-deleted` event should be saved to `maia-state.json` locally before the server doc is destroyed, so the restore flow can show the full history.

---

## 4. Automated Setup-Restore Testing — ✅ IMPLEMENTED

### 4.1 Test Cycle

The full automated cycle:

```
SETUP (real wizard) → auto-verify → DELETE CLOUD → RESTORE (real wizard) → verify all tabs → compare → PASS/FAIL
```

**Key design principle:** The TEST button does NOT replace the wizard UI with a separate test runner. Instead, it sets a `testMode` flag that drives the **real wizard flow** with auto-verification at every choice point. This ensures the test exercises the actual code paths.

### 4.2 TEST Button

A **TEST** button appears in the wizard's folder-select step, **only on localhost** (`window.location.hostname === 'localhost'`). It sits next to the existing folder-select button.

When clicked:
1. The user selects their local folder (same File System Access API picker as normal setup)
2. `testMode` ref is set to `true` on the ChatInterface component
3. The real wizard runs normally — same UI, same code paths
4. At every Verify or Edit choice point, auto-verify watchers accept the AI-generated content and continue automatically
5. No further user interaction is needed

### 4.3 Auto-Pilot Architecture

The test is split across two components:

**ChatInterface.vue** — Drives the Setup phase:
- `testMode` ref: When true, auto-verify watchers fire at medications and summary steps
- `testLogLines` ref: Accumulates test-specific log entries
- `testFinalOutput` ref: Displayed in an orange results panel at the bottom of the wizard
- `testSetupVerification` ref: Stores `verifyAllTabs()` result after setup for later comparison
- `addTestLog(text, ok)`: Writes to `testLogLines` (for the results panel). Test events in maia-log.pdf come from the server `provisioningLog` (color-coded orange)
- `setTestFinalOutput(text)`: Setter exposed via `defineExpose` (avoids Vue 3 ref-unwrapping ambiguity)
- `closeMyStuff()`: Closes MyStuff dialog so test results panel is visible
- Emits `test-setup-complete` event with `{ verification, folderHandle }` when setup finishes
- Phase transition watcher: watches `wizardFlowPhase` for `summary→done` transition (not a boolean expression, to avoid premature firing when testMode is first set)

**App.vue** — Drives the Delete → Restore → Verify phases via `handleTestSetupComplete()`:
1. Reads and validates `maia-state.json` from the local folder
2. Logs `account-deleted` provisioning event
3. Calls `POST /api/self/delete` to destroy the cloud account
4. Calls `POST /api/account/recreate` to recreate a fresh user doc
5. Fetches cloud health to verify clean state
6. Sets `restoreWizardLocalState` and `showRestoreWizard = true` to launch the real RestoreWizard
7. After RestoreWizard completes (`handleRestoreWizardComplete` with `testModeActive` check):
   - Runs `verifyAllTabs()` on post-restore state
   - Runs `compareResults()` against the setup verification
   - Logs each comparison check as pass/fail via `addTestLog()`
   - Calls `closeMyStuff()` to reveal the test results panel
   - Calls `saveLocalSnapshot(null)` to clear the orange badge
   - Calls `generateSetupLogPdf()` to include test entries in maia-log.pdf

**`src/utils/setupRestoreTest.ts`** — Verification-only utility (not a test runner):
- `verifyAllTabs(userId)`: Fetches from 6+ endpoints via `Promise.allSettled`, returns a `TabVerification` object
- `compareResults(setup, restore)`: Compares two `TabVerification` objects field by field
- `validateBackupState(state)`: Checks `maia-state.json` has actual content (not `"verified"`)
- `formatVerification()` / `formatComparison()`: Human-readable output formatters

### 4.4 `verifyAllTabs()` — What to Check

| Tab | Endpoint | Assertion |
|-----|----------|-----------|
| Saved Files | `GET /api/user-files` | `files.length === expected count` |
| My AI Agent | `GET /api/agent-setup-status` | `agentReady === true` |
| My AI Agent | `GET /api/agent-instructions` | `instructions` exists (if was set) |
| Saved Chats | `GET /api/shared-group-chats` | `chats.length === expected count` |
| Patient Summary | `GET /api/patient-summary` | `summary.length > 0`, `summary !== 'verified'` |
| My Lists | `GET /api/files/lists/markdown` | `markdown.length > 0` (if was set) |
| Medications | `GET /api/user-status` | `currentMedications.length > 0`, `currentMedications !== 'verified'` |

All fetches use `Promise.allSettled` so one endpoint failure doesn't block the rest.

### 4.5 Auto-Verify Behavior

During the test cycle, whenever the normal setup flow would present a Verify or Edit choice to the user:

| Choice Point | Normal Flow | TEST Mode |
|-------------|-------------|-----------|
| Current Medications offered | MyStuff opens to My Lists tab, user can edit or verify | Waits 10s for Apple Health auto-processing, then checks server for medications. If empty, extracts "Current Medications" section from the pre-generated patient summary. Saves to server and continues. |
| Patient Summary shown | MyStuff opens to Summary tab, user can edit or verify | Auto-accept as-is, log `summary-saved` |

The auto-verify watchers in ChatInterface.vue fire during the real wizard flow — no separate test code path. The wizard opens MyStuff tabs as usual, but the watchers auto-save and close them.

**Medications fallback chain** (implemented because Lists.vue auto-processes Apple Health but requires user VERIFY click to save):
1. Wait 10s for medications to appear on server
2. If not found, fetch from `GET /api/user-status` → `currentMedications`
3. If still empty, extract from `preGeneratedSummary` by finding the "Current Medications" section header
4. Save whatever was found via `POST /api/user-current-medications`

### 4.6 Test Output

Test results are displayed in two ways:

**1. Orange results panel** — An orange-bordered panel at the bottom of the wizard chat interface. Shows `testFinalOutput` text with the comparison results (PASS/FAIL for each field).

**2. maia-log.pdf** — Test entries are written to setupLogLines with `step: 'TEST'` and rendered in orange in the PDF. The PDF includes the full wizard log (black), user data events (green), test events (orange), and errors (red).

Example test log entries in the PDF:
```
[TEST] Setup verification: 4 files, agent ready, summary 24 lines, medications 12 lines
[TEST] maia-state.json validated: medications 12 lines, summary 24 lines, 1 chat
[TEST] Cloud account deleted
[TEST] Account recreated, restore starting...
[TEST] Post-restore: Files count: PASS (4 === 4)
[TEST] Post-restore: Agent ready: PASS
[TEST] Post-restore: Summary: PASS (24 lines)
[TEST] Post-restore: Medications: PASS (12 lines)
[TEST] Post-restore: Chats: PASS (1 === 1)
[TEST] RESULT: ALL CHECKS PASSED
```

### 4.7 Bugs Found and Fixed During Testing

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| TEST halts immediately | `wizardFlowPhase` starts as `'done'`, so boolean watcher `testMode && phase === 'done'` fired when testMode was set | Watch phase value with old/new: only fire on `summary→done` transition |
| Medications empty after restore | `saveStateToLocalFolder` wrote `'verified'` string | Fetch actual content from server (Section 3.6) |
| Saved chats not restored | `savedChats` stored as bare array, RestoreWizard expected `{chats:[...]}` | Wrap in `saveStateToLocalFolder`, handle both formats in RestoreWizard |
| Medications timeout (15s hang) | Lists.vue auto-processes Apple Health but needs user VERIFY click | Reduced to 10s, added server check + patient summary extraction fallback |
| MyStuff dialog hides results | Dialog left open after restore, covering test panel | Added `closeMyStuff()` to defineExpose, called after verification |
| Orange badge after restore | Server reported `wizardComplete: false` due to missing medications | Medications fix + `saveLocalSnapshot(null)` after test |
| jsPDF Unicode spacing | `✓` character spaced out in PDF | Use plain ASCII text instead |
| Chat restore silent failures | `catch {}` swallowed all errors | Added logging: `console.warn` + `results.errors.push()` |
| maia-log.pdf truncated (setup events missing) | Two independent state-save functions: `saveLocalSnapshot` (App.vue) and `saveStateToLocalFolder` (ChatInterface.vue) both overwrite `maia-state.json`. `saveLocalSnapshot` didn't include `provisioningLog`, so calling it after restore erased setup events before `generateSetupLogPdf` could merge them. | Added `provisioningLog: existingState?.provisioningLog` to `saveLocalSnapshot`. Also fixed merge logic in `generateSetupLogPdf` to use compound key `(id+time)` instead of bare `id` (IDs restart from 1 after account recreation). |

### 4.8 Known Fragility: Dual State-Save Functions

There are two functions that write `maia-state.json`:

| Function | Location | When Called |
|----------|----------|-------------|
| `saveLocalSnapshot()` | App.vue | Sign-out, restore complete, post-test cleanup |
| `saveStateToLocalFolder()` | ChatInterface.vue | End of `generateSetupLogPdf()` |

Both overwrite the entire file. Any field that one function manages but the other doesn't will be silently erased when the other runs. Today both carry forward `provisioningLog` from the existing file, but this pattern is fragile — adding a new field to one function without updating the other will recreate the same bug.

**Future improvement:** Consolidate into a single state-save function, or adopt a read-merge-write pattern where unknown fields are always preserved.
