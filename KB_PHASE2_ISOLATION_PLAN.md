# Phase 2 Isolation Plan

## Overview

Phase 2 of the KB update flow is currently the `/api/update-knowledge-base` endpoint (lines 2738-3260 in `server/index.js`). 

**IMPORTANT:** Files are NOT moved during Phase 2. Files are moved immediately when checkboxes are clicked via the `/api/toggle-file-knowledge-base` endpoint. By the time the UPDATE button is clicked, files are already in the correct folders.

The `/api/update-knowledge-base` endpoint currently does:
1. ~~**File Movement** (S3 operations) - Lines 2801-2844~~ **REDUNDANT - SHOULD BE REMOVED**
2. **KB Setup/Management** (DO API calls) - Lines 2854-3216
3. **User Document Update** (Database) - Lines 3218-3251

To allow testing and replacement of Phase 2 logic, we need to isolate the KB setup/management portion from the redundant file operations and database updates.

---

## Current Phase 2 Structure

### What Phase 2 Currently Does:

```
/api/update-knowledge-base endpoint:
├── Validate request (userId, changes)
├── Setup S3 client (REDUNDANT - files already moved)
├── Get user document
├── Get KB name from userDoc
├── [PHASE 2A: File Movement] ← REDUNDANT - FILES ALREADY MOVED BY CHECKBOXES
│   └── Move files between archived/ and KB folders (S3 operations)
│   └── This should be REMOVED - files are already in correct folders
│
├── [PHASE 2B: KB Setup/Management] ← THIS IS WHAT WE NEED TO ISOLATE
│   ├── Step 1: Check if KB exists in DO (lines 2854-2879)
│   ├── Step 2: Create KB if not found (lines 2881-3002)
│   ├── Step 3: Ensure data source points to correct path (lines 3004-3124)
│   └── Step 4: Start indexing job (lines 3126-3216)
│
└── [PHASE 2C: User Document Update]
    └── Update userDoc with KB info and save (lines 3218-3251)
```

### File Movement Flow (Separate from Phase 2):

```
User clicks checkbox:
└── onCheckboxChange() → /api/toggle-file-knowledge-base
    └── Immediately moves file to correct folder (archived/ or KB folder)
    └── Updates userDoc.files[].bucketKey
    └── Files are already in correct location when UPDATE button is clicked
```

---

## Isolation Strategy

### Goal

Extract Phase 2B (KB Setup/Management) into a separate, testable function that can be replaced with new logic while keeping Phase 2A (file moves) and Phase 2C (user doc updates) unchanged.

### Proposed Structure

```javascript
// New function to isolate KB setup logic
async function setupKnowledgeBase(userId, kbName, filesInKB, bucketName) {
  // This function will contain ONLY the KB setup/management logic
  // It should:
  // 1. Check if KB exists in DO
  // 2. Create KB if needed
  // 3. Ensure data source is correct
  // 4. Start indexing job (or find existing one)
  // 5. Return: { kbId, dataSourceUuid, jobId, kbDetails }
  
  // This is the function we'll replace with new logic
}

// Updated endpoint structure
app.post('/api/update-knowledge-base', async (req, res) => {
  // Get user document (files already moved by checkboxes)
  const userDoc = await cloudant.getDocument('maia_users', userId);
  const kbName = getKBNameFromUserDoc(userDoc, userId);
  
  // Get list of files currently in KB folder (files already moved by checkboxes)
  const filesInKB = userDoc.files
    .filter(file => file.bucketKey && file.bucketKey.startsWith(`${userId}/${kbName}/`))
    .map(file => file.bucketKey);
  
  // Phase 2B: KB Setup (call isolated function)
  const kbSetupResult = await setupKnowledgeBase(userId, kbName, filesInKB, bucketName);
  
  // Phase 2C: User Document Update (keep as-is)
  // ... update userDoc with kbSetupResult ...
});
```

---

## Detailed Isolation Plan

### Step 1: Remove Redundant File Movement Logic

**REMOVE** lines 2762-2844 (S3 client setup and file movement logic) from `/api/update-knowledge-base` endpoint.

Files are already moved by `/api/toggle-file-knowledge-base` when checkboxes are clicked. The endpoint should:
1. Get user document
2. Get KB name
3. Get list of files in KB folder (from `userDoc.files` - already updated by checkbox toggles)
4. Proceed to KB setup

