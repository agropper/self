# Knowledge base after account restore and file re-import

This document explains **whether and how** the knowledge base (KB) is recreated after an account is restored and files are re-imported (rehydration). It is based on a trace through the code.

---

## Short answer

- **Rehydration via MyStuff (Saved Files)**: When the user uploads **all** rehydration files in the **MyStuff** rehydration queue, the app **automatically** creates the KB and starts indexing. No wizard button click is required.
- **Rehydration via wizard only**: If the user adds files only via the **wizard** “Add file” flow, the KB is **not** created until they click **“No more files to add – Index now”** in the wizard. So in this path the wizard is required.
- **Failure mode**: If the user never triggers indexing (never finishes rehydration in MyStuff, and never clicks “Index now” in the wizard), the KB is never recreated and Private AI will not have the files in its knowledge base.

---

## 1. What “account restored” and “files re-imported” mean

- **Account restored**: Either (a) temporary restore via `POST /api/temporary/restore` (same `userId`, session as temporary), or (b) passkey sign-in after which a local snapshot was restored. In both cases the app may set `rehydrationFiles` and `rehydrationActive` from the snapshot (chats, file list, medications, summary). The snapshot includes a **file list** (and optionally `fileStatusSummary` with `bucketKey`, `fileName`, `chipStatus`, `kbName`).
- **Files re-imported (rehydration)**: The user puts files **back into the bucket** by uploading them again. There are two UI paths:
  1. **MyStuffDialog** “rehydration queue”: list of files to re-upload one by one; each upload goes to `POST /api/files/upload` (default user root folder `userId/`).
  2. **Wizard** (setup dialog): “Add file: &lt;name&gt;” uses `uploadRestoreFile` → `POST /api/files/upload` (also user root). So in both paths, re-imported files land in the **user root** (`userId/`), not in the KB folder (`userId/kbName/`) until something moves them.

So after re-import, files are in the user’s root folder. The KB is a separate DigitalOcean resource (and a folder `userId/kbName/` in the bucket). Recreating the KB means: ensure a KB exists, ensure files are in `userId/kbName/`, then run indexing. That is done by **`/api/update-knowledge-base`** (and, before that, moving files via `/api/toggle-file-knowledge-base` when using the wizard flow).

---

## 2. How the KB gets recreated (server)

- **`POST /api/update-knowledge-base`** (in `server/index.js`):
  - Reads `userDoc`, resolves **`kbName`** (e.g. via `ensureKBNameOnUserDoc` / `getKBNameFromUserDoc`).
  - Determines which files are in the KB folder `userId/kbName/` (from user doc and/or bucket listing).
  - If no KB exists for that name, **creates** it (DO API) with a datasource on that folder; if it exists, reuses it.
  - Starts an **indexing job** for that KB and returns `jobId` (and related state).
- Files must be **in** the KB folder before indexing. Moving a file into the KB folder is done by **`POST /api/toggle-file-knowledge-base`** with `inKnowledgeBase: true` (and the file’s `bucketKey`).

So: **KB is recreated** when something calls `/api/update-knowledge-base` **after** the relevant files are in `userId/kbName/`. The app does **not** create a KB on every upload; it only does so when the user (or the automatic flow below) triggers “update knowledge base” / “Index now”.

---

## 3. Automatic path: rehydration completed in MyStuff

1. User restores account and chooses “Restore” on the local backup dialog → `rehydrationFiles` and `rehydrationActive` are set, wizard may open.
2. User opens **MyStuff** (Saved Files) and uses the **rehydration queue**: they upload each listed file in order (each request → `POST /api/files/upload` → file in `userId/`).
3. When the **last** file in that queue is uploaded, MyStuffDialog sets `rehydrationRemaining.length === 0` and emits **`rehydration-complete`** with `{ hasInitialFile }`.
4. **ChatInterface** handles `rehydration-complete` in **`handleRehydrationComplete`**:
   - It sets `restoreIndexingQueued = true` and calls **`startRestoreIndexing()`**.
