## KB Management Source of Truth

This document defines how KB (knowledge base) state is derived and enforced.
The DigitalOcean (DO) API must be the source of truth for KB management,
except when a value cannot be obtained or represented without persisting
in the user document.

This replaces prior guidance that used the user document as the primary
state holder for indexing, data sources, and completion.

---

## Goals

1. Use DO API as the source of truth for:
   - KB existence and identity
   - Data sources and their paths
   - Indexing jobs and job status
   - Indexed file counts and token totals
   - Completion vs in-progress state

2. Eliminate reliance on current user document state for KB management.
   - Do not use user doc fields for KB indexing or status decisions.
   - Use DO API as the single source of truth.

3. Use the same KB management path whether:
   - Stage 2 is skipped
   - Stage 2 is completed
   - KB is managed from the Saved Files tab

4. Avoid queued or chained indexing jobs:
   - Prevent file movement into/out of the KB folder
     while indexing is active

---

## DO API as Source of Truth

### Canonical KB State (from DO API)

The following are the canonical indicators and should be read from DO API
for all UI and workflow decisions:

- **KB exists**: `doClient.kb.get(kbId)` succeeds
- **KB data sources**: `doClient.kb.listDataSources(kbId)`
- **KB folder data source**: locate data source by `item_path`
- **Indexing jobs**: `doClient.indexing.listForKB(kbId)`
- **Job status**: `doClient.indexing.getStatus(jobId)` or job entry status
- **Completion**: job status == COMPLETED / NO_CHANGES
- **Token totals**: `kb.total_tokens` (DO KB details)
- **Indexed file count**:
  - Use job progress for the single KB folder data source

### State Derivation Rules

- The UI must treat `DO API status` as primary.
- Do not use the user document for KB state, even as fallback.
- Do not infer indexing state from `workflowStage` or other user doc flags.

---

## User Document Usage

The user document must not be used for KB state, indexing status, or
completion logic. The only acceptable uses are non-KB UI fields and
authentication/session context. Any KB-related fields in the user doc
must be ignored and should be removed from the code path.

---

## Unified KB Management Path

All of the following flows must use the same internal orchestration:

1. Stage 2 skipped
2. Stage 2 completed (Apple Health import)
3. Saved Files tab / KB update

### Unified Flow

1. **Resolve KB identity**
   - Use DO API to resolve the KB and its folder path
   - Do not depend on user doc fields for KB identity

2. **Resolve KB data source**
   - Use single bucket folder data source
   - Confirm the data source path matches `${userId}/${kbName}/`

3. **Validate file movements**
   - Before moving files into KB folder:
     - Check DO API for active indexing job
     - If active, prevent move and return a "Indexing In Progress" message

4. **Start indexing**
   - Call DO API to start indexing on the folder data source
   - Store job ID only in memory / session scope

5. **Poll status**
   - Poll DO API only
   - Update UI from DO job status (never user doc state)

---

## Preventing Indexing Queue/Chaining

Goal: prevent "missing files" and follow-up jobs by ensuring the KB
folder is stable during indexing.

### Approach

1. Before any file movement into or out of KB folder:
   - Check active job state (DO API)
   - If active, block the operation

2. If user tries to start indexing while a job is active:
   - Do not submit a new job
   - Return the active job status and job ID

3. UI behavior:
   - Disable "Add File" and "Index" actions while indexing active
   - Show a blocking message if a file is attempted

---

## UI State Rules

### Stage 3

- "Indexing..." only when DO API shows a running job
- "Indexing complete" only when DO API shows completed
- Do not use `kbIndexingNeeded` as a completion gate

### Stage 4

- Enabled only if Stage 3 shows DO API completion
- If DO API is unreachable, keep Stage 4 disabled and show
  "Indexing status unavailable"

---

## Transition Plan (Proposed Steps)

After review, implement in this order:

1. **Server-side DO status adapter**
   - Add a single function that returns canonical KB status
     strictly from DO API
   - Return explicit fields: `jobStatus`, `filesIndexed`, `tokens`, `isActive`

2. **Update `/api/kb-indexing-status`**
   - Make it DO-only (no user doc completion logic)
   - Fail closed if DO API is unavailable

3. **Update `/api/user-files` and `/api/user-status`**
   - Remove KB status derivation from user doc fields
   - Return DO-backed KB status only

4. **Front-end wizard changes**
   - Stage 3 status line should be driven by DO-backed status only
   - Stage 4 enablement should use DO-backed completion only

5. **File move gates**
   - Block KB folder moves while DO API shows active job
   - Provide a user-facing reason with estimated retry timing

