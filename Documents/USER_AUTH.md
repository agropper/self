# User authentication: sign-in, sign-out, and account types

This document describes the two kinds of users, how anonymous users are offered passkey creation, what happens on account deletion/destruction, and how local backup affects the welcome and restore flows. It also lists auth-related modals and considers making the welcome page responsive to stored identity so passkey users are not sent into the file-restoration wizard.

---

## 1. Two kinds of users

### 1.1 User **with** passkey (persistent account)

- **Server:** `maia_users` document has `credentialID` set; `temporaryAccount` is false (or absent).
- **Session:** After sign-in via passkey, `req.session.isTemporary` is false.
- **Sign-in:** User signs in via **Passkey** (WebAuthn). Can sign in from any device that has their passkey.
- **Sign-out:** Session and cookies are cleared. No cookie is used to “remember” the user; they must sign in again with passkey.
- **Local backup:** On “Go dormant” or “Keep server live” sign-out, the app may save a **local snapshot** (chats, file list, medications, summary) and set `localStorage` key `maia_last_snapshot_user` to that `userId`. This is used only to offer **restore** when the same user later starts a **temporary** session on the same device (see below). It does **not** by itself imply the user should use “Get Started” instead of “Sign in with Passkey.”

### 1.2 User **without** passkey (temporary / “local only” account)

- **Server:** `maia_users` document has no `credentialID`; `temporaryAccount` is true.
- **Session:** After “Get Started” or temporary restore, `req.session.isTemporary` is true.
- **Cookie:** Server sets `maia_temp_user` (httpOnly, sameSite: lax, long-lived). On sign-out the server clears this cookie.
- **Sign-in:** There is no passkey; “sign-in” is either:
  - **Get Started** → new temporary user, or
  - **Get Started** with existing local backup → **temporary/restore** (reuse same `userId` if agent still exists) then optionally **Restore Local Backup** dialog.
- **Toolbar:** Shows **“Local only user: &lt;userId&gt;”** to indicate the account is device-bound and not protected by passkey.
- **Sign-out:** Temporary sign-out dialog offers **SIGN OUT** (keep account for restore on this device), **CREATE A PASSKEY** (upgrade to persistent), or **DESTROY ACCOUNT** (permanent delete).

---

## 2. How an anonymous user is offered a passkey

- **Welcome (no deep link):** Card shows subtitle “Sign in with your passkey or create a new account” and:
  - **[Get Started]** – starts temporary flow (device privacy dialog if needed, then new temp user or restore).
  - **[Use Passkey Instead]** – opens `PasskeyAuth` with no prefill; user chooses “Sign in with Passkey” or “Create New Passkey”.
- **PasskeyAuth (choose):**
  - **Sign in with Passkey** → prompt for User ID → continue → WebAuthn authenticate → session set (persistent).
  - **Create New Passkey** → prompt for User ID → continue → check-user → if already has passkey, error “Please sign in instead”; else WebAuthn register → session set (persistent).
- **When temp user clicks “CREATE A PASSKEY” (from sign-out dialog):** App prefills `userId` and calls `/api/passkey/check-user`; if user already has passkey, prefill action is `signin`, else `register`. Passkey dialog opens; after success, user is persistent and sign-out dialog closes.
- **Server:** `/api/passkey/check-user?userId=...` returns `{ exists, hasPasskey, isAdminUser }`. Used to decide sign-in vs register and to block duplicate passkey registration.

---

## 3. What happens when a user wants to delete or destroy their account

### 3.1 Temporary user (no passkey)

- **Sign out dialog** (opened from toolbar SIGN OUT):
  - **DESTROY ACCOUNT** → opens “Destroy Account” dialog (confirm by typing `userId`) → `POST /api/self/delete` with `userId` → server deletes user data (and agent/KB per implementation) → `resetAuthState()`, session cleared.
  - **SIGN OUT** → save local snapshot (if not shared computer), `POST /api/sign-out` → session and `maia_temp_user` cookie cleared; account and agent remain for later restore on same device.
  - **CREATE A PASSKEY** → add passkey then treat as persistent; future sign-out uses dormant/live flow.

