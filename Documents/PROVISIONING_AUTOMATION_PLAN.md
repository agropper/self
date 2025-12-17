# Provisioning Automation Enhancement Plan

## Overview

This document outlines the modifications required to implement the complete automated provisioning flow, including Lists processing, Current Medications generation, and Patient Summary creation after user edits.

## High-Level Flow (As Specified)

1. New user creates passkey and provisional user document
2. User provides initial health record file (Apple Health "Export PDF" preferred)
3. Request email sent to administrator
4. Upon admin approval, provisioning automation starts
5. Knowledge base created from user-provided file and indexed
6. Private AI agent created and deployed - ready as chatbot
7. **Separately**, uploaded document used to create structured lists (code-based, not AI)
8. Medication Records list used by Private AI to suggest Current Medications
9. User receives email with link to edit Current Medications
10. User edits Current Medications and saves
11. Patient Summary created after Current Medications is saved

**Key Change**: Patient Summary is NO LONGER generated during provisioning - it happens after user edits Current Medications.

---

## Required Modifications

### 1. AUTOMATION.md Document Updates

**Location**: `Documents/AUTOMATION.md`

**Changes**:
- Replace the entire document with the new high-level flow description
- Update Phase 4 (Lists Processing) to show it's part of automation
- Update Phase 7 (Current Medications) to show it's automated
- **Remove** Phase 8 (Patient Summary) from provisioning flow
- Add new Phase 9: "User Email with Current Medications Link"
- Add new Phase 10: "Patient Summary Generation (After User Edits)"

**New Structure**:
```
## New User Provisioning Flow

### Phase 1: User Registration
### Phase 2: Admin Approval
### Phase 3: Knowledge Base Setup
### Phase 4: Lists Processing (AUTOMATED)
### Phase 5: File Indexing
### Phase 6: Agent Creation & Deployment
### Phase 7: Current Medications Generation (AUTOMATED)
### Phase 8: User Email with Deep Link
### Phase 9: User Edits Current Medications
### Phase 10: Patient Summary Generation (Triggered by Save)
```

---

### 2. Add Lists Processing to Provisioning Automation

**Location**: `server/index.js` - `provisionUserAsync()` function

**Current State**: Lists processing only exists as HTTP endpoint `/api/files/lists/process-initial-file`

**Required Changes**:

#### 2.1 Extract Lists Processing Logic
- **Location**: `server/routes/files.js` (lines 1633-1898)
- **Action**: Extract the core Lists processing logic into a reusable function
- **New Function**: `async function processInitialFileForLists(userId, initialFileBucketKey, initialFileName, cloudant, doClient)`
- **Returns**: `{ success: boolean, markdownBucketKey?: string, error?: string }`
- **Dependencies**: 
  - Needs S3 client (already available in provisioning context)
  - Needs `extractPdfWithPages` from `server/utils/pdf-parser.js`
  - No session/auth dependencies (takes userId directly)

#### 2.2 Integrate into Provisioning Flow
- **Location**: `server/index.js` - `provisionUserAsync()`, Step 2.5
- **Placement**: After file verification (line 3178), **BEFORE** datasource creation/indexing
- **New Step**: "Step 2.4: Process Initial File for Lists"
- **Process**:
  1. Check if `userDoc.initialFile` exists
  2. Call `processInitialFileForLists()` function
  3. Log success/failure
  4. Continue to indexing even if Lists processing fails (non-blocking)
- **Logging**: Add `[LISTS]` prefixed log messages for terminal visibility

#### 2.3 Error Handling
- Lists processing errors should be logged but not fail provisioning
- Continue to indexing step regardless of Lists processing result
- Store Lists processing status in user document (optional metadata)

---

### 3. Remove Patient Summary from Provisioning

**Location**: `server/index.js` - `provisionUserAsync()` function

**Current State**: Patient Summary is generated in Step 7.6 (lines 3923-4000+)

**Required Changes**:

#### 3.1 Remove Patient Summary Generation
- **Location**: `server/index.js`, Step 7.6 (after KB verification)
- **Action**: Remove or comment out the Patient Summary generation code block
- **Keep**: KB verification step (Step 7.5a) - this is still useful
- **Remove**: Step 7.5b (Patient Summary generation)
- **Update Comment**: Change "Step 7.6" to note that Patient Summary is generated later

#### 3.2 Update Workflow Stage
- **Current**: Sets `workflowStage: 'patient_summary'` after summary generation
- **New**: Do NOT set `patient_summary` stage during provisioning
- **New Stage**: Set `workflowStage: 'provisioned'` or `'ready'` after Current Medications is generated
- **Patient Summary Stage**: Will be set later when summary is actually generated

---

### 4. Update Email with Deep Link to Current Medications Editor

