

#### null
#### has_passkey
#### request_sent
#### approved
#### agent_named
#### agent_deployed
#### files_stored
#### kb_named
#### kb_indexed
#### kb_attached
#### to_be_removed
#### passkey_reset


<<<<<<<<<<<<<<<<<>>>>>>>>>>>>>>>>>>>

## Workflow Stage Assignment Proposal

This section proposes where each `workflowStage` value should be set in the codebase to track user progress through the MAIA system.

### Implementation Principles

1. **Set stages at key milestones** - Only update when a meaningful state change occurs
2. **Use clear, descriptive logic** - Each stage should represent a specific achievement
3. **Rely on careful code placement** - No explicit stage progression protection; stages progress forward through careful code organization
4. **Handle special states** - `passkey_reset` and `to_be_removed` can override normal progression

### Stage Assignments

#### 1. `null` (Initial State)
- **Location:** `server/routes/auth.js` - `app.post('/api/passkey/register')`
- **When:** When creating a new user document (before passkey registration)
- **Logic:** Set `workflowStage: null` (or omit field) in new user document
- **Current Code:** Already sets `workflowStage: 'no_request_yet'` - **CHANGE TO:** `workflowStage: null`

#### 2. `request_sent` (replaces `has_passkey`)
- **Location:** `server/routes/auth.js` - `app.post('/api/passkey/register-verify')`
- **When:** After passkey verification (no admin email flow)
- **Logic:** Set `workflowStage: 'request_sent'` to indicate user has registered and is ready for onboarding
- **Implementation:** Set immediately after registration is verified
- **Code:** Line ~65: `updatedUser.workflowStage = 'request_sent';` before `cloudant.saveDocument`
- **Note:** `request_sent` replaces `has_passkey` immediately - there is no separate `has_passkey` stage

#### 3. `approved`
- **Location:** `server/index.js` - `app.get('/api/admin/provision')`
- **When:** When admin clicks the provision link and provisioning starts
- **Logic:** Set `workflowStage: 'approved'` when token is validated and provisioning begins
- **Implementation:** Set before starting async provisioning process
- **Code:** Line ~447: `userDoc.workflowStage = 'approved'; await cloudant.saveDocument('maia_users', userDoc);` after token validation

#### 4. `agent_named`
- **Location:** `server/index.js` - `provisionUserAsync()` function
- **When:** After agent is successfully created (has UUID and name)
- **Logic:** Set `workflowStage: 'agent_named'` after `agentClient.create()` succeeds and agent UUID is available
- **Implementation:** Set immediately after agent creation is confirmed
- **Code:** Line ~630: `userDoc.workflowStage = 'agent_named'; await cloudant.saveDocument('maia_users', userDoc);` after `updateStatus('Agent created')`

#### 5. `agent_deployed`
- **Location:** `server/index.js` - `provisionUserAsync()` function
- **When:** After agent deployment status reaches `STATUS_RUNNING`
- **Logic:** Set `workflowStage: 'agent_deployed'` when deployment status is confirmed as `STATUS_RUNNING`
- **Implementation:** Set after deployment polling loop completes successfully
- **Code:** Line ~676: `userDoc.workflowStage = 'agent_deployed'; await cloudant.saveDocument('maia_users', userDoc);` after `updateStatus('Agent deployed')`

#### 6. `files_stored`
- **Location:** `server/index.js` - `app.post('/api/user-file-metadata')`
- **When:** Whenever files exist (checked on every file metadata update)
- **Logic:** Set `workflowStage: 'files_stored'` if `userDoc.files.length > 0` (whenever files exist)
- **Implementation:** Set whenever files array has items (not just on first file)
- **Code:** Line ~1013: `if (userDoc.files.length > 0) { userDoc.workflowStage = 'files_stored'; }` before `cloudant.saveDocument`

#### 8. `kb_named`
- **Location:** TBD - Future endpoint for KB creation/naming
- **When:** When a knowledge base is created and given a name
- **Logic:** Set `workflowStage: 'kb_named'` when KB creation/naming API is implemented
- **Current Code:** Not yet implemented
- **Future:** Will be set in KB creation endpoint

