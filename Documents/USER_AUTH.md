# User authentication: sign-in, sign-out, and account types

This document describes the two kinds of users, the welcome page (status line, GET STARTED, Other Account Options), passkey vs temporary flows, account deletion/destruction, and local backup/restore.

---

## 1. Three kinds of users

### 1.0 New User has neither a cookie nor local storage on this client.
### 1.1 Local User has **no passkey** but has an **un-encrypted** local copy of temporary cloud stuff.
### 1.2 Cloud User **has passkey** registered in the cloud, and may have an **encrypted** local copy as well.

## 2. The line below the "Welcome to MAIA" title is the **User Status** line.

### 2.0 For New User it says: "Sign in with your passkey or create a new account" in black.
### 2.1 For Local User it says: "<userId> has X local files indexed to be restored. Click Get Started" in orange.
### 2.2 For Cloud User it says: "<userId> has a local backup available. Click More Choices instead of Get Started if your passkey does not work." in green. (Encryption is not implemented; the backup is stored un-encrypted—see the subsection “What is actually saved locally”.)


## 3. How MAIA uses cookies

If you are on a **private** computer and browser, MAIA uses a long-lasting cookie to sign-in and it *deletes* your private data, including your Private AI agent instructions, every time you "Sign-Out". An **un-encrypted** local copy of your account is kept by default. 

If you are on a **less-trusted** computer and browser, you must create and use a **passkey** every time you sign-in to MAIA. A cookie will be set so you do not have to re-enter your userId each time.

(Future Feature) Passkey users can choose to create an **encrypted** local backup of their MAIA in case their cloud account is deleted. This backup does not include the health records files themselves which should be backed up separately or otherwise refreshed when you restore a MAIA and create a new userId and passkey. 

<< Description of how the welcome page detects the presence of a local backup and requests a PIN for decryption.>>

---

## Implementation note: code changes to match sections 1–2

### Local storage vs cookie

- **Local storage (and IndexedDB):** Client-only. The key `maia_last_snapshot_user` in `localStorage` holds the last `userId` that saved a snapshot on this device. The snapshot itself (chats, file list, medications, patient summary, which files are indexed) lives in **IndexedDB** per userId (e.g. `maia-user-<userId>`). The server never reads this. So “local storage” here means: this device has an **un-encrypted** local copy of that user’s MAIA data (today; encrypted backup is a future feature). We detect it via `getLastSnapshotUserId()` and optionally load details with `getUserSnapshot(userId)` (e.g. to get X = number of files indexed to restore).
- **Cookie:** The server sets `maia_temp_user` when a user is created or restored in the **temporary** (no passkey) flow, and clears it on sign-out. The cookie is sent with every request so the server can say “this browser was last used by userId X” even when there is no active session. So the cookie is a **server-side identity hint** for this browser. We learn it from `GET /api/welcome-status`, which also tells us whether that user **has a passkey** (`tempCookieHasPasskey` from the user doc’s `credentialID`). So: cookie + no passkey → Local User (server “remembers” this device for that local-only account). Cookie + passkey → Cloud User (server remembers userId only; sign-in still requires passkey).

### How the code will be changed

1. **Classify the welcome state** into one of: **New User**, **Local User**, **Cloud User**.
   - **New User:** No cookie and no local storage (`!welcomeStatus.tempCookieUserId && !welcomeLocalUserId`). Same as current `isNewClient`.
   - **Local User:** Has an un-encrypted local copy and no passkey. That means: (a) we have `welcomeLocalUserId` and that user has no passkey (need `GET /api/passkey/check-user?userId=<welcomeLocalUserId>` when we only have local and no cookie), or (b) we have a cookie with `tempCookieHasPasskey === false` (and optionally local backup for the same user).
   - **Cloud User:** Has passkey. That means: cookie with `tempCookieHasPasskey === true`, or we have `welcomeLocalUserId` and passkey check returns `hasPasskey: true` (e.g. returning passkey user who also has a local snapshot; “encrypted” backup is future, but we still show the green Cloud message).

