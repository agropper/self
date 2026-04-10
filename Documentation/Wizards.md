# Account Lifecycle: Welcome, Setup, Sign-out, Destroy, and Restore

This document describes MAIA's account lifecycle flows, the modals involved
in each, verification steps, and how multiple family members are kept
separate.

---

## 1. Architecture Overview

Account state lives in three systems:

| System | What it stores |
|--------|---------------|
| **CouchDB** (`maia_users`) | User doc: `assignedAgentId`, `kbId`, `kbName`, `files[]`, `workflowStage`, `currentMedications`, `patientSummary` |
| **DigitalOcean** | Agent (GenAI platform), Knowledge Base, Spaces (S3) files |
| **Browser** | IndexedDB folder handle, localStorage (`knownUsers[]`, snapshot data), sessionStorage flags, `maia-state.json` in local folder |

---

## 2. Welcome Page (App.vue)

Every session begins here when the user is not authenticated.

### Known User Cards

If `knownUsers` (from localStorage) contains entries, each is displayed as
a status card with color-coded border and icon:

| Cloud status | Border color | Icon | Action button |
|-------------|-------------|------|---------------|
| `ready` | Green | check_circle | SIGN IN / CONTINUE |
| `loading` | Grey | hourglass_empty | (spinner) |
| `restore` | Orange | warning | RESTORE |

Each card shows the user's display name, userId, folder name, and an X
button to remove from this device. Below the cards, an "Add family member"
button starts a fresh new-user flow.

If no known users exist, a simple text line offers to sign in with a
passkey or create a new account.

### Welcome Page Controls

- **GET STARTED** button (blue, full width) — calls
  `handleGetStartedNoPassword()`. When restorable users exist, shows a
  disambiguation dialog first (see below).
- **Introduction** — loaded from `public/welcome.md`, rendered via
  vue-markdown.
- **Footer links**: Privacy | User Guide | FAQ | About — each opens a static HTML
  page (`/privacy.html`, `/User_Guide.html`, `/faq.html`, `/about.html`) in a new
  tab. These HTML files live in `public/` and are hand-edited.

### Get Started Disambiguation

**Modal: `showGetStartedChoiceDialog`**

When a user clicks GET STARTED and there are restorable (destroyed) users
in knownUsers, this dialog appears to prevent accidentally creating a new
account when the user intended to restore:

- One **Restore {name}** button per restorable user
- An **Add a new family member** button for genuinely new accounts

---

## 3. New User Setup

### Step 1: Device Privacy Dialog

When a truly new user clicks GET STARTED (no knownUsers at all):

**Modal: `showDevicePrivacyDialog`** (persistent)
- "Is this a private computer or a shared computer?"
- **PRIVATE**: Sets `sharedComputerMode = false`, proceeds to create
  session.
- **SHARED**: Sets `sharedComputerMode = true`, shows a warning that a
  passkey will be required, then proceeds.

### Step 2: Temporary Session

`startTemporarySession()` calls `POST /api/temporary-session`, which
creates a CouchDB user doc and returns a session cookie. The user is now
authenticated and the main ChatInterface loads. The new userId is added
to `knownUsers` in localStorage.

If `sharedComputerMode` is true, passkey registration is started
immediately after authentication.

### Step 3: Setup Wizard (ChatInterface)

**Modal: `showAgentSetupDialog`** (persistent, dismissible via Continue
button or X once agent deployment completes)

The wizard displays a vertical checklist of steps. The first three run
in parallel; the last two require user verification.

**Stage 1 — Private AI Agent Deployment**
- Triggered automatically on ChatInterface mount.
- ChatInterface polls `GET /api/agent-setup-status` every few seconds.
- This endpoint calls `ensureUserAgent()` to create a DO agent if none
  exists.
- A countdown timer shows elapsed time (typically 2-5 minutes).
- Complete when `assignedAgentId` exists and agent is deployed.
- Status line: "Ready" when done.

**Stage 2 — File Upload and Import**
- User picks a local folder (via File System Access API) or selects
  individual files (Safari/other browsers).