#### 9. `kb_indexed`
- **Location:** TBD - Future endpoint for KB indexing
- **When:** When a knowledge base indexing process completes
- **Logic:** Set `workflowStage: 'kb_indexed'` when KB indexing API is implemented and indexing completes
- **Current Code:** Not yet implemented
- **Future:** Will be set in KB indexing endpoint or callback

#### 10. `kb_attached`
- **Location:** TBD - Future endpoint for KB attachment to agent
- **When:** When a knowledge base is successfully attached to the user's agent
- **Logic:** Set `workflowStage: 'kb_attached'` when KB attachment API is implemented
- **Current Code:** Not yet implemented
- **Future:** Will be set in KB attachment endpoint

#### 11. `to_be_removed`
- **Location:** TBD - Future endpoint for user deletion/deactivation
- **When:** When admin or system marks a user for removal
- **Logic:** Set `workflowStage: 'to_be_removed'` when user deletion/deactivation endpoint is implemented
- **Current Code:** Not yet implemented
- **Future:** Will be set in user removal/deactivation endpoint

#### 12. `passkey_reset`
- **Location:** TBD - Future endpoint for passkey reset
- **When:** During the passkey reset process (temporary 1-hour state)
- **Logic:** 
  - Set `workflowStage: 'passkey_reset'` when admin clicks reset token (allows bypassing duplicate username check)
  - Store previous `workflowStage` value before setting to `passkey_reset`
  - After successful passkey reset, revert to previous `workflowStage` value (not `has_passkey`)
- **Current Code:** Not yet implemented
- **Future:** Will be set in passkey reset endpoint
- **Duration:** 1 hour (temporary state)

---

### Stage Progression Flow

```
[New User Registration]
    ↓
null (initial)
    ↓
request_sent (passkey verified, admin notified)
    ↓
approved (admin starts provisioning)
    ↓
agent_named (agent created)
    ↓
agent_deployed (agent running)
    ↓
files_stored (files exist)
    ↓
kb_named (KB created) [Future]
    ↓
kb_indexed (KB indexed) [Future]
    ↓
kb_attached (KB attached to agent) [Future]
```

---

## New User Provisioning Flow (With Initial PDF File)

This section documents the complete automated provisioning flow for a new user who has supplied a PDF file during registration, including the Lists processing step that occurs before Patient Summary generation.

### Overview

When a user registers and uploads an initial PDF file, the provisioning process includes:
1. **Lists Processing** - Extract structured medical data (medications, clinical notes, vitals, etc.) from the PDF
2. **File Indexing** - Index the PDF into the Knowledge Base for AI retrieval
3. **Agent Creation & Deployment** - Create and deploy the Private AI agent
4. **Patient Summary Generation** - Generate the initial patient summary using the indexed data

### Detailed Step-by-Step Flow

#### Phase 1: User Registration (Before Admin Approval)

**Step 1.1: User Registration**
- Location: `server/routes/auth.js` - `app.post('/api/passkey/register-verify')`
- User completes passkey registration
- User document created with `workflowStage: null`
- Bucket folders created for user (`userId/` and `userId/KB/`)

**Step 1.2: Initial File Upload (Optional)**
- Location: `server/routes/auth.js` - `app.post('/api/auth/registration-complete')`
- If user uploads a PDF file during registration:
  - File uploaded to `userId/KB/` folder
  - File metadata stored in `userDoc.initialFile`:
    ```javascript
    {
      fileName: "example.pdf",
      bucketKey: "userId/KB/example.pdf",
      fileSize: 1234567,
      uploadedAt: "2025-12-17T..."
    }
    ```
- `workflowStage` set to `'request_sent'`
- No email notifications; user proceeds in-app

#### Phase 2: Admin Approval & Provisioning Start

**Step 2.1: Admin Clicks Provision Link**
- Location: `server/index.js` - `app.get('/api/admin/provision')`
- Admin validates provisioning token
- `workflowStage` set to `'approved'`
- Async provisioning function `provisionUserAsync()` starts

#### Phase 3: Knowledge Base Setup

**Step 3.1: Create or Verify Knowledge Base**
- Location: `server/index.js` - `provisionUserAsync()` function
- KB name retrieved from user document (set during registration)
- If KB doesn't exist:
  - Create new KB via DigitalOcean API
  - Create empty datasource pointing to `userId/KB/` folder
- If KB exists:
  - Verify KB is accessible
  - Use existing KB