**Location**: `server/utils/email-service.js` - `sendProvisioningCompletionEmail()`

**Current State**: Email contains basic text with no actionable links

**Required Changes**:

#### 4.1 Generate Deep Link Token
- **New Function**: `generateCurrentMedicationsToken(userId)` in `email-service.js`
- **Purpose**: Create a secure, time-limited token for accessing Current Medications editor
- **Storage**: Store token in user document: `userDoc.currentMedicationsToken` and `userDoc.currentMedicationsTokenExpiresAt`
- **Expiration**: 7 days (sufficient time for user to click link)
- **Format**: Similar to `provisionToken` - cryptographically secure random string

#### 4.2 Update Email Template
- **Location**: `server/utils/email-service.js`, line 106-108
- **New Email Body**:
  ```
  Hi ${userId},
  
  Your Private MAIA has been provisioned and is ready to use!
  
  **IMPORTANT**: Please review and edit your Current Medications list. This helps ensure your Patient Summary is accurate.
  
  [Edit Current Medications] (link)
  
  After you save your medications, your Patient Summary will be automatically generated.
  
  Your Private AI agent is ready to receive your health records and answer questions.
  
  -Adrian
  ```
- **Link Format**: `https://your-domain.com/?editMedications=${token}&userId=${userId}`
- **Alternative**: Use path-based: `https://your-domain.com/edit-medications/${token}`

#### 4.3 Generate Token During Provisioning
- **Location**: `server/index.js` - `provisionUserAsync()`, after Current Medications generation
- **Action**: Call `emailService.generateCurrentMedicationsToken(userId)` and store in user document
- **Timing**: After Step 7.5 (Current Medications generation) completes

---

### 5. Handle Deep Link in Frontend

**Location**: `src/App.vue` and `src/components/MyStuffDialog.vue`

**Required Changes**:

#### 5.1 Parse URL Parameters
- **Location**: `src/App.vue` - `onMounted()` hook (around line 362)
- **Action**: Check for `editMedications` query parameter
- **Process**:
  ```typescript
  const params = new URLSearchParams(window.location.search);
  const editMedicationsToken = params.get('editMedications');
  const editMedicationsUserId = params.get('userId');
  
  if (editMedicationsToken && editMedicationsUserId) {
    // Store for later use after authentication
    pendingMedicationsEdit.value = {
      token: editMedicationsToken,
      userId: editMedicationsUserId
    };
  }
  ```

#### 5.2 Verify Token and Open Editor
- **New Endpoint**: `GET /api/verify-medications-token?token=...&userId=...`
- **Purpose**: Verify token is valid and not expired
- **Response**: `{ valid: boolean, expired: boolean }`
- **Location**: `server/index.js` or `server/routes/auth.js`

#### 5.3 Auto-Open My Stuff Dialog
- **Location**: `src/components/ChatInterface.vue` or `src/App.vue`
- **Trigger**: After user is authenticated AND `pendingMedicationsEdit` exists
- **Action**:
  1. Verify token via API
  2. If valid, set `myStuffInitialTab = 'lists'`
  3. Set `showMyStuffDialog = true`
  4. Trigger Current Medications edit mode
  5. Clear URL parameters after opening

#### 5.4 Auto-Open Current Medications Editor
- **Location**: `src/components/Lists.vue`
- **New Prop**: `autoEditMedications?: boolean`
- **New Method**: `startEditingCurrentMedications()` (already exists)
- **Trigger**: In `onMounted()` or `onActivated()`, if `autoEditMedications === true`
- **Action**: Automatically call `startEditingCurrentMedications()`

---

### 6. Generate Patient Summary After Current Medications Save

**Location**: `src/components/Lists.vue` - `saveCurrentMedications()` and `server/index.js`