6. **Remove legacy KB fields**
   - Delete or stop writing all KB fields in the user doc
   - Remove any code that attempts to reconcile KB state via user doc

---

## Decisions

- Manual force refresh: **No**
- DO API outage fallback: **No**
- Display active job ID to users: **No**

---

## Folder Management

### File choice → KB subfolder placement (current flow)

1. **User selects a file in the UI (Wizard Stage 3 or paperclip).**
2. **Client uploads the file** to the root bucket path:
   - `POST /api/files/upload`
   - Default target: `userId/<filename>`
3. **Client writes metadata** to the user document:
   - `POST /api/user-file-metadata`
   - Persists `fileName`, `bucketKey`, `fileSize`, `fileType`, `uploadedAt`
4. **When the user clicks Index**, the app moves the file(s) into the KB subfolder:
   - `POST /api/toggle-file-knowledge-base`
   - Move path: `userId/<filename>` → `userId/archived/<filename>` → `userId/<kbName>/<filename>`
5. **Indexing starts on the KB folder datasource**:
   - `POST /api/update-knowledge-base`
   - Starts indexing on the single KB folder data source

### DO API calls in this flow

These are the DigitalOcean API calls used to create and index the KB folder:

- **KB existence and details**
  - `doClient.kb.get(kbId)`
  - Reads: KB metadata, token totals
- **KB data sources**
  - `doClient.kb.listDataSources(kbId)`
  - Reads: data source list to locate the KB folder data source
- **Ensure folder data source**
  - `doClient.kb.createDataSource(kbId, ...)` (only if missing)
  - Writes: creates the single KB folder data source
- **Indexing jobs**
  - `doClient.indexing.listForKB(kbId)`
  - Reads: existing jobs to avoid duplicates
- **Start indexing**
  - `doClient.indexing.startGlobal(kbId, [dataSourceUuid])`
  - Writes: creates a new indexing job
- **Check status**
  - `doClient.indexing.getStatus(jobId)`
  - Reads: current job status/progress

### Database reads/writes (user document)

**Reads**
- `GET /api/user-files` → read `userDoc.files[]`
- `POST /api/update-knowledge-base` → read `userDoc.files[]` and `kbName`
- `POST /api/toggle-file-knowledge-base` → read `userDoc.files[]` and `kbName`

**Writes**
- `POST /api/user-file-metadata`
  - Insert/update `userDoc.files[]` entry for the uploaded file
- `POST /api/toggle-file-knowledge-base`
  - Update `bucketKey` when a file is moved into/out of the KB folder
- `POST /api/update-knowledge-base`
  - Updates `kbId`, `kbCreatedAt`, `connectedKBs` (attachment metadata)

### Notes

- Root folder files are not indexed.
- Only files in `userId/<kbName>/` are indexed.
- The KB folder must be populated before indexing begins.

---

## Wizard KB Build and Index (Swapped Stages)

This section describes the Wizard flow after swapping Stage 2 and Stage 3:
the KB is built and indexed first, then Current Medications (old Stage 2)
becomes the new Stage 3, followed by Patient Summary verification.

### New Wizard Order

1. **Stage 1**: Agent provisioning (unchanged)
2. **Stage 2**: Build + index the KB from all available files
3. **Stage 3**: Current Medications (Apple Health import; old Stage 2)
4. **Stage 4**: Patient Summary verify

### Stage 2: Build + Index the KB

1. **User selects files to include**
   - Any available files can be chosen (wizard or Saved Files list).
2. **Persist file metadata**
   - `POST /api/user-file-metadata` for new imports.
3. **Move files into the KB folder**
   - `POST /api/toggle-file-knowledge-base` for each selected file.
   - Moves `userId/<file>` (or `userId/archived/<file>`) to `userId/<kbName>/<file>`.
4. **Start indexing**
   - `POST /api/update-knowledge-base` triggers indexing on the KB folder datasource.
5. **Poll for completion**
   - `GET /api/kb-indexing-status/:jobId` until DO reports completed or no changes.

### Stage 3: Current Medications (Old Stage 2)

1. **User uploads Apple Health Export PDF**
2. **Parse and process**
   - `POST /api/files/parse-pdf`
   - `POST /api/files/lists/process-initial-file`
3. **Persist metadata**
   - `POST /api/user-file-metadata` (for the Apple Health file)

### Stage 4: Patient Summary

1. **Generate summary**
   - `POST /api/generate-patient-summary` (after KB indexing completes)
2. **Verify summary**
   - Save and mark as verified in the Wizard