**Step 3.2: Verify Initial File (if provided)**
- Location: `server/index.js` - `provisionUserAsync()` function, Step 2.5
- If `userDoc.initialFile` exists:
  - Verify file exists in S3/Spaces using `HeadObjectCommand`
  - Log file verification status
  - Continue to Lists processing

#### Phase 4: Lists Processing (NEW - Before Indexing)

**Step 4.1: Process Initial File for Lists Extraction**
- Location: `server/routes/files.js` - `app.post('/api/files/lists/process-initial-file')`
- **Triggered during provisioning** (before indexing)
- Process:
  1. Retrieve PDF from S3 using `initialFile.bucketKey`
  2. Extract text with page boundaries using `extractPdfWithPages()`
  3. Generate full markdown with page markers (`## Page nn`)
  4. Clean up markdown:
     - Remove "Health Page nn of mm" footers
     - Replace with "## Page nn" markers
     - Remove "Continued on/from" markers
     - Remove last 4 lines of markdown
  5. Save cleaned markdown to `userId/Lists/` folder as `{fileName}.md`
  6. Extract categories (Allergies, Clinical Notes, Medications, etc.)
  7. Label first `[D+P]` line in each category with category name
  8. Count observations per category
  9. Store markdown file location in user document

**Step 4.2: Lists Processing Results**
- Markdown file saved to: `userId/Lists/{fileName}.md`
- Categories extracted and structured
- Ready for display in "My Lists" tab
- **This completes before indexing starts**

#### Phase 5: File Indexing

**Step 5.1: Create or Verify Datasource**
- Location: `server/index.js` - `provisionUserAsync()` function, Step 2.5
- If datasource doesn't exist (KB was pre-existing):
  - Create datasource pointing to `initialFile.bucketKey`
  - Store `datasourceUuid` in user document
- If datasource exists (created during KB creation):
  - Use existing datasource UUID

**Step 5.2: Update User Document with File Metadata**
- Add/update file entry in `userDoc.files[]`:
  ```javascript
  {
    bucketKey: "userId/KB/example.pdf",
    fileName: "example.pdf",
    size: 1234567,
    uploadedAt: "2025-12-17T...",
    knowledgeBases: [kbName],
    kbDataSourceUuid: datasourceUuid
  }
  ```

**Step 5.3: Start Indexing Job**
- Location: `server/index.js` - `provisionUserAsync()` function
- Start global indexing job via `doClient.indexing.startGlobal(kbId, [datasourceUuid])`
- Store `indexingJobId` in user document
- Set `workflowStage: 'indexing'`

**Step 5.4: Wait for Indexing to Complete (Blocking)**
- Poll indexing job status every 15 seconds
- Maximum wait time: 30 minutes
- On completion:
  - Verify indexing via datasource status check
  - Update `userDoc.kbIndexedFiles` with indexed file
  - Store indexing metadata (tokens, duration, etc.)
  - Set `workflowStage: 'files_archived'`
- **Note**: Patient Summary generation is deferred until after agent deployment

#### Phase 6: Agent Creation & Deployment

**Step 6.1: Create Agent**
- Location: `server/index.js` - `provisionUserAsync()` function, Step 3
- Create agent via DigitalOcean API with:
  - Name from user document
  - MAIA instruction template
  - Model configuration
- Store `agentId`, `agentEndpoint`, `agentApiKey` in user document
- Set `workflowStage: 'agent_named'`

**Step 6.2: Attach Knowledge Base to Agent**
- Location: `server/index.js` - `provisionUserAsync()` function, Step 4
- Attach KB to agent via `doClient.agent.attachKB(agentId, kbId)`
- Agent can now retrieve data from KB

**Step 6.3: Wait for Agent Deployment**
- Location: `server/index.js` - `provisionUserAsync()` function, Step 5
- Poll agent status every 30 seconds
- Maximum wait time: 10 minutes
- Wait for status: `STATUS_RUNNING`
- Set `workflowStage: 'agent_deployed'`

#### Phase 7: Current Medications Generation

