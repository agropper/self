# Knowledge Base Create/Update Implementation Plan

## Inventory Review

### Existing KB Automation Code
✅ **Found in `/lib/do-client/kb.js`:**
- `KbClient.create()` - Creates new KB with datasource
- `KbClient.get()` - Gets KB details by UUID
- `KbClient.update()` - Updates KB metadata
- `KbClient.list()` - Lists all KBs
- `KbClient.addDataSource()` - Adds data source to existing KB
- `KbClient.deleteDataSource()` - Removes data source from KB

✅ **Found in `/lib/do-client/indexing.js`:**
- `IndexingClient.start()` - Starts indexing job for specific data source
- `IndexingClient.startGlobal()` - Starts indexing job for multiple data sources
- `IndexingClient.getStatus()` - Gets indexing job status
- `IndexingClient.poll()` - Polls until completion with progress callback

### Current Implementation Status
📍 **Server Endpoint (`/api/update-knowledge-base`):**
- ✅ Moves files between archived and KB folders
- ✅ Updates file metadata in user document
- ✅ Tracks `kbPendingFiles` and `kbIndexingNeeded`
- ❌ **TODO:** Actually creates/updates KB via DO API
- ❌ **TODO:** Starts real indexing job
- ❌ **TODO:** Returns real job ID instead of placeholder

📍 **Status Endpoint (`/api/kb-indexing-status/:jobId`):**
- ❌ **TODO:** Queries actual DO API for job status
- ✅ Updates `kbIndexedFiles` when completed (placeholder logic)

📍 **Frontend (`MyStuffDialog.vue`):**
- ✅ Calls update endpoint
- ✅ Polls status endpoint
- ✅ Displays progress UI
- ✅ Updates `indexedFiles` after completion

### Missing Configuration
⚠️ **Need to add:**
- `DO_DATABASE_ID` environment variable (required for KB creation)
- Store `kbId` (KB UUID) in user document after creation
- Store `dataSourceUuid` in user document or KB metadata

---

## Implementation Plan

### Phase 1: KB Create/Update Endpoint (`/api/update-knowledge-base`)

#### Step 1: Check DO API to see if KB exists (by name)
- List all KBs from DO API using `doClient.kb.list()`
- Find KB by name (case-sensitive match with `userDoc.connectedKB`)
- If found → Use existing KB UUID
- If not found → Create new KB (using `DO_DATABASE_ID` from env - **DO NOT auto-create database**)
- Store `kbId` in user document for future reference

#### Step 2: Create KB (if needed)
**Required parameters:**
- `name`: `userDoc.connectedKB` (e.g., "sun10-kb-110520251200")
- `projectId`: `process.env.DO_PROJECT_ID`
- `databaseId`: `process.env.DO_DATABASE_ID` (NEW - need to add)
- `bucketName`: Extract from `process.env.DIGITALOCEAN_BUCKET`
- `itemPath`: `${userId}/${kbName}/` (path to KB folder in bucket)
- `region`: `process.env.DO_REGION || 'tor1'`

**API Call:**
```javascript
const kbResult = await doClient.kb.create({
  name: kbName,
  description: `Knowledge base for ${userId}`,
  projectId: process.env.DO_PROJECT_ID,
  databaseId: process.env.DO_DATABASE_ID,
  bucketName: bucketName,
  itemPath: `${userId}/${kbName}/`,
  region: process.env.DO_REGION || 'tor1'
});
```

**Store in user document:**
- `userDoc.kbId = kbResult.uuid`
- `userDoc.kbCreatedAt = new Date().toISOString()`

#### Step 3: Update KB Data Source (if KB exists but path changed)
**Get KB details:**
```javascript
const kbDetails = await doClient.kb.get(userDoc.kbId);
```

**Check if data source path matches:**
- KB has `datasources` array
- Each data source has `spaces_data_source.item_path`
- If path doesn't match `${userId}/${kbName}/`, update it

**Options:**
1. **Delete old data source and add new one** (if path changed)
2. **Update existing data source** (if DO API supports it)

**Preferred approach:** Delete old + add new (simpler, more reliable)

```javascript
// Delete existing data sources
for (const ds of kbDetails.datasources || []) {
  if (ds.uuid) {
    await doClient.kb.deleteDataSource(userDoc.kbId, ds.uuid);
  }
}

// Add new data source with correct path
const newDataSource = await doClient.kb.addDataSource(userDoc.kbId, {
  bucketName: bucketName,
  itemPath: `${userId}/${kbName}/`,
  region: process.env.DO_REGION || 'tor1'
});
```

#### Step 4: Start Indexing Job
**Get data source UUID:**
- From newly created KB (if created)
- Or from updated KB details (if updated)

**Start indexing:**
```javascript
const indexingJob = await doClient.indexing.start(userDoc.kbId, dataSourceUuid);
const jobId = indexingJob.uuid || indexingJob.id;
```

