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