- Files are uploaded via `POST /api/files/upload`.
- If an Apple Health PDF is detected, it becomes the `initialFile` and
  is marked for list/medication extraction after indexing.

**Stage 3 — Knowledge Base Indexing**
- Triggered by `POST /api/update-knowledge-base`.
- Server creates or reuses a DO Knowledge Base, copies files into an
  ephemeral Spaces bucket, and starts an indexing job.
- **Server-side polling** (every 15s): tracks DO job status, token
  counts, and token stability. Completion is detected by:
  1. DO API job status transitioning to "completed"
  2. Token-stable detection: tokens > 0 and unchanged for 4+ polls (60s)
  3. Time-based fallback: 15 minutes elapsed
- **Client-side polling** (every 15s): reads `kbIndexingStatus` from
  CouchDB. Completion fallbacks:
  1. `backendCompleted` flag set by server
  2. `inferredComplete`: no active job and tokens > 0
  3. `tokenTimeoutComplete`: tokens > 0 and 7 minutes elapsed
  4. `pureTimeoutComplete`: 20 minutes elapsed (catches 0-token case)
- Console logging is state-change-only (logs only when poll state
  differs from previous poll).

### Guided Flow: Post-Indexing Transition

When both Stage 1 (agent) and Stage 3 (indexing) complete, the wizard
enters a **guided flow** controlled by `wizardFlowPhase`:

```
'running' → 'medications' → 'summary' → 'done'
```

**Phase: 'running' → 'medications' (automatic)**

The wizard dialog stays open with "Preparing..." spinners on the
Current Medications and Patient Summary checklist items while:
1. Patient Summary is generated via `/api/generate-patient-summary`
   and saved to the server.
2. The subtitle changes to "Preparing health records... Almost done."
3. The Continue/X buttons are hidden to prevent premature dismissal.

Once the summary is saved, the wizard dialog closes and the My Stuff
dialog opens on the **My Lists** tab. Lists.vue auto-processes the
Apple Health file (if present), extracts category lists, and uses AI
to generate Current Medications from the medication records.

The user reviews, edits, and verifies the Current Medications.

**Phase: 'medications' → 'summary'**

When the user saves/verifies medications, the My Stuff dialog switches
to the **Patient Summary** tab. If a pre-generated summary exists, it
is updated with the verified medications. Otherwise, a new summary is
generated.

**Phase: 'summary' → 'done'**

When the user saves or verifies the Patient Summary, the guided flow
completes. The wizard emits `'wizard-complete'` and My Stuff stays
open for the user to explore.

**Guided Flow Dismissal Handling**

If the user closes My Stuff during the guided flow:
- First dismissal: dialog reopens on the same tab (via `nextTick`).
- Second dismissal in 'medications' phase: skips to 'summary' phase,
  reopens on Patient Summary tab.
- Second dismissal in 'summary' phase: completes the wizard without
  summary verification.

`guidedFlowDismissCount` tracks dismissals per phase and resets on
each phase transition.

### Wizard State Persistence

- `wizardFlowPhase` is **not persisted** to storage — it resets to
  `'done'` on page reload.
- On reload, a resume watcher checks whether indexing is complete and
  agent is ready but medications/summary are still pending. If so, it
  re-enters the appropriate phase and reopens My Stuff.
- `wizardAutoFlow` flag is stored in `sessionStorage.wizardMyListsAuto`
  to tell Lists.vue to auto-process files.
- `autoProcessInitialFile` flag is stored in
  `sessionStorage.autoProcessInitialFile`.

### Wizard Logging

Every stage transition and modal open/close is logged to the setup log
file via `POST /api/wizard-log`. The `logWizardEvent()` function in
Lists.vue and `addSetupLogLine()` in ChatInterface.vue handle this.
Progress entries are written every ~60 seconds during polling.

Tab opens are emitted by MyStuffDialog via `'tab-opened'` events and
logged by ChatInterface's `handleMyStuffTabOpened()`. Brief Saved Files
tab opens (< 1 second) are suppressed.

