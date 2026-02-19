# Knowledge base and indexing

This document describes the current KB architecture, indexing state, Saved Files as source of truth, modals (discrepancy and “Index your records”), and KB behavior after account restore. It consolidates and supersedes KB_MANAGEMENT.md, KB_MANAGEMENT_INVENTORY.md, KB_AFTER_RESTORE.md, INDEXING_SAVED_FILES_SOURCE_OF_TRUTH.md, and INDEXING_AND_NEEDS_INDEXING_MODAL.md.

---

## 1. KB architecture (source of truth)

- **Single folder datasource per KB:** `userId/<kbName>/` in the bucket. KB membership is determined by object placement in that folder.
- **Indexing is KB-level** on that folder datasource (not per-file).
- **DigitalOcean API** is the authoritative backend; the server stores a canonical snapshot so the UI is consistent and does not poll DO directly from the client.

### User document fields

- **`kbId`**, **`kbName`** – KB identity and folder name.
- **`kbIndexingStatus`** – Server-canonical snapshot used by the UI (phase, jobId, tokens, filesIndexed, backendCompleted, etc.).
- **`kbIndexedBucketKeys`** – List of bucket keys that are indexed (updated when indexing completes).

### Primary endpoints

- **`GET /api/user-files`** – File list, `kbIndexedBucketKeys`, `kbIndexingStatus`, and **`indexingState`** (see §3). Optional `source=saved` or `source=wizard`; optional `subfolder` (e.g. References).
- **`POST /api/toggle-file-knowledge-base`** – Moves files between root, `userId/archived/`, and `userId/<kbName>/` (KB folder).
- **`POST /api/update-knowledge-base`** – Ensures KB exists, starts a single KB indexing job. Server-side polling (`runPoll`) persists status to `userDoc.kbIndexingStatus`. KB is attached to the agent when the agent endpoint exists and `kbIndexingStatus.backendCompleted === true`.

### DO API usage

- `doClient.kb.listDataSources(kbId)` – Find folder datasource; used for `kbIndexedDataSourceCount` and discrepancy detection.
- `doClient.indexing.startGlobal(kbId, [dataSourceId])` – Start indexing.
- `doClient.indexing.listForKB(kbId)` / status – Status polling (server-side).

---

## 2. Saved Files as source of truth for indexing

The **Saved Files** tab (My Stuff → Saved Files) is the source of truth for indexing state.

- **Display:** Each file’s “Indexed in Knowledge Base” chip is driven by whether its `bucketKey` is in **`kbIndexedBucketKeys`** (from the user document, returned by `GET /api/user-files`).
- **Same response** includes **`indexingState`** (§3). If `indexingState.discrepancy` is true, Saved Files shows a **discrepancy modal** (message + suggested fix).
- The **“Index your records”** modal and the **wizard** both derive their indexing logic from this same state so they never contradict Saved Files.

---

## 3. Indexing state from `GET /api/user-files`

The response includes **`indexingState`** (computed from user doc + DO in the same request):

- **`allKbFilesIndexed`** – `true` iff every file with `inKnowledgeBase` (bucketKey in KB folder) has `bucketKey` in `kbIndexedBucketKeys`. This is exactly the condition under which Saved Files would show **no** “To be added and indexed” for in-KB files.
- **`discrepancy`** – `true` only when the user doc has a KB (`userDoc.kbId` set), we have a definitive DO response, **and** it disagrees with the user doc:
  - User doc says indexed: `kbIndexedBucketKeys.length > 0` or `kbIndexingStatus?.backendCompleted`.
  - DO says indexed: `kbIndexedDataSourceCount > 0` (folder datasource has `last_datasource_indexing_job`).
  - If the user doc has **no** `kbId` (e.g. new or different user who has not set up a KB in their doc), we do **not** report discrepancy.
  - If DO state is unavailable (`kbIndexedDataSourceCount` is null, e.g. DO API failed), we do **not** report discrepancy.
  - If DO says 0 and the user doc says indexed, we trust the user doc and do **not** report discrepancy (eventual consistency, folder not found—e.g. after sign-in as a different user).
