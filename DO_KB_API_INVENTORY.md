# DigitalOcean Knowledge Base API Inventory

## Overview
This document provides a complete inventory of all DigitalOcean GenAI APIs used for KB management and indexing in the automation process.

---

## API Endpoints Used

### 1. **List All Knowledge Bases**
- **Endpoint:** `GET /v2/gen-ai/knowledge_bases`
- **Method:** GET
- **Client Method:** `doClient.kb.list()`
- **Purpose:** List all KBs in the account to find existing KBs by name
- **When Used:**
  - Step 1 of `/api/update-knowledge-base`: Check if KB exists before creating
  - Getting database ID fallback: Retrieve from existing KBs
  - Getting embedding model ID fallback: Retrieve from existing KBs
- **Response:** Array of KB objects with `uuid`, `name`, `database_id`, `embedding_model_uuid`, etc.
- **Used in:** `server/index.js` lines 2503, 2555, 2578

---

### 2. **Get Knowledge Base Details**
- **Endpoint:** `GET /v2/gen-ai/knowledge_bases/{kbId}`
- **Method:** GET
- **Client Method:** `doClient.kb.get(kbId)`
- **Purpose:** Get full details of a specific KB including datasources, tokens, etc.
- **When Used:**
  - After finding existing KB: Get full details including datasources
  - After creating KB: Refresh to get datasources array
  - After adding data source: Refresh to get updated datasources with UUID
  - Status polling: Get KB details for token count and name
- **Response:** KB object with `uuid`, `name`, `datasources[]`, `total_tokens`, `embedding_model_uuid`, etc.
- **Used in:** `server/index.js` lines 2515, 2558, 2580, 2676, 2713, 2718, 2876

---

### 3. **Create Knowledge Base**
- **Endpoint:** `POST /v2/gen-ai/knowledge_bases`
- **Method:** POST
- **Client Method:** `doClient.kb.create(options)`
- **Purpose:** Create a new KB with initial datasource
- **When Used:**
  - Step 2 of `/api/update-knowledge-base`: Create KB if it doesn't exist
  - Only called when KB is not found in DO API
- **Request Body:**
  ```json
  {
    "name": "sun13-kb-110520251313",
    "description": "Knowledge base for sun13",
    "project_id": "90179b7c-8a42-4a71-a036-b4c2bea2fe59",
    "database_id": "881761c6-e72d-4f35-a48e-b320cd1f46e4",
    "embedding_model_uuid": "22653204-79ed-11ef-bf8f-4e013e2ddde4",
    "region": "tor1",
    "datasources": [
      {
        "spaces_data_source": {
          "bucket_name": "maia",
          "item_path": "sun13/sun13-kb-110520251313/",
          "region": "tor1"
        }
      }
    ]
  }
  ```
- **Response:** KB object with `uuid`, `name`, etc. (datasources may not be fully populated)
- **Used in:** `server/index.js` line 2628
- **Note:** Creates KB with datasource, but datasource UUID may not be in response - need to refresh

---

### 4. **Update Knowledge Base**
- **Endpoint:** `PUT /v2/gen-ai/knowledge_bases/{kbId}`
- **Method:** PUT
- **Client Method:** `doClient.kb.update(kbId, updates)`
- **Purpose:** Update KB metadata (name, description, etc.)
- **When Used:** ⚠️ **NOT CURRENTLY USED** in automation
- **Status:** Available in client but not called in server code
- **Potential Use:** Could update KB name or description if needed

---

### 5. **Delete Knowledge Base**
- **Endpoint:** `DELETE /v2/gen-ai/knowledge_bases/{kbId}`
- **Method:** DELETE
- **Client Method:** `doClient.kb.delete(kbId)`
- **Purpose:** Delete a KB
- **When Used:** ⚠️ **NOT CURRENTLY USED** in automation
- **Status:** Available in client but not called in server code
- **Potential Use:** Cleanup or KB management features

---

### 6. **Add Data Source to Knowledge Base**
- **Endpoint:** `POST /v2/gen-ai/knowledge_bases/{kbId}/data_sources`
- **Method:** POST
- **Client Method:** `doClient.kb.addDataSource(kbId, dataSourceOptions)`
- **Purpose:** Add a new data source (S3/Spaces path) to an existing KB
- **When Used:**
  - Step 3 of `/api/update-knowledge-base`: Add data source if KB exists but has no datasources
  - Step 3 of `/api/update-knowledge-base`: Add new data source after deleting old ones (if path changed)
- **Request Body:**
  ```json
  {
    "spaces_data_source": {
      "bucket_name": "maia",
      "item_path": "sun13/sun13-kb-110520251313/",
      "region": "tor1"
    }
  }
  ```
- **Response:**
  ```json
  {
    "knowledge_base_data_source": {
      "uuid": "35c875ac-ba88-11f0-b074-4e013e2ddde4",
      "bucket_name": "maia",
      "item_path": "sun13/sun13-kb-110520251313/",
      "region": "tor1",
      "created_at": "2025-11-05T20:44:22Z",
      "updated_at": "2025-11-05T20:44:22Z",
      "spaces_data_source": { ... }
    }
  }
  ```