**Step 7.1: Generate Current Medications**
- **Status**: ✅ **IMPLEMENTED IN AUTOMATION**
- **Location**: `server/index.js` - `provisionUserAsync()` function, Step 7.5
- **Requirements**:
  - Agent must be deployed (`assignedAgentId`, `agentEndpoint`, `agentApiKey`)
  - Lists processing must be complete (markdown file exists in `userId/Lists/`)
  - Medication Records category must have observations
- **Process**:
  1. Check if Lists markdown file exists in `userId/Lists/{fileName}.md`
  2. Read markdown file from S3
  3. Extract Medication Records category boundaries
  4. Extract all `[D+P]` lines within Medication Records category
  5. Format observations for AI prompt
  6. Call Private AI agent with prompt:
     ```
     "What are the current medications from this list?
     
     [List of all medication observations]
     
     Please list only the medications that are currently active or being taken. 
     Format your response as a clear, readable list."
     ```
  7. Save result to `userDoc.currentMedications`
- **Timing**: Runs after agent deployment (Phase 6) and before Patient Summary generation
- **Error Handling**: Non-blocking - errors are logged but don't fail provisioning

**Step 7.2: Current Medications Storage**
- Stored in user document:
  ```javascript
  {
    currentMedications: "Generated medications list...",
    // No separate metadata - stored as plain string
  }
  ```
- Can be edited by user after generation
- If edited, prevents automatic refresh

#### Phase 8: Patient Summary Generation

**Step 8.1: Generate Patient Summary**
- Location: `server/index.js` - Background polling after indexing completes
- **Triggered after**: Agent is deployed AND indexing is complete
- Process:
  1. Verify agent is fully configured (`assignedAgentId`, `agentEndpoint`, `agentApiKey`)
  2. Call Private AI agent with prompt:
     ```
     "Please generate a comprehensive patient summary based on all available 
     medical records and documents in the knowledge base. Include key medical 
     history, diagnoses, medications, allergies, and important notes."
     ```
  3. Save summary to `userDoc.patientSummaries[]` array
  4. Set `workflowStage: 'patient_summary'`

**Step 8.2: Summary Storage**
- Summary stored with metadata:
  ```javascript
  {
    summary: "Generated summary text...",
    generatedAt: "2025-12-17T...",
    model: "openai-gpt-oss-120b",
    tokens: 1234
  }
  ```

### Flow Diagram

```
[User Registration with PDF]
         ↓
[File Uploaded to userId/KB/]
         ↓
[workflowStage: 'request_sent']
         ↓
[Admin Clicks Provision Link]
         ↓
[workflowStage: 'approved']
         ↓
[KB Created/Verified]
         ↓
[Lists Processing] ← NEW STEP
  • Extract PDF text
  • Generate markdown
  • Clean up markdown
  • Extract categories
  • Count observations
  • Save to userId/Lists/
         ↓
[File Indexing]
  • Create datasource
  • Start indexing job
  • Wait for completion
  • Verify indexed
         ↓
[workflowStage: 'indexing' → 'files_archived']
         ↓
[Agent Creation]
         ↓
[workflowStage: 'agent_named']
         ↓
[KB Attached to Agent]
         ↓
[Agent Deployment]
         ↓
[workflowStage: 'agent_deployed']
         ↓
[Current Medications Generation] ← NOT YET AUTOMATED
  • Read Lists markdown
  • Extract Medication Records
  • Call Private AI
  • Save to userDoc.currentMedications
         ↓
[Patient Summary Generation] ← Uses indexed data + Lists
         ↓
[workflowStage: 'patient_summary']
         ↓
[Provisioning Complete]
```

### Key Implementation Details

1. **Lists Processing Timing**: 
   - Happens **before** file indexing
   - Uses the same PDF file that will be indexed
   - Results stored separately in `userId/Lists/` folder
   - Does not block provisioning if it fails (error logged, continues)

2. **File Indexing**:
   - Happens after Lists processing
   - Indexes PDF into Knowledge Base
   - Required for Patient Summary generation
   - Blocks provisioning until complete (with timeout)

3. **Current Medications**:
   - **AUTOMATED** - Generated during provisioning after agent deployment
   - Generated **after** agent deployment (Phase 6)
   - Requires Lists processing to be complete (to extract Medication Records)
   - Uses Private AI to identify current medications from full medication list
   - Runs before Patient Summary generation
   - Can also be manually refreshed from frontend Lists tab