### Step 2: Extract KB Setup Function

Create a new function `setupKnowledgeBase()` that takes:
- `userId` (string)
- `kbName` (string) - from `getKBNameFromUserDoc()`
- `filesInKB` (array) - list of bucketKeys in KB folder (files already moved)
- `bucketName` (string) - for data source path

Returns:
- `{ kbId, dataSourceUuid, jobId, kbDetails, error }`

This function will contain lines 2854-3216 (Steps 1-4) with minimal changes.

### Step 3: Identify Dependencies

The KB setup logic currently depends on:
- `doClient.kb.list()` - List KBs
- `doClient.kb.get(kbId)` - Get KB details
- `doClient.kb.create(options)` - Create KB
- `doClient.kb.deleteDataSource(kbId, dsId)` - Delete data source
- `doClient.kb.addDataSource(kbId, options)` - Add data source
- `doClient.indexing.startGlobal(kbId, dataSourceUuid)` - Start indexing
- `doClient.indexing.getStatus(jobId)` - Get job status
- `doClient.agent.list()` - Get agents (for project ID fallback)
- `doClient.agent.get(agentId)` - Get agent details (for project ID fallback)
- Environment variables: `DO_PROJECT_ID`, `DO_DATABASE_ID`, `DO_REGION`
- User document: for `kbLastIndexingJobId` (when handling "already running")

### Step 3: Handle "Already Running" Error

Currently, when indexing is already running, the code:
1. Checks `userDoc.kbLastIndexingJobId` (requires user document)
2. Tries to get job status for that ID
3. If not found, tries to get KB details (doesn't work - KB details don't contain job ID)
4. Returns error if no job ID found

**Issue:** The function needs access to `userDoc.kbLastIndexingJobId` to handle this case.

**Solution Options:**
- Option A: Pass `userDoc.kbLastIndexingJobId` as a parameter to `setupKnowledgeBase()`
- Option B: Have `setupKnowledgeBase()` fetch the user document itself (adds dependency)
- Option C: Use `GET /v2/gen-ai/knowledge_bases/{kbId}/indexing_jobs` to find active job (NEW - not currently implemented)

**Recommendation:** Use Option C (implement the missing API call) as this is the proper solution.

### Step 4: Implement Missing API Call

**Add to `lib/do-client/indexing.js`:**
```javascript
/**
 * List indexing jobs for a knowledge base
 */
async listForKB(kbId) {
  const response = await this.client.request(`/v2/gen-ai/knowledge_bases/${kbId}/indexing_jobs`);
  return response.indexing_jobs || response.data?.indexing_jobs || [];
}
```

**Use in `setupKnowledgeBase()`:**
- When "already running" error occurs, call `doClient.indexing.listForKB(kbId)`
- Find job with status `INDEX_JOB_STATUS_PENDING` or `INDEX_JOB_STATUS_RUNNING`
- Use that job ID for monitoring

### Step 5: Remove Redundant File Movement Logic

**REMOVE** file movement logic from `/api/update-knowledge-base`:
- Lines 2762-2844 should be **DELETED**
- Files are already moved by `/api/toggle-file-knowledge-base` when checkboxes are clicked
- The endpoint should only get the list of files from `userDoc.files` (already updated)

### Step 6: Extract User Document Update Logic

Keep user document update (Phase 2C) in the main endpoint:
- Lines 3218-3251 can stay as-is
- Takes `kbSetupResult` from `setupKnowledgeBase()` and updates userDoc

---

## Implementation Steps

### Step 1: Create `setupKnowledgeBase()` Function

**Location:** `server/index.js` (before the `/api/update-knowledge-base` endpoint)

**Function Signature:**
```javascript
/**
 * Setup knowledge base in DigitalOcean
 * 
 * @param {string} userId - User ID
 * @param {string} kbName - KB name (permanent, from userDoc.kbName)
 * @param {string[]} filesInKB - Array of bucketKeys in KB folder
 * @param {string} bucketName - S3 bucket name
 * @param {string|null} existingJobId - Existing indexing job ID from userDoc (if any)
 * @returns {Promise<{kbId: string, dataSourceUuid: string, jobId: string, kbDetails: object}|{error: string}>}
 */
async function setupKnowledgeBase(userId, kbName, filesInKB, bucketName, existingJobId = null) {
  // Implementation here
}
```