---

## 4. Sign-out Flows

Sign-out behavior depends on the account type.

### Temporary Account Sign-out

**Modal: `showTempSignOutDialog`**
- "You're signed into a temporary account."
- **CREATE A PASSKEY**: Opens passkey registration (converts temporary
  to persistent).
- **DESTROY ACCOUNT**: Opens the Destroy dialog (see Section 5).
- **SIGN OUT**: Calls `handleTemporarySignOut()` — signs out without
  destroying. The temp session cookie persists; user can resume later.

### Authenticated (Passkey) Account Sign-out

1. If the user has shared deep links: shows the Dormant Dialog.
2. If no deep links and no local backup: offers Passkey Backup first.
3. Otherwise: proceeds directly to dormant sign-out.

**Modal: `showDormantDialog`**
- "Deep links require a running server."
- **KEEP SERVER LIVE**: Signs out locally but server stays active for
  deep-link recipients. Saves local snapshot.
- **GO DORMANT**: Saves local snapshot, calls `POST /api/account/dormant`
  to pause the server, then signs out.

### Passkey Backup Flow

**Modal: `showPasskeyBackupPromptModal`**
- "Encrypt a backup with a 4-digit PIN?"
- **NO**: Skips backup, proceeds to sign-out. Sets a flag so the prompt
  doesn't repeat.
- **YES**: Opens PIN dialog.

**Modal: `showPasskeyBackupPinDialog`**
- User enters a 4-digit PIN.
- Snapshot is encrypted with the PIN and saved to localStorage.
- Then proceeds to sign-out.

### Local State Snapshot

During sign-out, `saveLocalSnapshot()` writes the user's current state
to their local folder as `maia-state.json` (files list, medications,
patient summary, saved chats, agent instructions). This enables restore.

---

## 5. Account Destruction

### From Sign-out Dialog

Temporary users can reach Destroy via the sign-out dialog's
"DESTROY ACCOUNT" button.

**Modal: `showDestroyDialog`** (persistent)

**Verification step**: user must type their exact userId to confirm.

- Displays: "This permanently deletes your cloud data for {userId}.
  Signing out is reversible; destroying is not."
- Input field: "Enter user ID"
- **DESTROY** button: enabled only when typed text matches `user.userId`
  exactly.

### Destroy Process

`destroyTemporaryAccount()`:
1. Saves a local state snapshot (for potential restore)
2. Calls `POST /api/self/delete`, which runs
   `deleteUserAndResources(userId)`:
   - Deletes Spaces files under `{userId}/`
   - Deletes Knowledge Base by stored `kbId`
   - Deletes Agent by `assignedAgentId` + scans for orphan agents
   - Deletes session documents
   - Deletes the user document from CouchDB
3. Clears IndexedDB snapshot
4. Resets auth state (back to Welcome page)
5. The `knownUsers` entry is preserved with `cloudStatus: 'restore'`
   so the Welcome page shows the user card with a RESTORE button.

---

## 6. Account Restoration

When a destroyed user's card shows on the Welcome page with status
"restore" (orange), the user clicks RESTORE.

### Restore Flow (`handleUserCardRestore`)

1. **Read local state**: Tries in order:
   - Stored folder handle → reads `maia-state.json`
   - IndexedDB saved handle → reads `maia-state.json`
   - Prompts user to pick their local folder
   - Falls back to IndexedDB snapshot
2. **Recreate user doc**: `POST /api/account/recreate` → creates fresh
   CouchDB user doc with `kbName` pre-set (from snapshot or generated).
3. **Cloud health check**: `GET /api/cloud-health` → verifies what
   exists in DigitalOcean.
4. **Launch RestoreWizard**: Opens with local state and cloud health.

### RestoreWizard

**Modal: RestoreWizard component** (full-screen dialog)

Runs automatically on mount — no user interaction required:

- **Step 1**: Upload files from local state → `POST /api/files/upload`
  and register metadata