4. **Patient Summary**:
   - Generated **after** both Lists processing and indexing are complete
   - Requires agent to be deployed
   - Uses indexed data from Knowledge Base
   - May reference structured Lists data

4. **Error Handling**:
   - Lists processing errors are logged but don't fail provisioning
   - Indexing errors are logged but provisioning continues (background polling handles retry)
   - Agent creation/deployment errors fail provisioning
   - Patient Summary generation errors are logged but don't fail provisioning

### Files and Endpoints Involved

- **Lists Processing**: 
  - Endpoint: `POST /api/files/lists/process-initial-file`
  - Implementation: `server/routes/files.js`
  - Frontend: `src/components/Lists.vue`

- **File Indexing**:
  - Implementation: `server/index.js` - `provisionUserAsync()` function
  - Uses: DigitalOcean KB and Indexing APIs

- **Current Medications**:
  - Endpoint: `POST /api/files/lists/current-medications` (for manual generation)
  - Automation: `server/index.js` - `provisionUserAsync()` function, Step 7.5
  - Frontend: `src/components/Lists.vue` - `loadCurrentMedications()` (for manual refresh)
  - Uses: Private AI agent via DigitalOcean Provider

- **Patient Summary**:
  - Implementation: `server/index.js` - Background polling after indexing
  - Uses: Private AI agent via DigitalOcean Provider

**Special States:**
- `to_be_removed` - Can be set from any stage (user marked for deletion)
- `passkey_reset` - Temporary 1-hour state activated by admin token, allows bypassing duplicate username check, reverts to previous stage after reset

---

### Implementation Order

**Phase 1: Core Registration & Provisioning (✅ IMPLEMENTED)**
1. ✅ Update initial registration to use `null` instead of `'no_request_yet'`
2. ✅ Set `request_sent` when provision token is created (replaces `has_passkey`)
3. ✅ Set `approved` when provisioning starts
4. ✅ Set `agent_named` after agent creation
5. ✅ Set `agent_deployed` after deployment completes

**Phase 2: File Management (✅ IMPLEMENTED)**
6. ✅ Set `files_stored` whenever files exist (checked on file metadata updates)

**Phase 3: Future Features (Implement Later)**
8. `kb_named` - When KB creation is implemented
9. `kb_indexed` - When KB indexing is implemented
10. `kb_attached` - When KB attachment is implemented
11. `to_be_removed` - When user deletion is implemented
12. `passkey_reset` - When passkey reset is implemented

---

### Implementation Notes

1. **No explicit progression protection** - We rely on careful code placement to ensure stages progress forward. Each stage is set at the appropriate point in the workflow.

2. **Special states** - `to_be_removed` and `passkey_reset` can override normal progression:
   - `passkey_reset`: Temporary 1-hour state that must store previous stage and revert after reset
   - `to_be_removed`: Can be set from any stage

3. **Stage transitions** - Stages naturally progress in order:
   - `null` → `request_sent` → `approved` → `agent_named` → `agent_deployed` → `files_stored` → (future KB stages)

---

### Implementation Status

**✅ Completed (Stages 1-6):**
- ✅ `null` - Set during initial user registration
- ✅ `request_sent` - Set when provision token is created (replaces `has_passkey`)
- ✅ `approved` - Set when admin starts provisioning
- ✅ `agent_named` - Set after agent creation
- ✅ `agent_deployed` - Set when agent deployment reaches STATUS_RUNNING
- ✅ `files_stored` - Set whenever files exist

**📋 Future Implementation:**
- [ ] `kb_named` - When KB creation is implemented
- [ ] `kb_indexed` - When KB indexing is implemented
- [ ] `kb_attached` - When KB attachment is implemented
- [ ] `to_be_removed` - When user deletion is implemented
- [ ] `passkey_reset` - When passkey reset is implemented (must store/revert previous stage)

### Testing Checklist

- [x] New user registration sets `null` initially
- [x] Passkey verification sets `request_sent` (not `has_passkey`)
- [x] Admin provision click sets `approved`
- [x] Agent creation sets `agent_named`
- [x] Agent deployment sets `agent_deployed`
- [x] File upload sets `files_stored` whenever files exist
- [ ] Contextual tip displays correct workflowStage
- [ ] Future: `passkey_reset` stores and reverts previous stage correctly