5. **`startRestoreIndexing`**:
   - Fetches **`/api/user-files`** to get the current list of files (with `bucketKey`).
   - Builds the list of file **names** and sets `wizardStage3Files` to those names.
   - Calls **`handleStage3Index(uniqueNames, true)`** with `fromRestore = true`.
6. **`handleStage3Index`** (wizard “Index now” logic):
   - For each file name that is **not** already `inKnowledgeBase`, calls **`/api/toggle-file-knowledge-base`** with `inKnowledgeBase: true` so the file is **moved** from root into `userId/kbName/`.
   - Then calls **`/api/update-knowledge-base`** with `userId` → server creates or reuses the KB and **starts indexing**.
   - When the server returns a `jobId`, it starts polling indexing status and, because `fromRestore` is true, emits **`rehydration-complete`** again (so the rest of the restore-complete handling runs).

So: **If the user completes all rehydration uploads in MyStuff, the KB is recreated and indexing is started automatically**; no wizard button click is required.

---

## 4. Wizard path: “Add file” then “Index now”

1. Same restore setup: `rehydrationFiles` and `rehydrationActive` set; wizard opens (because of `rehydrationActive`).
2. User uses only the **wizard**: repeatedly clicks “Add file: &lt;name&gt;” and selects the file → **`uploadRestoreFile`** runs → `POST /api/files/upload` (file in `userId/`), then **`rehydration-file-removed`** is emitted so the parent marks that file as restored in `rehydrationFiles`.
3. **MyStuff**’s rehydration queue is driven by **`props.rehydrationFiles`**; its “completed” set is updated only when **MyStuff**’s own upload handler runs. So when the user uploads only via the wizard, MyStuff never sees those as completed and **never emits `rehydration-complete`** when the last wizard upload finishes.
4. So in this path, **nothing automatically calls `startRestoreIndexing` or `handleStage3Index`**. The user must click the wizard’s **“No more files to add – Index now”** button.
5. When they do, the wizard runs the same **`handleStage3Index`** logic (with the current `wizardStage3Files` / stage 3 file list): toggle each file into the KB folder, then **`/api/update-knowledge-base`**. So **the wizard is required** in this path to recreate the KB.

So: **If the user only uses the wizard to re-import files, the KB is recreated only when they click “Index now”** in the wizard.

---

## 5. When it effectively “fails”

- The KB is **not** recreated if:
  - The user never finishes the rehydration queue in MyStuff **and** never clicks “Index now” in the wizard, or
  - The user closes the wizard and never returns to trigger indexing, or
  - Some error prevents `handleStage3Index` or `/api/update-knowledge-base` from running (e.g. missing `bucketKey`, or server error).
- In those cases, re-imported files stay in the user root folder; no KB (or an empty KB) exists, and Private AI does not have the re-imported content.

---

## 6. Summary table

| Re-import path              | Who moves files to KB folder?        | Who calls update-knowledge-base?     | Automatic?                    |
|----------------------------|--------------------------------------|--------------------------------------|--------------------------------|
| MyStuff rehydration queue  | `handleStage3Index` (after complete) | `handleStage3Index` (after complete) | Yes, when last file uploaded  |
| Wizard “Add file” only     | `handleStage3Index` (on “Index now”)  | `handleStage3Index` (on “Index now”) | No; user must click “Index now” |
| MyStuff “Update knowledge base” (non-restore) | User toggles checkboxes (toggle-file-knowledge-base) | User clicks update in MyStuff | No; manual in Saved Files     |

So: **the KB is recreated after restore and re-import** when either (1) the user completes rehydration in MyStuff (then it’s automatic), or (2) the user clicks “No more files to add – Index now” in the wizard. It is **wizard-involved** in the sense that the same Stage 3 “Index now” logic (and optionally the wizard UI) is used; it **fails** only if the user never triggers that logic.
