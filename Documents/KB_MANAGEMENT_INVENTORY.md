# KB Management Logic Inventory

## Key Principle
**When a user deletes a file in the KB, the most important operation is to delete the data source from the KB.** The file deletion from S3 is secondary - if the data source remains, the KB will still reference a non-existent file.

---

## Operations

### Data Source Creation
- **Provisioning:** KB creation is deferred; a KB is created only when at least one file exists.
- **Add File to KB:** Creates per-file data source, stores UUID on file, marks for indexing.
- **KB Update:** Creates missing per-file data sources for files currently in the KB selection.

### Data Source Deletion
- **Remove File from KB:** Deletes per-file data source, moves file to archived, marks for re-indexing.
- **Delete File:** **CRITICAL:** Deletes data source FIRST, then deletes file from S3. If data source deletion fails, file is preserved.
- **Cleanup:** Stale/duplicate data sources are removed during KB update (not via a separate verification step).

### Indexing
- **Start:** Indexes all current data sources by request (deduped by file).
- **Polling:**
  - Backend: Polls every 30 seconds for up to 60 minutes (background automation).
  - Frontend: Polls every 10 seconds for up to 60 minutes (user-facing UI).
- **Completion:** Updates `kbIndexedFiles`, attaches KB to agent. Patient summary generation is disabled.
- **Status Detection:** When DO API reports completion, queries `listDataSources` directly to get indexed files (no delay/assumptions).

### Verification (Saved Files open)
When the SAVED FILES tab opens, the backend verifies DO KB state against the user document and
reconciles `kbIndexedFiles` / `kbIndexingNeeded` from DO as the source of truth. It logs
`[KB VERIFY]` details on mismatch and returns the reconciled state to the client so the UI
can show Update & Index correctly, even if the user document save conflicts.

---

## User Document Fields

- `kbId`: KB UUID
- `kbName`: KB name (e.g., `userId-kb-YYYYMMDDHHMMSS`)
- `files[].kbDataSourceUuid`: Per-file data source UUID (stored on each file object)
- `kbIndexedFiles`: Array of `bucketKey`s (full paths) that are indexed
- `kbPendingFiles`: Array of `bucketKey`s being indexed (cleared on completion)
- `kbChangedDataSourceUuids`: Array of data source UUIDs needing indexing
- `kbReindexAll`: Boolean flag to re-index all data sources
- `kbIndexingNeeded`: Boolean flag indicating indexing is required
- `kbLastIndexingJobId`: UUID of most recent indexing job
- `kbLastIndexedAt`: ISO timestamp of last successful indexing
- `kbIndexingDurationSeconds`: Duration of last indexing job in seconds
- `kbLastIndexingTokens`: Token count from last indexing job

---

## API Endpoints

### Knowledge Base Management
- `GET /v2/gen-ai/knowledge_bases` - List all KBs
- `GET /v2/gen-ai/knowledge_bases/{kbId}` - Get KB details
- `POST /v2/gen-ai/knowledge_bases` - Create KB (requires at least one file; datasource points to a per-file path)
- `PUT /v2/gen-ai/knowledge_bases/{kbId}` - Update KB metadata (not currently used)

### Data Source Management
- `GET /v2/gen-ai/knowledge_bases/{kbId}/data_sources` - List data sources (per-file)
- `POST /v2/gen-ai/knowledge_bases/{kbId}/data_sources` - Add per-file data source
- `DELETE /v2/gen-ai/knowledge_bases/{kbId}/data_sources/{dataSourceId}` - Delete data source

### Indexing
- `POST /v2/gen-ai/indexing_jobs` - Start global indexing (with specific data source UUIDs)
- `GET /v2/gen-ai/indexing_jobs/{jobId}` - Get indexing job status
- `GET /v2/gen-ai/knowledge_bases/{kbId}/indexing_jobs` - List indexing jobs for KB
- `DELETE /v2/gen-ai/indexing_jobs/{jobId}` - Cancel indexing job

### Key Implementation Details
- **Per-File Data Sources:** Each file in KB has its own data source (not folder-level).
- **Non-ephemeral mode:** Data source `itemPath` points directly to the file key (e.g., `userId/archived/file.pdf`).
- **Ephemeral mode:** Data source `itemPath` uses the `kb-src-<encoded>` folder path.
- **Indexing Strategy:** Index all deduped data sources by request; follow-up indexing runs only after completion if files are still missing.
- **Status Synchronization:** When completion detected, query `listDataSources` directly from DO API to get indexed files (ensures accuracy without delays).