### 3.2 User with passkey (persistent)

- **Sign out** (toolbar SIGN OUT):
  - If user has deep links: **Dormant dialog** → “KEEP SERVER LIVE” (sign out, keep KB/deep links) or “GO DORMANT” (save local snapshot, `POST /api/account/dormant` to delete KB and mark dormant, then sign out).
  - If no deep links: same as “Go dormant” path (save snapshot, dormant, sign out).
- **Destroy:** There is no “Destroy account” dialog for passkey users in the current UI; account deletion would require a separate flow (e.g. settings or admin).

---

## 4. What happens when the user opens the app and local data is found

- **Source of “local data”:** `localStorage` key `maia_last_snapshot_user` is set whenever a **local snapshot** is saved (on sign-out for both temporary and passkey users, unless shared-computer mode or deep-link).
- **No session:** User is not authenticated (e.g. after sign-out). Welcome card is shown (unless deep link).

### 4.1 User clicks **Get Started**

1. **Device privacy:** If `deviceChoiceResolved` is false, **“Is this computer private to you?”** dialog is shown (PRIVATE / SHARED). SHARED shows a warning then continues.
2. **`lastSnapshotUserId = getLastSnapshotUserId()`** (from `maia_last_snapshot_user`).
3. **If `lastSnapshotUserId` is set:**
   - App calls **`GET /api/agent-exists?userId=<lastSnapshotUserId>`**.
   - **If agent exists:** App calls **`POST /api/temporary/restore`** with `{ userId: lastSnapshotUserId }`. Server does **not** check whether that user has a passkey; it restores the session as a **temporary** user (same `userId`, `isTemporary: true`). So a **passkey user** (e.g. angela94) who had signed out will be restored as “local only” and will see “Local only user: angela94” and then the **Restore Local Backup?** dialog and the **file restoration wizard**.
   - **If agent does not exist:** **“Local Backup Found” / Missing agent** dialog: “We found a local backup for &lt;userId&gt;, but no matching agent.” Options: **CLEAR LOCAL STORAGE** or **START THE WIZARD AGAIN** (new temp user).
4. **If `lastSnapshotUserId` is not set:** App creates a **new** temporary session via **`POST /api/temporary/start`**. If the server finds an existing `maia_temp_user` cookie and that user has a passkey, it returns `requiresPasskey: true` and the app shows the error and opens Passkey sign-in prefilled.
5. **After temporary session is established:** If `lastSnapshotUserId === effectiveUserId`, app loads **getUserSnapshot(lastSnapshotUserId)** and, if a snapshot exists, shows **“Restore Local Backup?”** (SKIP / RESTORE). RESTORE sets rehydration state and can trigger the setup wizard in ChatInterface.

### 4.2 Resulting bug (passkey user returns and clicks Get Started)

- Passkey user (e.g. angela94) signs out → local snapshot is saved and `maia_last_snapshot_user = angela94`.
- On return, they see [Get Started] and [Use Passkey Instead]. If they click **Get Started**, the app restores angela94 as a **temporary** user (because agent exists and `/api/temporary/restore` does not check passkey). They then see “Local only user: angela94” and the file restoration wizard instead of being guided to sign in with passkey.

---

## 5. Auth-related modals and action buttons