**Store job ID:**
- `userDoc.kbLastIndexingJobId = jobId`
- `userDoc.kbIndexingStartedAt = new Date().toISOString()`

#### Step 5: Return Response
```json
{
  "success": true,
  "message": "Knowledge base updated, indexing started",
  "jobId": "actual-job-uuid",
  "kbId": "kb-uuid",
  "filesInKB": ["path/to/file1.pdf", "path/to/file2.pdf"]
}
```

---

### Phase 2: Indexing Status Endpoint (`/api/kb-indexing-status/:jobId`)

#### Step 1: Get Job Status from DO API
```javascript
const jobStatus = await doClient.indexing.getStatus(jobId);
```

#### Step 2: Parse Status Response
**Status values:**
- `INDEX_JOB_STATUS_PENDING` - Job queued
- `INDEX_JOB_STATUS_RUNNING` - Job in progress
- `INDEX_JOB_STATUS_COMPLETED` - Job finished successfully
- `INDEX_JOB_STATUS_FAILED` - Job failed

**Extract metrics:**
- `kbName`: From KB details (if needed)
- `tokens`: From job status or KB details
- `filesIndexed`: Count files in KB folder (or from job status if available)

#### Step 3: Get KB Details (for tokens)
```javascript
const userDoc = await cloudant.getDocument('maia_users', userId);
if (userDoc.kbId) {
  const kbDetails = await doClient.kb.get(userDoc.kbId);
  const tokens = kbDetails.total_tokens || kbDetails.token_count || '0';
}
```

#### Step 4: Update Database on Completion
```javascript
if (jobStatus.status === 'INDEX_JOB_STATUS_COMPLETED') {
  userDoc.kbIndexedFiles = userDoc.kbPendingFiles;
  userDoc.kbIndexingNeeded = false;
  userDoc.kbPendingFiles = undefined;
  userDoc.kbLastIndexedAt = new Date().toISOString();
  await cloudant.saveDocument('maia_users', userDoc);
}
```

#### Step 5: Return Response
```json
{
  "success": true,
  "status": "INDEX_JOB_STATUS_RUNNING",
  "kb": "sun10-kb-110520251200",
  "tokens": "125000",
  "filesIndexed": 3,
  "completed": false,
  "progress": 0.65  // If available
}
```

---

## Milestones to Track

### Milestone 1: File Movement ✅ (Already implemented)
- **Status:** Files moved from root → archived → KB folder
- **Indicator:** Files in `${userId}/${kbName}/` folder

### Milestone 2: KB Creation/Update
- **Status:** KB exists in DO with correct data source path
- **Indicator:** `userDoc.kbId` exists and KB details retrieved
- **Display:** "KB: [KB Name]"

### Milestone 3: Indexing Job Started
- **Status:** Indexing job created and queued
- **Indicator:** `jobId` returned from API
- **Display:** "Indexing job started..."

### Milestone 4: Indexing In Progress
- **Status:** Job status = `INDEX_JOB_STATUS_RUNNING`
- **Indicator:** Polling shows running status
- **Display:** "Indexing... (X files, Y tokens)"

### Milestone 5: Indexing Complete
- **Status:** Job status = `INDEX_JOB_STATUS_COMPLETED`
- **Indicator:** `kbIndexedFiles` updated in database
- **Display:** "Indexing complete! (X files, Y tokens)"

---

## User Display in SAVED FILES Tab

### Current UI (lines 128-133 in MyStuffDialog.vue)
```vue
<div v-if="indexingKB" class="q-mt-md">
  <div class="text-body2">Indexing can take about 200 pages per minute.</div>
  <div class="text-body2 q-mt-xs">KB: {{ indexingStatus.kb || 'Processing...' }}</div>
  <div class="text-body2">Tokens: {{ indexingStatus.tokens || 'Calculating...' }}</div>
  <div class="text-body2">Files indexed: {{ indexingStatus.filesIndexed || 0 }}</div>
</div>
```

### Enhanced UI (Proposed)

#### Phase 1: File Movement (0-2 seconds)
```vue
<div v-if="indexingStatus.phase === 'moving'" class="q-mt-md">
  <q-linear-progress indeterminate color="primary" />
  <div class="text-body2 q-mt-xs">Moving files to knowledge base folder...</div>
</div>
```

#### Phase 2: KB Creation/Update (2-5 seconds)
```vue
<div v-if="indexingStatus.phase === 'kb_setup'" class="q-mt-md">
  <q-linear-progress indeterminate color="primary" />
  <div class="text-body2 q-mt-xs">{{ indexingStatus.message || 'Setting up knowledge base...' }}</div>
  <div v-if="indexingStatus.kb" class="text-caption text-grey-7">KB: {{ indexingStatus.kb }}</div>
</div>
```

#### Phase 3: Indexing Started (5-10 seconds)
```vue
<div v-if="indexingStatus.phase === 'indexing_started'" class="q-mt-md">
  <q-linear-progress indeterminate color="primary" />
  <div class="text-body2 q-mt-xs">Indexing job started...</div>
  <div class="text-caption text-grey-7">This may take several minutes</div>
</div>
```