2. **User Status line (single line, replace current multi-line [AUTH] block for this behavior):**
   - **New User:** One line in **black**: “Sign in with your passkey or create a new account.” This can be the existing subtitle text; no separate status block, or a single status line in default/black.
   - **Local User:** One line in **orange**: “&lt;userId&gt; has X local files indexed to be restored. Click Get Started.” Use `welcomeLocalUserId` for userId and `welcomeLocalSnapshot.indexedCount` for X (from existing snapshot load).
   - **Cloud User:** One line in **green**: “&lt;userId&gt; has a local backup available. Click More Choices instead of Get Started if your passkey does not work.” Use cookie userId or `welcomeLocalUserId` as appropriate. No encryption is implemented; see “What is actually saved locally” in §2 Welcome page.

3. **Rename** the secondary button from “Other Account Options” to **“More Choices”** (label and dialog title).

4. **Secondary button [More Choices] – options by user type (already implemented; logic stays, naming aligned):**
   - **New User:** Sign in with passkey; BACK UP LOCALLY and DELETE CLOUD ACCOUNT (account can be recovered); DELETE ACCOUNT without LOCAL BACKUP (a new account will be needed); CANCEL.
   - **Local User** (cookie, no passkey): DELETE LOCAL STORAGE (destroys the account); CANCEL. Flow: restore session for that userId, then open Destroy Account dialog; on confirm, `POST /api/self/delete` and sign out.
   - **Cloud User** (cookie, passkey): DELETE CLOUD ACCOUNT and KEEP LOCAL BACKUP; DELETE CLOUD ACCOUNT and LOCAL BACKUP; CANCEL. First option does not require passkey in this dialog (backup then delete cloud); second requires passkey auth then full delete.

(Current code already branches the dialog on `welcomeStatus.tempCookieUserId` and `welcomeStatus.tempCookieHasPasskey` and “new client”; the only behavioral gap is classifying “Local” when we have *only* local storage and no cookie—then we must call `/api/passkey/check-user` for that `welcomeLocalUserId` to decide Local vs Cloud for the status line and copy.)

---

## 2. Welcome page: status and APIs

### 2.1 Data sources

- **Local storage:** `maia_last_snapshot_user` (set when a local snapshot is saved). Read via `getLastSnapshotUserId()`.
- **Cookie:** `maia_temp_user` — set when a temporary user is created or restored; cleared on sign-out.
- **API:** `GET /api/welcome-status` (called when welcome is shown, and after sign-out via `resetAuthState()`).

### 2.2 What is actually saved locally (implementation detail)

The app does **not** encrypt the local backup. No PIN or encryption key is set or used.

- **localStorage:** One key only: `maia_last_snapshot_user`. Its value is the **userId** of the last user who saved a snapshot on this device. Used by `getLastSnapshotUserId()` to show “this device has a backup for &lt;userId&gt;”.
- **IndexedDB (via PouchDB):** One database per user: **`maia-user-<userId>`**. Each DB holds a single snapshot document:
  - **Document id:** `user_snapshot`; **type:** `user_snapshot`.
  - **Fields:** `user` (userId, displayName, isTemporary, isAdmin), `files` (full `/api/user-files` response: file list, kbName, indexed keys), `savedChats` (from `/api/user-chats`), `currentChat`, `currentMedications`, `patientSummary`, `initialFile`, `fileStatusSummary` (per-file indexed/pending/not_in_kb), `updatedAt`.
- **When it’s written:** On sign-out, if not a shared computer and not a deep-link user, `saveLocalSnapshot()` fetches user-files, user-chats, user-status, patient-summary and writes the combined snapshot to IndexedDB, then sets `maia_last_snapshot_user` to that userId.
- **Why the status line previously said “encrypted”:** The doc and UI copy described a future encrypted backup feature; encryption has never been implemented, so the status line was updated to say “local backup” only.

### 2.3 GET /api/welcome-status

