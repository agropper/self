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
- **`discrepancy`** – `true` when (user doc says “we have indexed data”: `kbIndexedBucketKeys.length > 0` or `kbIndexingStatus?.backendCompleted`) differs from (DO says “indexing job completed”: `kbIndexedDataSourceCount > 0` from folder datasource’s `last_datasource_indexing_job`).
- When `discrepancy` is true the response also includes **`discrepancyMessage`** and **`suggestedFix`** (e.g. re-run indexing from Saved Files or refresh the page).

---

## 4. Modals

### Discrepancy modal (“Indexing state mismatch”)

- **When:** `indexingState.discrepancy === true` after loading file state.
- **Where:** (1) **Saved Files** – after `loadFiles()` in MyStuffDialog. (2) **Wizard** – when the wizard is displayed and the `user-files` response (with `source=wizard`) has `indexingState.discrepancy`.
- **Content:** Same message and suggested fix in both places (from `discrepancyMessage` and `suggestedFix`).

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

## 7. Future simplifications and refactors

- **Single “indexing state” endpoint (optional):** If other callers only need `indexingState` (allKbFilesIndexed, discrepancy, message, fix) and not the full file list, a lightweight `GET /api/indexing-state?userId=...` could return just that. Today everything goes through `GET /api/user-files`, which is fine; a separate endpoint would only be useful if we want to avoid transferring the file list when only state is needed.
- **Deduplicate discrepancy modal copy:** The same “Indexing state mismatch” dialog (message + suggested fix + OK) exists in MyStuffDialog and ChatInterface. Could be one shared component (e.g. a small composable or a shared dialog component) to avoid drift.
- **`/api/user-status` and `hasFilesInKB`:** user-status still computes `hasFilesInKB` (DO + user-doc fallback) for backward compatibility and for kbStatus. The needs-indexing modal no longer relies on that alone; it uses `indexingState` from user-files. We could document that user-status is for general “has this user got a working KB?” and that “should we show the needs-indexing modal?” is decided only via user-files + indexingState. No code change required unless we later simplify user-status to drop hasFilesInKB if nothing else needs it.
- **Rehydration and wizard:** The two paths (MyStuff rehydration complete vs wizard “Index now”) both end up in `handleStage3Index`. Keeping one clear “trigger indexing after restore” path (e.g. always go through one function that checks rehydration vs wizard state) could make the flow easier to follow and test.
- **Docs:** The five original documents can be retired or replaced with a short pointer to this file once this doc is the single reference.