#### Phase 4: Indexing In Progress (10+ seconds)
```vue
<div v-if="indexingStatus.phase === 'indexing'" class="q-mt-md">
  <q-linear-progress 
    :value="indexingStatus.progress || 0" 
    color="primary" 
    animated
  />
  <div class="text-body2 q-mt-xs">Indexing in progress...</div>
  <div class="text-caption text-grey-7">
    KB: {{ indexingStatus.kb }} • 
    Tokens: {{ indexingStatus.tokens || 'Calculating...' }} • 
    Files: {{ indexingStatus.filesIndexed || 0 }}
  </div>
  <div class="text-caption text-grey-6 q-mt-xs">
    Indexing can take about 200 pages per minute.
  </div>
</div>
```

#### Phase 5: Complete (Success)
```vue
<div v-if="indexingStatus.phase === 'complete'" class="q-mt-md">
  <div class="text-body2 text-positive">
    ✅ Knowledge base indexed successfully!
  </div>
  <div class="text-caption text-grey-7 q-mt-xs">
    KB: {{ indexingStatus.kb }} • 
    Tokens: {{ indexingStatus.tokens }} • 
    Files: {{ indexingStatus.filesIndexed }}
  </div>
</div>
```

#### Phase 6: Error
```vue
<div v-if="indexingStatus.phase === 'error'" class="q-mt-md">
  <div class="text-body2 text-negative">
    ❌ {{ indexingStatus.error || 'Indexing failed' }}
  </div>
</div>
```

---

## Frontend Status Object Structure

```typescript
interface IndexingStatus {
  phase: 'moving' | 'kb_setup' | 'indexing_started' | 'indexing' | 'complete' | 'error';
  message?: string;
  kb?: string;
  tokens?: string;
  filesIndexed?: number;
  progress?: number; // 0-1
  error?: string;
  jobId?: string;
}
```

---

## Backend Response Structure

### `/api/update-knowledge-base` Response
```json
{
  "success": true,
  "message": "Knowledge base updated, indexing started",
  "jobId": "abc123-uuid",
  "kbId": "kb-xyz-uuid",
  "filesInKB": ["userId/kbName/file1.pdf"],
  "phase": "indexing_started"
}
```

### `/api/kb-indexing-status/:jobId` Response
```json
{
  "success": true,
  "phase": "indexing",
  "status": "INDEX_JOB_STATUS_RUNNING",
  "kb": "sun10-kb-110520251200",
  "tokens": "125000",
  "filesIndexed": 3,
  "progress": 0.65,
  "completed": false
}
```

---

## Database Schema Updates

### User Document (`maia_users`)
```javascript
{
  userId: "sun10",
  connectedKB: "sun10-kb-110520251200",
  kbId: "abc123-def456-...",           // NEW: KB UUID from DO
  kbCreatedAt: "2025-01-10T12:00:00Z", // NEW: KB creation timestamp
  kbLastIndexingJobId: "job-xyz-...",  // NEW: Last indexing job ID
  kbIndexingStartedAt: "2025-01-10T12:05:00Z", // NEW: Last indexing start time
  kbIndexedFiles: ["path/to/file1.pdf"], // EXISTING: Files actually indexed
  kbPendingFiles: ["path/to/file1.pdf"], // EXISTING: Files queued for indexing
  kbIndexingNeeded: false,              // EXISTING: Flag for sync check
  kbLastIndexedAt: "2025-01-10T12:10:00Z" // EXISTING: Last successful index time
}
```

---

## Error Handling

### KB Creation Errors
- **Missing databaseId:** Return 500 with clear error message
- **KB name conflict:** Handle gracefully (check if KB exists with different UUID)
- **Invalid bucket path:** Validate path before creating KB

### Indexing Errors
- **Job failed:** Store error in `userDoc.kbLastIndexingError`
- **Timeout:** Mark as failed after max attempts
- **Network errors:** Retry with exponential backoff

---

## Environment Variables Required

```bash
# Existing
DO_PROJECT_ID=abc123-def456-...
DO_MODEL_ID=xyz789-...
DIGITALOCEAN_TOKEN=...
DIGITALOCEAN_BUCKET=https://maia.tor1.digitaloceanspaces.com
DO_REGION=tor1

# NEW - Required for KB creation
DO_DATABASE_ID=def456-ghi789-...
```

---

## Testing Checklist

- [ ] Create KB for new user (no existing KB)
- [ ] Update KB for existing user (KB exists, path unchanged)
- [ ] Update KB with path change (delete old data source, add new)
- [ ] Indexing job starts successfully
- [ ] Status polling shows correct phases
- [ ] Completion updates database correctly
- [ ] Error handling for missing DO_DATABASE_ID
- [ ] Error handling for indexing failures
- [ ] Frontend displays all phases correctly
- [ ] Chips update correctly after indexing completes