| Location | Modal / dialog | Action buttons |
|----------|----------------|----------------|
| **Welcome (no deep link)** | Main card | **[Get Started]** – start temporary/restore flow. **[Use Passkey Instead]** – show PasskeyAuth (sign in or create passkey). |
| **PasskeyAuth** | (inline on welcome or in dialog) | **Sign in with Passkey** → userId → **Continue** → WebAuthn. **Create New Passkey** → userId → **Continue** → WebAuthn. **Back** / **Cancel**. |
| **Device privacy** | “Is this computer private to you?” | **SHARED** / **PRIVATE**. |
| **Shared computer warning** | “Shared Computer Notice” | **OK**. |
| **Temp sign-out** | “Sign Out” (temporary user) | **DESTROY ACCOUNT**, **CANCEL**, **SIGN OUT**, **CREATE A PASSKEY**. |
| **Dormant (passkey user with deep links)** | “Sign Out Options” | **KEEP SERVER LIVE**, **GO DORMANT**. |
| **Restore local backup** | “Restore Local Backup?” | **SKIP**, **RESTORE**. |
| **Missing agent** | “Local Backup Found” (no agent for snapshot userId) | **CLEAR LOCAL STORAGE**, **START THE WIZARD AGAIN**. |
| **Destroy account** | “Destroy Account” (confirm userId) | **DESTROY** (enabled when input matches userId). |
| **Add a Passkey** (dialog for authenticated user) | “Add a Passkey” | PasskeyAuth content; **Cancel** closes. |
| **Deep link (unauthenticated)** | “Join a Shared MAIA Chat” | DeepLinkAccess (name/email, etc.). |

---

## 6. Making the welcome page responsive to stored identity

**Problem:** The welcome page always shows the same primary action **[Get Started]** and secondary **[Use Passkey Instead]**. When the device has a stored snapshot for a user who **has a passkey** (e.g. angela94), clicking “Get Started” incorrectly runs the temporary-restore flow and shows “Local only user” and the file restoration wizard.

**Recommendation:**

1. **On load (or when showing welcome),** if not authenticated and not in a deep link:
   - Read **`lastSnapshotUserId = getLastSnapshotUserId()`**.
   - If present, call **`GET /api/passkey/check-user?userId=<lastSnapshotUserId>`**.
2. **If the user exists and has a passkey:**
   - Treat this as “returning passkey user.” Prefer **Sign in with Passkey** as the primary path for that userId.
   - Options:
     - **A)** Show welcome with primary **[Sign in with Passkey]** (e.g. “Welcome back, sign in for &lt;userId&gt;”) and secondary **[Get Started]** / **[Use a different account]**.
     - **B)** Keep two buttons but swap order or label: e.g. **[Sign in with Passkey for &lt;userId&gt;]** and **[Get Started with a new or other account]**.
     - **C)** When user clicks **[Get Started]** and we have `lastSnapshotUserId` with passkey, **do not** call `/api/temporary/restore`; instead open PasskeyAuth with `prefillUserId = lastSnapshotUserId` and `prefillAction = 'signin'` (and optionally show a short message: “This device has data for &lt;userId&gt;. Sign in with your passkey to continue.”).
3. **If the user has no passkey** (or no user / no snapshot): keep current behavior: **[Get Started]** runs temporary/restore or new temp user; **[Use Passkey Instead]** for passkey sign-in or registration.

**Cookie note:** Sign-out clears `maia_temp_user`, so the only “stored identity” on the client after sign-out is **localStorage** `maia_last_snapshot_user`. Using that plus `/api/passkey/check-user` is enough to make the welcome page responsive so passkey users are not sent into the restoration wizard when they intended to sign in.

---

## 7. Summary

- **Two user types:** With passkey (persistent, sign-in via passkey) and without (temporary, “local only,” cookie + optional local backup).
- **Anonymous:** Can create passkey via “Use Passkey Instead” → Create New Passkey, or start temporary via “Get Started.”
- **Account deletion:** Temporary users can DESTROY ACCOUNT (confirm userId). Passkey users get dormant/live sign-out; no destroy in current UI.
- **Local data:** `maia_last_snapshot_user` drives “restore” when starting a temporary session; currently the app does not check passkey status for that userId, so passkey users who click “Get Started” are wrongly restored as temporary and see the file restoration wizard.
- **Fix:** Use `lastSnapshotUserId` + `/api/passkey/check-user` on welcome to prefer “Sign in with Passkey” when the stored user has a passkey, and avoid calling `/api/temporary/restore` for that userId in that case.