- **UUID Extraction:** UUID is in `knowledge_base_data_source.uuid` (not directly on response)
- **Used in:** `server/index.js` lines 2667, 2709
- **Note:** After adding, must refresh KB details to get datasources array or extract from response

---

### 7. **Delete Data Source from Knowledge Base**
- **Endpoint:** `DELETE /v2/gen-ai/knowledge_bases/{kbId}/data_sources/{dataSourceId}`
- **Method:** DELETE
- **Client Method:** `doClient.kb.deleteDataSource(kbId, dataSourceId)`
- **Purpose:** Remove a data source from a KB
- **When Used:**
  - Step 3 of `/api/update-knowledge-base`: Delete old datasources when path needs to change
- **Used in:** `server/index.js` line 2661
- **Note:** Called before adding new datasource if path changed

---

### 8. **Start Indexing Job (KB-Specific Endpoint)**
- **Endpoint:** `POST /v2/gen-ai/knowledge_bases/{kbId}/indexing_jobs`
- **Method:** POST
- **Client Method:** `doClient.indexing.start(kbId, dataSourceUuid)`
- **Status:** ⚠️ **NOT USED** - Returns 405 (Method Not Allowed)
- **Note:** This endpoint is not available/working. Use global endpoint instead.

---

### 9. **Start Indexing Job (Global Endpoint)** ✅ **PRIMARY ENDPOINT**
- **Endpoint:** `POST /v2/gen-ai/indexing_jobs`
- **Method:** POST
- **Client Method:** `doClient.indexing.startGlobal(kbId, dataSourceUuids)`
- **Purpose:** Start indexing job - this is the correct/working endpoint
- **When Used:**
  - Step 4 of `/api/update-knowledge-base`: Start indexing after KB setup
  - **Directly called** (no fallback needed)
- **Request Body:**
  ```json
  {
    "knowledge_base_uuid": "4886bf62-ba87-11f0-b074-4e013e2ddde4",
    "data_source_uuids": ["35c875ac-ba88-11f0-b074-4e013e2ddde4"]
  }
  ```
- **Response:** Indexing job object with `uuid`, `status`, etc.
- **Used in:** `server/index.js` line 2782
- **Status:** ✅ **This is the working endpoint** (used directly)

---

### 10. **Get Indexing Job Status**
- **Endpoint:** `GET /v2/gen-ai/indexing_jobs/{jobId}`
- **Method:** GET
- **Client Method:** `doClient.indexing.getStatus(jobId)`
- **Purpose:** Get current status of an indexing job
- **When Used:**
  - `/api/kb-indexing-status/:jobId`: Polling endpoint called by frontend
  - Called every 2 seconds by frontend until job completes
- **Response:**
  ```json
  {
    "indexing_job": {
      "uuid": "job-uuid",
      "status": "INDEX_JOB_STATUS_RUNNING",
      "knowledge_base_uuid": "kb-uuid",
      "data_source_uuids": ["ds-uuid"],
      "progress": 0.65,
      "error": null
    }
  }
  ```
- **Status Values:**
  - `INDEX_JOB_STATUS_PENDING` - Job queued
  - `INDEX_JOB_STATUS_RUNNING` - Job in progress
  - `INDEX_JOB_STATUS_COMPLETED` - Job finished successfully
  - `INDEX_JOB_STATUS_FAILED` - Job failed
- **Used in:** `server/index.js` line 2857
- **Frequency:** Polled every 2 seconds by frontend

---

## Missing APIs (Not Currently Used)

### 11. **List Data Sources for KB**
- **Endpoint:** `GET /v2/gen-ai/knowledge_bases/{kbId}/data_sources`
- **Method:** GET
- **Status:** ⚠️ **NOT IMPLEMENTED** in client
- **Potential Use:** Could verify datasources without fetching full KB details

### 12. **Get Data Source Details**
- **Endpoint:** `GET /v2/gen-ai/knowledge_bases/{kbId}/data_sources/{dataSourceId}`
- **Method:** GET
- **Status:** ⚠️ **NOT IMPLEMENTED** in client
- **Potential Use:** Verify specific datasource details

### 13. **List Indexing Jobs**
- **Endpoint:** `GET /v2/gen-ai/indexing_jobs` (with query params?)
- **Method:** GET
- **Status:** ⚠️ **NOT IMPLEMENTED** in client
- **Potential Use:** List all indexing jobs, filter by KB, etc.

---

## Current Automation Flow

### `/api/update-knowledge-base` Endpoint Flow:

1. **Check if KB exists** (Step 1)
   - `GET /v2/gen-ai/knowledge_bases` → Find by name
   - If found: `GET /v2/gen-ai/knowledge_bases/{kbId}` → Get details

2. **Create KB if needed** (Step 2)
   - `POST /v2/gen-ai/knowledge_bases` → Create new KB
   - `GET /v2/gen-ai/knowledge_bases/{kbId}` → Refresh to get datasources