### Step 2: Implement Missing API Call

**Add to `lib/do-client/indexing.js`:**
```javascript
/**
 * List indexing jobs for a knowledge base
 */
async listForKB(kbId) {
  const response = await this.client.request(`/v2/gen-ai/knowledge_bases/${kbId}/indexing_jobs`);
  return response.indexing_jobs || response.data?.indexing_jobs || [];
}
```

**Use in `setupKnowledgeBase()`:**
- When "already running" error occurs, call `doClient.indexing.listForKB(kbId)`
- Find job with status `INDEX_JOB_STATUS_PENDING` or `INDEX_JOB_STATUS_RUNNING`
- Use that job ID for monitoring

### Step 7: Update `/api/update-knowledge-base` Endpoint

**New Structure:**
```javascript
app.post('/api/update-knowledge-base', async (req, res) => {
  try {
    const { userId } = req.body; // No longer need 'changes' array
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }
    
    // Get user document (files already moved by checkboxes)
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }
    
    // Get KB name from user document
    const kbName = getKBNameFromUserDoc(userDoc, userId);
    
    // Get bucket name for data source path
    const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
    if (!bucketUrl) {
      return res.status(500).json({
        success: false,
        error: 'BUCKET_NOT_CONFIGURED',
        message: 'DigitalOcean bucket not configured'
      });
    }
    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
    
    // Get list of files currently in KB folder (files already moved by checkboxes)
    const filesInKB = userDoc.files
      .filter(file => file.bucketKey && file.bucketKey.startsWith(`${userId}/${kbName}/`))
      .map(file => file.bucketKey);
    
    // ===== PHASE 2B: KB Setup (ISOLATED) =====
    const kbSetupResult = await setupKnowledgeBase(
      userId,
      kbName,
      filesInKB,
      bucketName,
      userDoc.kbLastIndexingJobId // Pass existing job ID if available
    );
    
    if (kbSetupResult.error) {
      return res.status(400).json({
        success: false,
        error: kbSetupResult.error,
        message: kbSetupResult.message
      });
    }
    
    const { kbId, dataSourceUuid, jobId, kbDetails } = kbSetupResult;
    
    // ===== PHASE 2C: User Document Update =====
    userDoc.kbId = kbId;
    userDoc.kbIndexingNeeded = true;
    userDoc.kbPendingFiles = filesInKB;
    userDoc.kbLastIndexingJobId = jobId;
    userDoc.kbIndexingStartedAt = new Date().toISOString();
    
    // KB now exists in DO - update connectedKBs array
    if (!userDoc.connectedKBs || !Array.isArray(userDoc.connectedKBs)) {
      userDoc.connectedKBs = [];
    }
    if (!userDoc.connectedKBs.includes(kbName)) {
      userDoc.connectedKBs.push(kbName);
    }
    userDoc.connectedKB = kbName; // Legacy field
    
    await cloudant.saveDocument('maia_users', userDoc);
    
    res.json({
      success: true,
      message: 'Knowledge base updated, indexing started',
      jobId: jobId,
      kbId: kbId,
      filesInKB: filesInKB,
      phase: 'indexing_started'
    });
  } catch (error) {
    // ... error handling ...
  }
});
```

### Step 4: Testing Strategy

**Using RESET KB Button:**

1. **Setup:** User has files in KB folder, KB exists in DO
2. **Reset:** Click [RESET KB] button → clears all KB fields except `kbName`
3. **Test:** Click [UPDATE AND INDEX] → calls `setupKnowledgeBase()` with fresh state
4. **Verify:** Check that KB setup logic works correctly
5. **Repeat:** Reset and test again with different scenarios

**Test Scenarios:**

- **Scenario 1:** KB doesn't exist in DO → should create new KB
- **Scenario 2:** KB exists but no datasource → should add datasource
- **Scenario 3:** KB exists with datasource but path wrong → should update datasource
- **Scenario 4:** KB exists, indexing already running → should find existing job ID
- **Scenario 5:** KB exists, indexing not running → should start new indexing

---

## Benefits of Isolation

1. **Testability:** Can test KB setup logic independently of file operations
2. **Replaceability:** Can replace `setupKnowledgeBase()` function with new implementation
3. **Debuggability:** Easier to debug KB setup issues when isolated
4. **Reusability:** KB setup logic can be reused in other contexts
5. **Maintainability:** Clear separation of concerns
6. **Correctness:** Removes redundant file-moving logic that's already handled by checkboxes