- **Step 2**: Deploy agent → `POST /api/sync-agent?create=true`
- **Step 3**: Index KB → `POST /api/update-knowledge-base`
- **Steps 4-7**: Restore medications, patient summary, saved chats,
  and agent instructions from the local state snapshot

After RestoreWizard completes, the setup wizard reopens if there are
rehydration files (files that need re-uploading from the user's device).

### Post-Restore Verification

After the RestoreWizard completes:
- Folder identity is re-stamped with the current userId
- A personalized `.webloc` shortcut is written
- Local state snapshot is updated
- Agent status is checked to confirm endpoint is ready

---

## 7. More Choices (Account Management)

Accessed via the **MORE CHOICES** button on the Welcome page.

**Modal: `showOtherAccountOptionsDialog`**

Available actions depend on user type:
- **Sign in as a different user**: Opens passkey auth.
- **Delete Cloud Account for {userId}**: Requires passkey verification
  first.
- **Delete Local Storage for {userId}**: Clears localStorage snapshot.

### Cloud Account Deletion

**Modal: `showMoreChoicesConfirmDialog`** (kind = 'delete-cloud')

For cloud users (with passkey):
- **Keep local backup and delete cloud**: Saves snapshot locally, then
  calls `POST /api/account/dormant`.
- **Delete everything**: Calls `POST /api/self/delete` and clears local
  snapshot.

For local-only users:
- Single **DELETE** button: restores temp session, calls
  `POST /api/self/delete`, clears snapshot, signs out.

### Local Storage Deletion

**Modal: `showMoreChoicesConfirmDialog`** (kind = 'delete-local')
- Single **DELETE** button: clears `userSnapshot` for the userId from
  localStorage, reloads welcome status.

---

## 8. Multi-Family-Member Separation

MAIA supports multiple family members using the same device.

### The knownUsers Registry

`knownUsers` is an array in localStorage. Each entry contains:
- `userId` — unique identifier (e.g. "chloe73")
- `displayName` — patient name for display
- `folderName` — local folder associated with this user
- `hasPasskey` — whether the user has registered a passkey

The Welcome page displays a card for each known user with their current
cloud status.

### Cloud Isolation
- Each user has their own CouchDB document, DO agent, KB, and Spaces
  folder (all prefixed by userId).
- Session cookies are per-user.

### Local Storage Isolation
- Snapshots are keyed by userId in localStorage.
- Folder handles in IndexedDB are per-user.
- `maia-state.json` in each user's folder stores their state.

### Verification Safeguards
- **Destroy**: Requires typing the exact userId to confirm.
- **Passkey**: Each user registers their own passkey, tied to their
  userId.
- **Shared device mode**: Forces passkey registration immediately after
  account creation, preventing unauthorized access.
- **User cards**: Color-coded (green/grey/orange) to make each user's
  status immediately obvious.
- **Disambiguation dialog**: When restorable users exist and someone
  clicks GET STARTED, a dialog prevents accidentally creating a new
  account instead of restoring.

### Removing a Family Member

Each user card has an X button that calls `handleDeleteLocalUser()`:
1. Removes the user from `knownUsers`
2. Cleans MAIA files from their local folder (if handle available)
3. Clears their IndexedDB snapshot
4. Optionally deletes their cloud account if still active

---

## 9. Versioning

MAIA uses semantic versioning with these rules:

| Segment | When it changes |
|---------|----------------|
| **Major** (X.0.0) | Incompatible database or backup/restore format changes |
| **Minor** (0.X.0) | Major new functionality added |
| **Patch** (0.0.X) | Each app update (bug fixes, UI tweaks, minor improvements) |

The version is stored in `package.json` and can be displayed in the
app's About section. A major version bump signals that existing backups
or CouchDB documents may not be compatible and migration steps are
needed.

---

## 10. Known Issues and Improvement Suggestions

### Issue: Lists Source File footer shown during wizard

The "LISTS SOURCE FILE" section at the bottom of My Lists (showing
total pages, file name, REPLACE/SHOW/DOWNLOAD buttons) appears whenever
`pdfData` or `markdownBucketKey` exists. It has no wizard-mode guard, so
it displays during the guided flow when the user should be focused on
verifying medications.

**Suggestion**: Hide the footer when `wizardAutoFlow` is active. The
footer is only useful during manual My Stuff updates.

### Issue: Lists component not wrapped in KeepAlive

The Lists component inside MyStuffDialog's tab panel is recreated every
time the user switches away and back. This means `onMounted` re-runs,
triggering `loadCurrentMedications()`, `checkInitialFile()`, and
potentially `attemptAutoProcessInitialFile()` again. During the wizard
flow, this can cause redundant API calls and brief UI flashes.

**Suggestion**: Either wrap Lists in `<KeepAlive>` so it preserves
state across tab switches, or add guards in `onMounted` to detect that
the component was previously initialized for this session.

### Issue: Dialog-to-dialog transition flash

When the wizard dialog closes (`showAgentSetupDialog = false`) and My
Stuff opens (`showMyStuffDialog = true`) on the next line, there can be
a single frame where neither dialog is visible — the user briefly sees
the empty chat behind.

**Suggestion**: Open My Stuff BEFORE closing the wizard dialog, or use
a single transition that swaps one for the other atomically.

### Issue: Tab switch flash during guided flow

When medications are saved and `myStuffInitialTab` changes from 'lists'
to 'summary' while the dialog is open, the tab panel may briefly show
the default 'files' tab or an intermediate state before settling on
'summary'.

**Suggestion**: Set `loadingSummary = true` in MyStuffDialog before
the tab switch (this is partially done but could be more robust), or
use a loading overlay that covers the entire dialog during transitions.

### Issue: Two separate onActivated hooks in Lists.vue

Lists.vue has two `onActivated()` hooks at different locations. Both
fire independently when the component is re-activated. The first handles
wizard/verify state; the second handles category reloading and
auto-processing. This separation makes the activation flow harder to
reason about and increases the risk of competing triggers.

**Suggestion**: Merge into a single `onActivated` hook with clear
sequential logic.

### Issue: Reload handling is fragile

`wizardFlowPhase` resets to `'done'` on every page reload. A resume
watcher tries to detect mid-flow state by checking server-side flags,
but this has gaps:
- If the user reloads during the 'running' phase (indexing in progress),
  the wizard dialog disappears. When indexing later completes, the
  wizard dialog suddenly reappears — potentially confusing.
- The resume logic does not log its transitions, making debugging harder.
- There is no indication to the user that a resume happened.

**Suggestion**: Either persist `wizardFlowPhase` to sessionStorage, or
make the resume watcher's behavior more visible (log it, show a brief
"Resuming setup..." message).