3. **Manage Data Sources** (Step 3)
   - If path changed: `DELETE /v2/gen-ai/knowledge_bases/{kbId}/data_sources/{dsId}` (for each old)
   - If no datasource or path changed: `POST /v2/gen-ai/knowledge_bases/{kbId}/data_sources` → Add new
   - `GET /v2/gen-ai/knowledge_bases/{kbId}` → Refresh to get datasource UUID

4. **Start Indexing** (Step 4)
   - Try: `POST /v2/gen-ai/knowledge_bases/{kbId}/indexing_jobs` (returns 405)
   - Fallback: `POST /v2/gen-ai/indexing_jobs` → Start indexing (works)

5. **Poll Status** (Step 5 - Frontend)
   - `GET /v2/gen-ai/indexing_jobs/{jobId}` → Get status (every 2s)
   - `GET /v2/gen-ai/knowledge_bases/{kbId}` → Get KB details for tokens

---

## Issues Identified & Fixed

### 1. **KB-Specific Indexing Endpoint Returns 405** ✅ **FIXED**
- **Problem:** `POST /v2/gen-ai/knowledge_bases/{kbId}/indexing_jobs` returns 405
- **Solution:** Use global endpoint `POST /v2/gen-ai/indexing_jobs` directly
- **Status:** ✅ Now uses global endpoint directly (no try/fail/fallback)

### 2. **Data Source UUID Extraction** ✅ **OPTIMIZED**
- **Problem:** After `addDataSource`, UUID is in nested `knowledge_base_data_source.uuid`
- **Solution:** Extract UUID directly from response (checks `knowledge_base_data_source.uuid` first)
- **Fallback:** Only refresh KB details if UUID not in response
- **Status:** ✅ Optimized - avoids unnecessary GET calls

### 3. **Redundant KB Details Calls** ✅ **OPTIMIZED**
- **Problem:** Multiple calls to `GET /v2/gen-ai/knowledge_bases/{kbId}` to refresh
- **Solution:** 
  - Cache KB list from Step 1 and reuse when getting database/embedding IDs
  - Cache KB details when found/created and reuse when possible
  - Extract datasource UUID from response instead of refreshing
- **Status:** ✅ Optimized - reduced redundant API calls

### 4. **No Data Source Listing API**
- **Problem:** Must fetch full KB details to see datasources
- **Impact:** Inefficient if KB has many datasources or large metadata
- **Status:** ⚠️ Not implemented - would require new API endpoint

---

## Optimizations Implemented ✅

1. **✅ Use Global Indexing Endpoint Directly**
   - Removed KB-specific endpoint attempt (it returns 405)
   - Now uses `POST /v2/gen-ai/indexing_jobs` directly
   - Cleaner code, no try/fail/fallback pattern

2. **✅ Extract Data Source UUID from Response**
   - Uses `knowledge_base_data_source.uuid` from `addDataSource` response first
   - Only refreshes KB details if UUID not in response
   - Reduces API calls by 1-2 per request

3. **✅ Cache KB List and Details**
   - Caches KB list from Step 1 (`allKBsCache`)
   - Reuses cached KB details when getting database/embedding IDs
   - Updates in-memory cache when adding datasources
   - Reduces API calls by 1-2 per request

## Remaining Recommendations

4. **Implement Missing APIs** (if needed)
   - `GET /v2/gen-ai/knowledge_bases/{kbId}/data_sources` - List datasources (would reduce calls)
   - `GET /v2/gen-ai/data_sources/{dataSourceId}` - Get datasource details

5. **Monitor API Usage**
   - Track which endpoints are actually being used
   - Log API call counts for optimization opportunities

---

## API Call Summary (After Optimizations)

| Step | API Call | Method | Frequency | Purpose |
|------|----------|--------|-----------|---------|
| 1 | List KBs | GET | Once per request | Find existing KB (cached) |
| 1 | Get KB details | GET | Once if found | Get KB with datasources (cached) |
| 2 | Create KB | POST | Once if not found | Create new KB |
| 2 | Get KB details | GET | Once if not cached | Get KB details for database/embedding IDs |
| 3 | Delete datasource(s) | DELETE | 0-N times | Remove old datasources |
| 3 | Add datasource | POST | 0-1 times | Add new datasource (UUID extracted from response) |
| 3 | Get KB details | GET | Only if UUID missing | Fallback: Get datasource UUID |
| 4 | Start indexing (global) | POST | Once | Start indexing job (directly) |
| 5 | Get job status | GET | Every 2s | Poll until complete |
| 5 | Get KB details | GET | Once per poll | Get token count |

**Total API Calls per Request (Optimized):**
- **Minimum:** 3 calls (KB exists with datasource: List KBs, Get KB details, Start indexing)
- **Maximum:** 6 calls (KB doesn't exist, need to add datasource, extract UUID from response)
- **Average:** 4-5 calls (most common path)

**Optimization Results:**
- **Before:** 4-8+ calls per request
- **After:** 3-6 calls per request
- **Savings:** 1-2 API calls per request (20-25% reduction)

