# KB Management Logic Inventory

## Key Principle
**When a user deletes a file in the KB, the most important operation is to delete the data source from the KB.** The file deletion from S3 is secondary - if the data source remains, the KB will still reference a non-existent file.

---

## Operations

### Data Source Creation
- **Provisioning:** KB created with empty folder (per-file data sources created when files added)
- **Add File to KB:** Creates per-file data source, stores UUID on file, marks for indexing
- **KB Update:** Creates missing per-file data sources for files in KB folder

### Data Source Deletion
- **Remove File from KB:** Deletes per-file data source, moves file to archived, marks for re-indexing
- **Delete File:** **CRITICAL:** Deletes data source FIRST, then deletes file from S3. If data source deletion fails, file is preserved.
- **Verification Cleanup:** Removes orphaned data sources (data sources pointing to missing files)

### Indexing
- **Start:** Indexes changed data sources (from `kbChangedDataSourceUuids`) or all data sources if `kbReindexAll` is true
- **Polling:** 
  - Backend: Polls every 30 seconds for up to 30 minutes (background automation)
  - Frontend: Polls every 10 seconds for up to 60 minutes (user-facing UI)
- **Completion:** Updates `kbIndexedFiles`, generates patient summary, attaches KB to agent
- **Status Detection:** When DO API reports completion, queries `listDataSources` directly to get indexed files (no delay/assumptions)

### Verification (`/api/user-files` with `verify=true`)
When SAVED FILES tab opens:
1. **Report Inconsistencies:** One message listing all mismatches between KB API, Spaces API, and UserDoc
2. **KB Cleanup:** One message reporting orphaned data source deletions/skips
3. **UserDoc Cleanup:** One message reporting `kbIndexedFiles` updates
4. **Indexing Status:** One message reporting if indexing is in progress (with jobId, files, tokens)
5. **Frontend:** Displays verification result in browser console and starts polling if indexing is in progress

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
- `POST /v2/gen-ai/knowledge_bases` - Create KB (with empty folder datasource)
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
- **Per-File Data Sources:** Each file in KB has its own data source (not folder-level)
- **Indexing Strategy:** Only index changed data sources unless `kbReindexAll` is true
- **Status Synchronization:** When completion detected, query `listDataSources` directly from DO API to get indexed files (ensures accuracy without delays)