- When `discrepancy` is true the response also includes **`discrepancyMessage`** and **`suggestedFix`** (e.g. re-run indexing from Saved Files or refresh the page).

---

## 4. Modals

### Discrepancy modal (“Indexing state mismatch”)

- **When:** `indexingState.discrepancy === true` after loading file state.
- **Where:** (1) **Saved Files** – after `loadFiles()` in MyStuffDialog. (2) **Wizard** – when the wizard is displayed and the `user-files` response (with `source=wizard`) has `indexingState.discrepancy`.
- **Content:** Same message and suggested fix in both places (from `discrepancyMessage` and `suggestedFix`).
- **Why it could appear after sign-out/sign-in:** The modal was previously shown when the user document said “indexed” but the DO API said “not indexed” (e.g. DO returned no `last_datasource_indexing_job` or the DO call failed). That can happen if: (1) DO is temporarily unavailable so `kbIndexedDataSourceCount` stayed null and we treated it as “DO says not indexed”, or (2) DO’s folder datasource doesn’t yet have `last_datasource_indexing_job` set (eventual consistency). The logic was updated so we only report discrepancy when we have a definitive DO response, and we trust the user doc when we have a folder datasource but DO reports 0.

### “Index your records” (needs-indexing) modal

- **When:** The client fetches both `GET /api/user-files` and `GET /api/user-status`. The modal is shown **only** when:
  - `indexingState.allKbFilesIndexed === false` (Saved Files would show at least one “To be added and indexed”), and
  - `indexingState.discrepancy === false` (discrepancy is handled by the discrepancy modal), and
  - `hasAgent && fileCount > 0` and the usual kbStatus checks from user-status.
- So the modal **never** appears when Saved Files would show that all files that should be indexed are indexed.
- **Dismissal:** When the user clicks “NOT YET”, a session flag (`needsIndexingPromptDismissedThisSession`) is set; the modal is not shown again until the page is reloaded.

---

## 5. KB after account restore and file re-import

- **Account restored:** e.g. temporary restore via `POST /api/temporary/restore` or passkey sign-in with local snapshot restored. The app may set `rehydrationFiles` and `rehydrationActive` from the snapshot (file list, etc.). Re-imported files are uploaded to the **user root** (`userId/`) until something moves them into the KB folder.
- **KB recreated** when something calls **`/api/update-knowledge-base`** after the relevant files are in `userId/<kbName>/`. Moving files into the KB folder is done via **`POST /api/toggle-file-knowledge-base`** with `inKnowledgeBase: true`.

### Rehydration paths

| Path | Who moves files to KB folder? | Who calls update-knowledge-base? | Automatic? |
|------|-------------------------------|-----------------------------------|------------|
| **MyStuff rehydration queue** – user uploads all listed files in Saved Files | `handleStage3Index` (after last file uploaded) | `handleStage3Index` | **Yes** – when last file in queue is uploaded, `rehydration-complete` runs and `startRestoreIndexing` → `handleStage3Index` (toggle into KB, then update-knowledge-base). |
| **Wizard “Add file” only** – user adds files only via wizard | `handleStage3Index` (on “Index now”) | `handleStage3Index` (on “Index now”) | **No** – user must click “No more files to add – Index now”. |
| **MyStuff “Update knowledge base”** (non-restore) | User toggles checkboxes (toggle-file-knowledge-base) | User triggers update in Saved Files | No; manual. |

- **Failure mode:** If the user never triggers indexing (never completes rehydration in MyStuff **and** never clicks “Index now” in the wizard), the KB is not recreated and Private AI will not have the re-imported content.

---

## 6. Flow summary