- If **session exists** (`req.session.userId`): returns `{ authenticated: true, userId, isTemporary }`. No cookie/local used.
- Else if **cookie** `maia_temp_user` is set: loads user doc, returns `{ tempCookieUserId, tempCookieHasPasskey }` (passkey = has `credentialID`). Optionally includes cloud file counts for status line.
- Else: returns `{}`.

### 2.4 Welcome status line ([AUTH])

Shown only when there is something to show:

- **A – Local storage:** “Local backup: &lt;userId&gt;” (and optionally # files indexed to restore, medications/summary verified).
- **B – Valid cookie:** “Cookie: &lt;userId&gt; (Yes with Passkey)” or “Cookie: &lt;userId&gt; (Yes, but local only)” (and optionally # files in cloud, # indexed).
- **Get Started will do:** Short line describing what the primary button will do (e.g. “Create new local-only account”, “Restore session (local only)”, “Sign in with passkey required”).

If neither A nor B, the status block is hidden.

### 2.5 New client

- **isNewClient** = no `welcomeLocalUserId` and no `welcomeStatus.tempCookieUserId`.
- New client sees: primary **[GET STARTED]** (after device privacy dialog: “Is this computer private?” → then create new local-only account), secondary **[OTHER ACCOUNT OPTIONS]** (sign in with userId + passkey, or create passkey).

---

## 3. GET STARTED and Other Account Options

### 3.1 GET STARTED

- **New client** (`isNewClient`): If device choice not resolved → show “Is this computer private to you?” (PRIVATE / SHARED). Then `startTemporarySession()` → new temp user.
- **Has local backup and/or cookie:** `startTemporarySession()`:
  - If server restores from cookie or from local userId (agent exists) → session restored; if local snapshot exists, **Restore Local Backup?** (SKIP / RESTORE).
  - If server returns `requiresPasskey: true` (cookie user has passkey) → show message and open Passkey sign-in.
- **Valid cookie (B) and user clicks GET STARTED:** Local only → start restore wizard; Passkey → ask for biometric (passkey auth).

### 3.2 More Choices dialog

The dialog title is **More Choices**. A context line under the title identifies the user type so only relevant actions are offered:

- **Cloud User (cookie + passkey):** Heading: “&lt;userId&gt; is a cloud user with a passkey.” Buttons:
  - **DELETE CLOUD ACCOUNT and KEEP LOCAL BACKUP (account can be recovered):** Closes dialog and opens Passkey sign-in. After successful passkey auth, the app saves a fresh local snapshot (`saveLocalSnapshot`), calls `POST /api/account/dormant`, then signs out. The cloud account is put dormant; the local backup remains so the user can recover later.
  - **DELETE CLOUD ACCOUNT and LOCAL BACKUP (a new account will be needed):** Closes dialog and opens Passkey sign-in. After successful passkey auth, the app calls `POST /api/self/delete` (with userId) then signs out. No local snapshot is saved first; account and local data are both gone.
  - **CANCEL:** Closes the dialog.
- **Local User (cookie, no passkey):** Heading: “&lt;userId&gt; is a local-only user (no passkey).” [DELETE LOCAL STORAGE (destroys the account)], [CANCEL]. DELETE LOCAL STORAGE: restore session for `tempCookieUserId` (`POST /api/temporary/restore`), then open Destroy Account dialog (confirm by typing userId → `POST /api/self/delete`, then sign out).
- **New client:** Heading: “No account on this device. Sign in with a passkey or manage an existing account.” Sign in with passkey; BACK UP LOCALLY and DELETE CLOUD ACCOUNT; DELETE ACCOUNT without LOCAL BACKUP; CANCEL.

---

## 4. How an anonymous user is offered a passkey

- **Welcome:** **[Get Started]** and **[Other Account Options]** (or “Use Passkey Instead” depending on copy). Other Account Options opens PasskeyAuth: “Sign in with Passkey” or “Create New Passkey.”
- **PasskeyAuth:** Sign in with Passkey → User ID → Continue → WebAuthn. Create New Passkey → User ID → check-user → register or error if already has passkey.
- **Temp user “CREATE A PASSKEY”:** Prefills userId, opens PasskeyAuth (signin or register per check-user).

**Server:** `/api/passkey/check-user?userId=...` returns `{ exists, hasPasskey, isAdminUser }`.

---

## 5. Account deletion and destruction

### 5.1 Temporary user (no passkey)

- **Sign out dialog:** **DESTROY ACCOUNT** → Destroy Account dialog (type userId) → `POST /api/self/delete` → `resetAuthState()`.
- **SIGN OUT** → save local snapshot (if not shared computer), `POST /api/sign-out`; cookie cleared; account remains for restore.
- **CREATE A PASSKEY** → upgrade to persistent.

### 5.2 User with passkey

- **Sign out:** If deep links: Dormant dialog (KEEP SERVER LIVE / GO DORMANT). Else: save snapshot, dormant, sign out.
- **Destroy:** Via Other Account Options when not signed in (DELETE CLOUD ACCOUNT and LOCAL BACKUP, etc.); when signed in, no in-app destroy in current UI (would require separate flow).

---

## 6. Local backup and restore

- **Snapshot:** Saved on sign-out (unless shared computer or deep-link). Stored in IndexedDB per userId; `maia_last_snapshot_user` points to last userId.
- **Get Started with local backup:** If `getLastSnapshotUserId()` is set, app calls `GET /api/agent-exists?userId=...`. If agent exists → `POST /api/temporary/restore` with that userId → session restored (temporary). Then **Restore Local Backup?** (SKIP / RESTORE). If agent does not exist → “Local Backup Found” / Missing agent dialog: CLEAR LOCAL STORAGE or START THE WIZARD AGAIN.
- **New session, no local:** `POST /api/temporary/start`. If cookie exists and that user has passkey, server returns `requiresPasskey: true` and app opens Passkey sign-in.

---

## 7. Auth-related modals and action buttons

| Location | Modal / dialog | Action buttons |
|----------|----------------|----------------|
| **Welcome** | Main card | **[Get Started]** – temporary/restore or new. **[Other Account Options]** – passkey sign-in/register, delete/backup options. |
| **Welcome** | [AUTH] status line | Local backup userId; Cookie userId (Passkey / Local only); what Get Started will do. |
| **Other Account Options** | (depends on cookie/new client) | Delete local storage; Delete cloud + keep local; Delete cloud + local; Sign in / Create passkey; Cancel. |
| **PasskeyAuth** | Sign in / Create passkey | User ID → Continue → WebAuthn. Back / Cancel. |
| **Device privacy** | “Is this computer private to you?” | SHARED / PRIVATE. |
| **Temp sign-out** | Sign Out (temporary user) | DESTROY ACCOUNT, SIGN OUT, CREATE A PASSKEY, CANCEL. |
| **Dormant (passkey, deep links)** | Sign Out Options | KEEP SERVER LIVE, GO DORMANT. |
| **Restore local backup** | Restore Local Backup? | SKIP, RESTORE. |
| **Missing agent** | Local Backup Found (no agent for snapshot userId) | CLEAR LOCAL STORAGE, START THE WIZARD AGAIN. |
| **Destroy account** | Destroy Account (confirm userId) | DESTROY (when input matches userId). |

---

## 8. Summary

- **Two user types:** With passkey (persistent) and without (temporary, “local only,” cookie + optional local backup).
- **Welcome:** Status line from `getLastSnapshotUserId()` + `GET /api/welcome-status` (cookie userId, passkey yes/no). GET STARTED branches on new client vs local/cookie; Other Account Options branches on cookie type (local only vs passkey) or new client.
- **Account deletion:** Temporary users can DESTROY ACCOUNT (including via “Delete local storage” from Other Account Options after restore). Passkey users: dormant/live sign-out; delete options from Other Account Options when not signed in.
- **Local data:** `maia_last_snapshot_user` + optional snapshot in IndexedDB drive restore when starting a temporary session; cookie `maia_temp_user` drives “valid cookie” on welcome.
