## One Bucket KB Strategy

This document describes how to safely shift Knowledge Base (KB) file management to a single Spaces bucket as the source of truth, per DigitalOcean guidance. The goal is to stop relying on per‑file datasources and to stop inferring per‑file status from the KB API, while keeping user experience consistent.

---

## Why change

DigitalOcean does not expose a public API for per‑file status, per‑file tokens, or the file list shown in the Dashboard. The recommended strategy is:

- Use **one Spaces bucket / folder** as the KB datasource.
- Add/remove files by **adding/removing objects** in that bucket.
- Trigger re‑indexing of the **whole bucket** via the Indexing Job API.
- Maintain **local app state** for the files you expect in that bucket.

---

## Target behavior (high level)

1. **KB datasource is a single folder/bucket path** (not per‑file).
2. **Files in KB** are the ones present in the KB folder/bucket.
3. Indexing jobs operate on that folder, not on individual files.
4. UI uses **local file list** (Saved Files) + indexing job status, not per‑file KB API state.

---

## Critical changes required

### 1) Datasource creation and path building

**Current behavior:**  
Per‑file datasources are created with `item_path` set to `userId/kbName/file.pdf`.

**New behavior:**  
Create **one datasource** with `item_path` set to the KB folder: `userId/kbName/`.

**Code locations:**
- `server/index.js`
  - `buildKbDataSourcePath()` and `resolveSourceKeyFromDataSourcePath()`
  - KB update flow datasource creation loop
  - Toggle‑file KB logic that creates/deletes datasources
- `lib/do-client/kb.js`
  - `addDataSource()` should accept a folder path

---

### 2) File movement rules

**Current behavior:**  
Files are moved between `userId/`, `userId/archived/`, and `userId/{kbName}/` to drive KB membership.

**New behavior (recommended):**  
Keep the KB folder as the KB source of truth and move files **only between**:

- `userId/archived/` (not in KB)
- `userId/{kbName}/` (in KB)

This keeps the bucket folder aligned with KB membership and avoids needing per‑file datasource edits.

**Code locations:**
- `server/index.js`
  - `/api/toggle-file-knowledge-base`: move archived ⇄ KB folder only
  - `/api/update-knowledge-base`: ensure KB folder has the correct set of files before indexing
  - `/api/archive-user-files`: auto‑archive root uploads
  - `/api/cancel-kb-indexing`: restore KB files to archived if cancel

**Important:**  
If you decide to eliminate movement entirely (single bucket without subfolders), you must update **all** places that assume KB membership is expressed by folder placement. The current UX relies on folder placement for “in KB” status.

---

### 3) Indexing job logic

**Current behavior:**  
Indexing jobs start on a set of per‑file datasources and status is shown per file.

**New behavior:**  
Indexing is run on **one datasource** representing the KB folder.

**Implementation changes:**
- Start indexing with the single datasource UUID (one job per KB).
- Remove loops that track/collect per‑file datasource UUIDs.
- Treat indexing status as **KB‑level**, not per‑file.

**Code locations:**
- `server/index.js`
  - KB update indexing job start logic
  - Indexing status and polling for Saved Files display

---

### 4) Saved Files / UI status

**Current behavior:**  
Saved Files shows per‑file status using `indexedFileJobInfo`, `indexedFileTokens`, and `indexedFiles`.

**New behavior:**  
Saved Files should show:
- Per‑file membership in KB based on **folder placement** (`userId/{kbName}/` vs `archived/`)
- KB‑level indexing status (one job) instead of per‑file status

**Implication:**  
Per‑file job rows should become **file metadata only**. Indexing progress should be shown in the KB summary/status area.

**Code locations:**
- `src/components/MyStuffDialog.vue`
  - `indexedFileJobInfo` display
  - KB summary line (`kbSummaryTokens`, `kbSummaryFiles`)

---

### 5) Wizard Stage 2 & Stage 3

**Current behavior:**  
Wizard uses per‑file datasources and per‑file indexing status.

**New behavior:**  
Wizard Stage 3 should only track:
- Files selected for inclusion (local state + KB folder membership)
- A single KB indexing job status

**Code locations:**
- `src/components/ChatInterface.vue`
  - `handleStage3Index`, `stage3IndexingPoll`, `wizardStage3StatusLine`
  - Restore flow triggers (rehydration)

---

## Save / Restore (rehydration) impacts

Save/Restore currently assumes per‑file datasources and uses file movement to determine KB membership.

**Required changes:**
1. **Rehydration uploads** should:
   - Restore files to the **correct folder** (`archived` vs `kbName`)
   - Update `knowledgeBases` metadata only as a local indicator (not DO datasource per file)
2. **After all files are restored**, trigger a single KB indexing job.
3. **Do not attempt to recreate per‑file datasources.**

**Code locations:**
- `src/components/MyStuffDialog.vue`
  - `handleRehydrationFileSelected` (uses `knowledgeBases`, `updateInitialFile`)
  - Rehydration completion logic
- `src/components/ChatInterface.vue`
  - Restore completion indexing trigger

---

## API changes checklist

1. **`/api/update-knowledge-base`**
   - Create or ensure a **single datasource** for `userId/{kbName}/`
   - Remove per‑file datasource creation/deletion
   - Trigger indexing for that single datasource

2. **`/api/toggle-file-knowledge-base`**
   - Only move files between archived and KB folders
   - **No datasource changes per file**

3. **`/api/user-files`**
   - Stop attempting to map per‑file token counts from DO
   - Return KB summary info based on KB folder contents
   - Return indexing status based on the **latest KB job** only

4. **`/api/cancel-kb-indexing`**
   - Only restores files to archived
   - No datasource cleanup per file

---

## Migration considerations

1. **Existing per‑file datasources**
   - Identify and remove them during the next “Update and Index KB”.
   - Create a single folder datasource afterwards.

2. **UI compatibility**
   - Stop showing per‑file job status.
   - Replace with “KB indexing in progress” summary.

3. **Token counts**
   - When per‑file counts are unavailable, use `n/a`.
   - KB total tokens should come from the KB API (if available).

---

## Summary

Moving to a single‑bucket datasource removes the need for per‑file KB API data and eliminates the current mismatch between the Dashboard and the API. It does require coordinated changes in:

- Server datasource creation
- File movement logic (KB folder is the truth)
- Indexing job handling
- UI rendering of status
- Save/Restore flows

This is the safest path to align the app with DO’s recommended architecture while preserving user control.