1. **Upload** files to root (`userId/` or via rehydration).
2. **Toggle KB membership** via `/api/toggle-file-knowledge-base`: root → archived → KB folder.
3. **Start indexing** via `/api/update-knowledge-base` (or wizard “Index now” / automatic path after rehydration complete).
4. **Server** runs polling and persists status to `userDoc.kbIndexingStatus` and, on completion, sets `userDoc.kbIndexedBucketKeys`.
5. **Attach KB to agent** when agent endpoint exists and `kbIndexingStatus.backendCompleted === true`.
6. **UI** uses `GET /api/user-files` for file list and `indexingState`; Saved Files shows chips from `kbIndexedBucketKeys`; discrepancy and needs-indexing modals use `indexingState` as above.

---

## 7. Wizard: how files are chosen for indexing and what happens when indexing completes

### Choosing files in the wizard

- **File list:** The wizard’s “Files to be indexed” list comes from **`refreshWizardState()`**, which calls `GET /api/user-files?source=wizard`. The server returns all user files; the response is mapped into **`wizardStage3Files`** (name, bucketKey, inKnowledgeBase, isAppleHealth, pendingKbAdd). The UI shows **`stage3DisplayFiles`** (derived from that list with pending/restore state).
- **“Add a file”:** Clicking **Add a file** (or “Add file: …” during restore) runs **`handleStage3Action()`**, which sets `wizardUploadIntent` and opens the file picker (`triggerWizardFileInput()`). The user selects a file from disk.
- **After selection:** **`handleFileSelect()`** runs:
  - For a **restore** file: uploads via `uploadRestoreFile()`, then clears intent.
  - For a **normal** wizard file: stores the chosen filename in **localStorage** (`wizardKbPendingFileName-${userId}`) and sets **`stage3PendingUploadName`**, then uploads the file (PDF or text) via **`uploadPDFFile()`** or **`uploadTextFile()`**.
- **Upload path:** Upload uses **`/api/files/parse-pdf`** (PDF) or direct read + **`/api/files/upload`**, then **`/api/user-file-metadata`** to add the file to the user document. **`refreshWizardState()`** is called so the new file appears in the list. If the uploaded file matches the pending name, the client can auto-toggle it into the KB (toggle-file-knowledge-base) so it’s marked “in KB” for indexing.
- **Checkboxes:** Files already in the KB folder show as checked. The user can change membership with the checkbox, which calls **`/api/toggle-file-knowledge-base`** (same as Saved Files): that **moves** the object in the bucket (root ↔ archived ↔ `userId/<kbName>/`). No re-upload; the file is just moved into the KB folder so it will be included in the next indexing job.

So in the wizard, “choosing” a file means either (1) **adding** a new file (upload → user doc → optional auto-add to KB), or (2) **toggling** an existing file into the KB folder via the checkbox. The list is always sourced from `GET /api/user-files` and the KB folder is `userId/<kbName>/`.

### Clicking “No more files to add – Index now”

**`handleStage3Index()`** runs:

1. **Resolve names:** Uses **`overrideNames`** if provided (e.g. restore), otherwise the names from **`wizardStage3Files`**.
2. **Fetch current files:** Calls **`GET /api/user-files?source=wizard`** to get the latest file list with bucketKeys.
3. **Ensure all selected files are in the KB folder:** For each name that isn’t already `inKnowledgeBase`, it calls **`POST /api/toggle-file-knowledge-base`** with `inKnowledgeBase: true` so those files are moved into `userId/<kbName>/`.
4. **Start indexing:** Calls **`POST /api/update-knowledge-base`** with `userId`. The server ensures the KB and its folder datasource exist, starts (or reuses) a single DO indexing job, persists **`kbIndexingStatus`** (jobId, phase, etc.), and starts **server-side polling** (`runPoll` every 15s) until the job completes or times out.
5. **Frontend state:** The wizard sets **`stage3IndexingStartedAt`** (and persists it to sessionStorage for elapsed time across reloads), starts the elapsed timer, and (if the API returns a **jobId**) starts a **client-side poll** (e.g. `GET /api/user-files`) every 10s to update **`indexingStatus`** (phase, tokens, filesIndexed) and the status tip.

So the **files** are not sent again on “Index now”; they’re already in the bucket. “Index now” only ensures every file in the wizard list that should be in the KB is in the KB folder, then triggers one KB-level indexing job on that folder.

### When indexing completes (server)