### Issue: Logging gaps

The following transitions are not logged to the setup log:
- Wizard initially entering 'running' phase (only the completion of
  running → medications is logged).
- Reload-triggered phase resumption.
- First guided-flow dismissal (only the second dismiss is logged as a
  warning).
- User manually switching tabs during guided flow.
- Medication verify/edit/save actions within Lists.vue (only generation
  and loading are logged, not user verification).

**Suggestion**: Add logging for all of the above. The setup log should
be a complete narrative of what happened during account creation.

### Issue: Rapid status changes in medication loading

The `loadCurrentMedications()` function cycles through multiple status
values (`waiting` → `reviewing` → `consulting` → `''`) with only a
1-second gap. Template sections render conditionally on each status.
On slower devices, this can cause visible UI flickering.

**Suggestion**: Use a single "loading" state with a progress message
rather than cycling through multiple distinct UI states.

### Issue: No guard rails on user tab switching during guided flow

During the guided flow, the user can freely click other tabs (Saved
Files, Privacy, Diary, etc.), breaking the expected flow. There are no
warnings, no prevention, and no easy way back.

**Suggestion**: Either disable non-relevant tabs during the guided
flow, or show a "Return to {current step}" banner when the user
navigates away. An even simpler approach: let the guided flow work
regardless of tab switches by not relying on the user being on a
specific tab.