**Current State**: Patient Summary generation only happens during provisioning (which we're removing)

**Required Changes**:

#### 6.1 New Backend Endpoint
- **Location**: `server/index.js`
- **New Endpoint**: `POST /api/generate-patient-summary`
- **Purpose**: Generate Patient Summary after Current Medications is saved
- **Trigger**: Called from frontend after user saves Current Medications
- **Process**:
  1. Verify user is authenticated
  2. Check if agent exists and is deployed
  3. Check if KB has indexed files
  4. Generate Patient Summary using Private AI
  5. Save to `userDoc.patientSummaries[]`
  6. Set `workflowStage: 'patient_summary'`
  7. Return summary to frontend

#### 6.2 Frontend Integration
- **Location**: `src/components/Lists.vue` - `saveCurrentMedications()`
- **Action**: After successful save, call new endpoint to generate Patient Summary
- **Process**:
  1. Save Current Medications (existing code)
  2. Show loading indicator: "Generating Patient Summary..."
  3. Call `POST /api/generate-patient-summary`
  4. On success, show notification: "Patient Summary generated successfully"
  5. Optionally navigate to Patient Summary tab in My Stuff dialog

#### 6.3 Error Handling
- If Patient Summary generation fails, log error but don't block user
- Show warning: "Current Medications saved, but Patient Summary generation failed. You can generate it later from the Patient Summary tab."

---

## Implementation Order

### Phase 1: Core Automation Fixes
1. ✅ Extract Lists processing logic into reusable function
2. ✅ Add Lists processing to `provisionUserAsync()` (Step 2.4)
3. ✅ Remove Patient Summary generation from provisioning
4. ✅ Update AUTOMATION.md with new flow

### Phase 2: Current Medications Email Link
5. ✅ Add token generation to email service
6. ✅ Update email template with deep link
7. ✅ Generate token during provisioning
8. ✅ Add token verification endpoint

### Phase 3: Frontend Deep Link Handling
9. ✅ Parse `editMedications` URL parameter in App.vue
10. ✅ Auto-open My Stuff dialog with Lists tab
11. ✅ Auto-open Current Medications editor
12. ✅ Clear URL parameters after opening

### Phase 4: Patient Summary After Save
13. ✅ Create `POST /api/generate-patient-summary` endpoint
14. ✅ Call endpoint from `saveCurrentMedications()`
15. ✅ Handle success/error states
16. ✅ Update workflow stage

---

## Technical Details

### Lists Processing Function Signature
```javascript
async function processInitialFileForLists(
  userId,
  initialFileBucketKey,
  initialFileName,
  cloudant,
  doClient
) {
  // Extract from existing endpoint logic
  // Returns: { success: boolean, markdownBucketKey?: string, error?: string }
}
```

### Current Medications Token Format
- **Length**: 32 characters (hex)
- **Storage**: `userDoc.currentMedicationsToken`
- **Expiration**: `userDoc.currentMedicationsTokenExpiresAt` (ISO timestamp)
- **Verification**: Check token matches AND `expiresAt > now()`

### Deep Link URL Format
- **Query Parameter**: `?editMedications=<token>&userId=<userId>`
- **Alternative Path**: `/edit-medications/<token>?userId=<userId>`
- **Security**: Token must be verified before opening editor

### Patient Summary Endpoint
```javascript
POST /api/generate-patient-summary
Body: { userId: string }
Response: { 
  success: boolean, 
  summary?: string, 
  error?: string 
}
```

---

## Testing Checklist

- [ ] Lists processing runs automatically during provisioning
- [ ] Lists markdown file is created in `userId/Lists/` folder
- [ ] Current Medications generation succeeds (has Lists markdown)
- [ ] Patient Summary is NOT generated during provisioning
- [ ] Email contains deep link to Current Medications editor
- [ ] Deep link token is generated and stored in user document
- [ ] Clicking email link opens app and navigates to Lists tab
- [ ] Current Medications editor opens automatically
- [ ] Saving Current Medications triggers Patient Summary generation
- [ ] Patient Summary is saved to user document
- [ ] Workflow stage is updated correctly at each step

---

## Error Scenarios

1. **Lists Processing Fails**: Log error, continue provisioning, user can manually trigger later
2. **Current Medications Generation Fails**: Log error, continue provisioning, user can manually trigger later
3. **Email Token Generation Fails**: Log error, continue provisioning, user can access editor manually
4. **Deep Link Token Invalid/Expired**: Show error message, allow manual access to editor
5. **Patient Summary Generation Fails**: Log error, allow user to retry from Patient Summary tab

---

## Files to Modify

1. `Documents/AUTOMATION.md` - Complete rewrite with new flow
2. `server/routes/files.js` - Extract Lists processing function
3. `server/index.js` - Add Lists processing, remove Patient Summary, add token generation
4. `server/utils/email-service.js` - Add token generation, update email template
5. `server/index.js` - Add token verification endpoint
6. `server/index.js` - Add Patient Summary generation endpoint
7. `src/App.vue` - Parse URL parameters, handle deep link
8. `src/components/ChatInterface.vue` - Auto-open My Stuff dialog
9. `src/components/MyStuffDialog.vue` - Pass auto-edit flag to Lists component
10. `src/components/Lists.vue` - Auto-edit mode, call Patient Summary endpoint

---

## Summary

This plan ensures:
1. ✅ Lists processing happens automatically during provisioning
2. ✅ Current Medications is generated automatically
3. ✅ User receives email with actionable link
4. ✅ Current Medications editor opens automatically from link
5. ✅ Patient Summary is generated AFTER user edits, not during provisioning
6. ✅ All steps are logged for terminal visibility
7. ✅ Error handling is robust and non-blocking