- **`completeIndexing()`** (in the server’s polling loop) runs when the DO job status is completed (or inferred):
  - Updates **`userDoc.workflowStage`** if it was `'indexing'` (e.g. to `'files_archived'` or `'agent_deployed'`).
  - Computes **`kbIndexedBucketKeys`**: all **`userDoc.files`** whose **`bucketKey`** is under **`userId/<kbName>/`** (i.e. in the KB folder). That list is written to **`userDoc.kbIndexedBucketKeys`** and **`userDoc.kbIndexedAt`**.
  - Persists **`kbIndexingStatus`** with **`backendCompleted: true`**, **`phase: 'complete'`**, and final tokens/files.
  - **Attaches the KB to the agent** (DO API) if the user has an agent endpoint.
  - Runs **`cleanupEphemeralIndexing('completed')`** (ephemeral bucket cleanup if used).

So when indexing completes, **files are not moved or deleted**. They stay in **`userId/<kbName>/`**. The server simply records that **every file in that folder** is now indexed by setting **`kbIndexedBucketKeys`** to that list. The **user document** is the source of truth for “which bucket keys are indexed”; the UI (wizard and Saved Files) uses **`kbIndexedBucketKeys`** and **`kbIndexingStatus`** from **`GET /api/user-files`** to show “Indexed” and completion state.

### When indexing completes (client)

- **Wizard:** The client poll (or SSE/event, if used) sees **`kbIndexingStatus.backendCompleted === true`**. Then **`handleIndexingFinished()`** (or the polling completion path) sets **`stage3IndexingCompletedAt`**, clears the elapsed timer and sessionStorage key, updates **`indexingStatus.phase`** to `'complete'`, and calls **`refreshWizardState()`**. The wizard then shows the “Create and Verify your Patient Summary” (or Medications) step; the “Files to be indexed” list still shows the same files, now reflected as indexed in **`kbIndexedBucketKeys`**.
- **Saved Files:** Uses the same **`GET /api/user-files`** response; the “Indexed in Knowledge Base” chip is driven by **`kbIndexedBucketKeys`**. So once the server has set **`kbIndexedBucketKeys`** and **`backendCompleted`**, both the wizard and Saved Files show completion and indexed state without moving or re-uploading any files.

**Summary:** Wizard files are uploaded and/or toggled into the KB folder; “Index now” only ensures KB membership and starts one indexing job. When indexing completes, the server writes **`kbIndexedBucketKeys`** and **`backendCompleted`**; files stay in the KB folder and are not moved or removed.

---

## 8. Future simplifications and refactors

- **Single “indexing state” endpoint (optional):** If other callers only need `indexingState` (allKbFilesIndexed, discrepancy, message, fix) and not the full file list, a lightweight `GET /api/indexing-state?userId=...` could return just that. Today everything goes through `GET /api/user-files`, which is fine; a separate endpoint would only be useful if we want to avoid transferring the file list when only state is needed.
- **Deduplicate discrepancy modal copy:** The same “Indexing state mismatch” dialog (message + suggested fix + OK) exists in MyStuffDialog and ChatInterface. Could be one shared component (e.g. a small composable or a shared dialog component) to avoid drift.
- **`/api/user-status` and `hasFilesInKB`:** user-status still computes `hasFilesInKB` (DO + user-doc fallback) for backward compatibility and for kbStatus. The needs-indexing modal no longer relies on that alone; it uses `indexingState` from user-files. We could document that user-status is for general “has this user got a working KB?” and that “should we show the needs-indexing modal?” is decided only via user-files + indexingState. No code change required unless we later simplify user-status to drop hasFilesInKB if nothing else needs it.
- **Rehydration and wizard:** The two paths (MyStuff rehydration complete vs wizard “Index now”) both end up in `handleStage3Index`. Keeping one clear “trigger indexing after restore” path (e.g. always go through one function that checks rehydration vs wizard state) could make the flow easier to follow and test.
- **Docs:** The five original documents can be retired or replaced with a short pointer to this file once this doc is the single reference.