---

## Next Steps

1. ✅ Add RESET KB button (DONE)
2. ✅ Create `/api/reset-kb` endpoint (DONE)
3. **Remove redundant file-moving logic** from `/api/update-knowledge-base` (lines 2762-2844)
4. **Update frontend** to not send `changes` array (or make it optional)
5. Implement `listForKB()` method in `lib/do-client/indexing.js`
6. Extract `setupKnowledgeBase()` function from current endpoint
7. Update `/api/update-knowledge-base` to use `setupKnowledgeBase()` (without file moves)
8. Test with RESET KB button
9. Replace `setupKnowledgeBase()` with new, cleaner implementation

---

## Notes

- The RESET KB button allows rapid testing by clearing KB state without deleting files
- The isolation makes it clear what needs to be replaced (Phase 2B) vs what stays (Phase 2A, 2C)
- The new `setupKnowledgeBase()` function should handle all KB-related DO API calls
- Error handling should be consistent - return error objects instead of throwing (for better control flow)


----- After KB RESET -----
{
  "_id": "sun17",
  "_rev": "17-98855e8a1f405cd24aaa7a6e73a620c2",
  "userId": "sun17",
  "displayName": "sun17",
  "email": null,
  "domain": "localhost",
  "type": "user",
  "workflowStage": "files_stored",
  "createdAt": "2025-11-06T01:29:43.246Z",
  "updatedAt": "2025-11-06T01:32:10.141Z",
  "credentialID": "GEk6LZZcYPjW-89_930jgXkHPRY",
  "credentialPublicKey": "pQECAyYgASFYICUPq000U1ubGRHLcUQ7_vLpb6RsEIhS23qyIZAQCrukIlgg-jSYomhRsbWGnIncXA8u-fqnTc7sWQ8rFIXC9YFFy5o",
  "counter": 0,
  "transports": [
    "hybrid",
    "internal"
  ],
  "kbName": "sun17-kb-20251106728986",
  "assignedAgentId": "26018d69-bab0-11f0-b074-4e013e2ddde4",
  "assignedAgentName": "sun17-agent-20251106",
  "agentEndpoint": "https://d2o23endthtbew6yvfg5hkfx.agents.do-ai.run/api/v1",
  "agentModelName": "openai-gpt-oss-120b",
  "agentApiKey": "FOZJPSZ7QCJ2MrpTTLQnV-FXnT3P0f8w",
  "provisioned": true,
  "provisionedAt": "2025-11-06T01:32:10.097Z",
  "files": [
    {
      "fileName": "GROPPER_ADRIAN_09_24_25_1314-1.PDF",
      "bucketKey": "sun17/sun17-kb-20251106728986/GROPPER_ADRIAN_09_24_25_1314-1.PDF",
      "bucketPath": "sun17/",
      "fileSize": 6348874,
      "fileType": "pdf",
      "uploadedAt": "2025-11-06T01:45:14.302Z",
      "knowledgeBases": [
        "sun17-kb-20251106728986"
      ],
      "addedAt": "2025-11-06T01:45:14.540Z",
      "updatedAt": "2025-11-06T01:45:43.906Z"
    },
    {
      "fileName": "GROPPER_ADRIAN_09_24_25_1336-3.PDF",
      "bucketKey": "sun17/sun17-kb-20251106728986/GROPPER_ADRIAN_09_24_25_1336-3.PDF",
      "bucketPath": "sun17/",
      "fileSize": 1754400,
      "fileType": "pdf",
      "uploadedAt": "2025-11-06T01:45:24.049Z",
      "knowledgeBases": [
        "sun17-kb-20251106728986"
      ],
      "addedAt": "2025-11-06T01:45:24.322Z",
      "updatedAt": "2025-11-06T01:45:45.793Z"
    }
  ],
  "kbId": null,
  "connectedKBs": [],
  "connectedKB": null,
  "kbIndexingNeeded": true,
  "kbPendingFiles": [],
  "kbLastIndexingJobId": null,
  "kbIndexedFiles": [],
  "kbIndexingStartedAt": null,
  "kbCreatedAt": null,
  "kbLastIndexedAt": null
}

------