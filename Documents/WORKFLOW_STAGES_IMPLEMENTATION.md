# Workflow Stages Implementation Guide

## Current Workflow Stage Locations

### 1. `null` - Initial state
- **Location:** `server/routes/auth.js` - User registration
- **When:** User account is created
- **Code:** Line 77: `workflowStage: null`

### 2. `request_sent` - User registration complete
- **Location:** `server/routes/auth.js` - User registration
- **When:** User registration complete, admin has been notified
- **Code:** Line 129: `updatedUser.workflowStage = 'request_sent'`

### 3. `approved` - Admin started provisioning
- **Location:** `server/index.js` - `/api/admin/provision`
- **When:** Admin clicks provision link and provisioning starts
- **Code:** Line 1102: `userDoc.workflowStage = 'approved'`

### 4. `agent_named` - Agent created
- **Location:** `server/index.js` - `provisionUserAsync()`
- **When:** After agent is successfully created in DigitalOcean
- **Code:** Line 1584: `userDoc = await updateUserDoc({ workflowStage: 'agent_named' })`

### 5. `agent_deployed` - Agent deployed and running
- **Location:** `server/index.js` - `provisionUserAsync()`
- **When:** Agent deployment reaches STATUS_RUNNING
- **Code:** Line 1642: `userDoc = await updateUserDoc({ workflowStage: 'agent_deployed' })`

### 6. `files_stored` - Files uploaded
- **Location:** `server/index.js` - `/api/user-file-metadata`
- **When:** Whenever files exist (checked on every file metadata update)
- **Code:** Line 2188: `userDoc.workflowStage = 'files_stored'` (if files.length > 0)

## New Workflow Stages to Implement

### 8. `files_archived` - User has imported at least one file
- **Location:** `server/index.js` - `/api/archive-user-files`
- **When:** After files are moved from root to archived folder
- **Tip:** "Update your knowledge base using the [Stored Files] tab."
- **Implementation:** Set `workflowStage = 'files_archived'` after successfully archiving files (line ~2324)

### 9. `indexing` - KB creation and indexing in progress
- **Location:** `server/index.js` - `/api/update-knowledge-base`
- **When:** When indexing job starts (in the polling interval)
- **Tip:** "Knowledge base being indexed. This can take up to 60 minutes."
- **Implementation:** Set `workflowStage = 'indexing'` when indexing starts (line ~2999), clear when complete
- **Note:** This is temporary - should revert to previous stage when indexing completes

### 10. `patient_summary` - Patient summary saved
- **Location:** `server/index.js` - `/api/patient-summary` and `/api/generate-patient-summary`
- **When:** After patient summary is successfully saved to user document
- **Tip:** "Your patient summary is available. Ask your agent for it in the chat anytime."
- **Implementation:** 
  - Line 3119: After saving summary in `/api/update-knowledge-base` polling
  - Line 3797: After saving summary in `/api/generate-patient-summary`
  - Line 3895: After saving summary in `/api/patient-summary`

### 11. `public_llm` - AI dropdown not set to "Private AI"
- **Location:** `src/components/ChatInterface.vue` - Frontend only (computed, not saved to DB)
- **When:** When `selectedProvider.value !== 'Private AI'`
- **Tip:** "Public AIs see only what you see in the chat, including any paperclip documents."
- **Implementation:** Check in `updateContextualTip()` function - this is UI state only

### 12. `chat_modified` - Chat save buttons are shown
- **Location:** `src/components/ChatInterface.vue` - Frontend only (computed, not saved to DB)
- **When:** When `messages.length > 0` (chat has been modified)
- **Tip:** "You can save the chat to your computer or save it online."
- **Implementation:** Check in `updateContextualTip()` function - this is UI state only

### 13. `link_stored` - Chat has been added to a group
- **Location:** `server/index.js` - `/api/save-group-chat`
- **When:** After chat is successfully saved with a shareId
- **Tip:** "Open [Saved Chats] to restore one or share a deep link."
- **Implementation:** Set `workflowStage = 'link_stored'` after successfully saving group chat (line ~1983)

## Contextual Tip Implementation

The contextual tip should be computed dynamically based on:
1. Current workflowStage (from database)
2. UI state (selectedProvider, messages.length, etc.)
3. Active operations (indexing status)

**Priority order for tip display:**
1. **Indexing status** (if active) - highest priority
2. **UI state** (public_llm, chat_modified) - if applicable
3. **WorkflowStage** (from database) - fallback

**Location:** `src/components/ChatInterface.vue` - `updateContextualTip()` function (line 1157)

**Current behavior:** Shows technical format: `Workflow: ${workflowStage}, Agent: ${hasAgent}, Files: ${fileCount}, KB: ${kbDisplay}, Chats: ${chatCount}`

**New behavior:** Should show user-friendly tips from NEW-AGENT.txt based on workflowStage and conditions.

## Tips Mapping

| WorkflowStage | Tip |
|--------------|-----|
| `request_sent` | "Support requested. You will be notified when your private AI agent is ready." |
| `agent_deployed` | "Your agent is ready. Use the paperclip to import files for your knowledge base." |
| `files_archived` | "Update your knowledge base using the [Stored Files] tab." |
| `indexing` | "Knowledge base being indexed. This can take up to 60 minutes." |
| `patient_summary` | "Your patient summary is available. Ask your agent for it in the chat anytime." |
| `public_llm` | "Public AIs see only what you see in the chat, including any paperclip documents." |
| `chat_modified` | "You can save the chat to your computer or save it online." |
| `link_stored` | "Open [Saved Chats] to restore one or share a deep link." |

## Notes

- **UI-only stages** (`public_llm`, `chat_modified`) should NOT be saved to the database
- **Temporary stages** (`indexing`) should revert to previous stage when complete
- **Contextual tip** is computed dynamically and does NOT need to be saved to the database
- The tip should prioritize active operations (indexing) over static workflow stages

