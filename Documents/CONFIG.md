# Configuration Documentation

This document lists the APIs related to each environment variable used in the MAIA Cloud User App.

## DigitalOcean Environment Variables

### DIGITALOCEAN_PERSONAL_API_KEY
**API:** DigitalOcean GenAI Personal AI Chat API (OpenAI-compatible)

**Endpoints:**
- `POST {DIGITALOCEAN_GENAI_ENDPOINT}/chat/completions` - Chat completions (streaming and non-streaming)

**Usage:**
- Used by `lib/chat-client/providers/digitalocean.js` for chat interactions
- Configured in `server/index.js` via ChatClient
- Default endpoint: `https://vzfujeetn2dkj4d5awhvvibo.agents.do-ai.run/api/v1`

**Related Files:**
- `lib/chat-client/providers/digitalocean.js`
- `server/index.js` (lines 707-710)

---

### DIGITALOCEAN_GENAI_ENDPOINT
**API:** DigitalOcean GenAI Personal AI Chat API Base URL

**Default:** `https://vzfujeetn2dkj4d5awhvvibo.agents.do-ai.run/api/v1`

**Usage:**
- Base URL for OpenAI-compatible chat completions API
- Used as `baseURL` in DigitalOceanProvider

**Related Files:**
- `lib/chat-client/providers/digitalocean.js` (line 14)
- `server/index.js` (line 710)

---

### DIGITALOCEAN_TOKEN
**API:** DigitalOcean GenAI REST API v2

**Base URL:** `https://api.digitalocean.com` (default)

**Endpoints:**
- `GET /v2/gen-ai/agents` - List agents
- `GET /v2/gen-ai/agents/{agentId}` - Get agent details
- `POST /v2/gen-ai/agents` - Create agent
- `PUT /v2/gen-ai/agents/{agentId}` - Update agent
- `DELETE /v2/gen-ai/agents/{agentId}` - Delete agent
- `POST /v2/gen-ai/agents/{agentId}/knowledge_bases/{kbId}` - Attach KB to agent
- `DELETE /v2/gen-ai/agents/{agentId}/knowledge_bases/{kbId}` - Detach KB from agent
- `GET /v2/gen-ai/agents/{agentId}/api_keys` - List agent API keys
- `POST /v2/gen-ai/agents/{agentId}/api_keys` - Create agent API key
- `GET /v2/gen-ai/knowledge_bases` - List knowledge bases
- `GET /v2/gen-ai/knowledge_bases/{kbId}` - Get knowledge base details
- `POST /v2/gen-ai/knowledge_bases` - Create knowledge base
- `PUT /v2/gen-ai/knowledge_bases/{kbId}` - Update knowledge base
- `DELETE /v2/gen-ai/knowledge_bases/{kbId}` - Delete knowledge base
- `GET /v2/gen-ai/knowledge_bases/{kbId}/data_sources` - List data sources
- `POST /v2/gen-ai/knowledge_bases/{kbId}/data_sources` - Add data source
- `DELETE /v2/gen-ai/knowledge_bases/{kbId}/data_sources/{dataSourceId}` - Delete data source
- `POST /v2/gen-ai/knowledge_bases/{kbId}/indexing_jobs` - Start indexing job
- `POST /v2/gen-ai/indexing_jobs` - Start global indexing job
- `GET /v2/gen-ai/indexing_jobs/{jobId}` - Get indexing job status
- `GET /v2/gen-ai/knowledge_bases/{kbId}/indexing_jobs` - List indexing jobs for KB
- `DELETE /v2/gen-ai/indexing_jobs/{jobId}` - Cancel indexing job

**Usage:**
- Primary authentication token for DigitalOcean GenAI REST API
- Used by `DigitalOceanClient` in `lib/do-client/index.js`
- Authorized via `Authorization: Bearer {DIGITALOCEAN_TOKEN}` header

**Related Files:**
- `lib/do-client/index.js`
- `lib/do-client/agent.js`
- `lib/do-client/kb.js`
- `lib/do-client/indexing.js`
- `server/index.js` (line 311)

---

### DIGITALOCEAN_BASE_URL
**Status:** Not used in codebase

**Note:** This environment variable is not referenced anywhere in the codebase. The base URL for DigitalOcean GenAI REST API is hardcoded as `https://api.digitalocean.com` in `lib/do-client/index.js`.

---

### STORAGE_BACKEND
**Status:** Optional

**Usage:**
- Selects the storage backend for S3-compatible file access
- Set to `minio` for local testing with MinIO
- Any other value (or unset) uses DigitalOcean Spaces defaults

**Related Files:**
- `server/utils/storage-config.js`
- `server/index.js`

---

### MINIO_ENDPOINT_URL
**Status:** Optional (used when `STORAGE_BACKEND=minio`)

**Usage:**
- S3-compatible endpoint for MinIO (e.g. `http://localhost:9000`)
- Mapped to `DIGITALOCEAN_ENDPOINT_URL` at runtime for compatibility

**Related Files:**
- `server/utils/storage-config.js`

---

### MINIO_ACCESS_KEY_ID
**Status:** Optional (used when `STORAGE_BACKEND=minio`)

**Usage:**
- Access key for MinIO
- Mapped to `DIGITALOCEAN_AWS_ACCESS_KEY_ID` at runtime for compatibility

**Related Files:**
- `server/utils/storage-config.js`

---

### MINIO_SECRET_ACCESS_KEY
**Status:** Optional (used when `STORAGE_BACKEND=minio`)

**Usage:**
- Secret key for MinIO
- Mapped to `DIGITALOCEAN_AWS_SECRET_ACCESS_KEY` at runtime for compatibility

**Related Files:**
- `server/utils/storage-config.js`

---

### MINIO_BUCKET
**Status:** Optional (used when `STORAGE_BACKEND=minio`)

**Usage:**
- Bucket name for MinIO
- Mapped to `DIGITALOCEAN_BUCKET` at runtime for compatibility

**Related Files:**
- `server/utils/storage-config.js`

---

### MINIO_REGION
**Status:** Optional (used when `STORAGE_BACKEND=minio`)

**Default:** `us-east-1`

**Usage:**
- Region value used by the S3 client for MinIO (not region-specific)
- Mapped to `DO_REGION` at runtime if unset

**Related Files:**
- `server/utils/storage-config.js`

---

### S3_FORCE_PATH_STYLE
**Status:** Optional

**Usage:**
- When set to `true`, forces path-style S3 URLs
- Required for MinIO on `localhost`
- Automatically set when `STORAGE_BACKEND=minio` if not already provided

**Related Files:**
- `server/index.js`
- `server/routes/files.js`
- `server/routes/auth.js`
- `scripts/sync-kb-names-and-files.js`

---

### KB_USE_EPHEMERAL_SPACES
**Status:** Optional

**Usage:**
- When `true`, uses a temporary Spaces bucket for KB indexing
- Defaults to `true` when `STORAGE_BACKEND=minio`

**Related Files:**
- `server/index.js`

---

### SPACES_ENDPOINT_URL
**Status:** Optional

**Default:** `https://tor1.digitaloceanspaces.com`

**Usage:**
- Spaces endpoint used for ephemeral KB indexing bucket

**Related Files:**
- `server/index.js`

---

### SPACES_REGION
**Status:** Optional

**Default:** `tor1`

**Usage:**
- Region used for Spaces datasources in DO KB indexing

**Related Files:**
- `server/index.js`

---

### SPACES_AWS_ACCESS_KEY_ID
**Status:** Optional

**Usage:**
- Spaces access key for ephemeral KB indexing bucket

**Related Files:**
- `server/index.js`

---

### SPACES_AWS_SECRET_ACCESS_KEY
**Status:** Optional

**Usage:**
- Spaces secret key for ephemeral KB indexing bucket

**Related Files:**
- `server/index.js`

---

### SPACES_BUCKET_PREFIX
**Status:** Optional

**Default:** `maia-kb-temp`

**Usage:**
- Prefix used when creating ephemeral Spaces buckets for indexing

**Related Files:**
- `server/index.js`

---

### DIGITALOCEAN_BUCKET
**API:** DigitalOcean Spaces (S3-compatible API)

**Usage:**
- Bucket URL/name for storing user files
- Used to extract bucket name for S3 client operations
- Format: `https://{bucket}.{region}.digitaloceanspaces.com` or just the bucket name

**Related Files:**
- `server/routes/files.js` (multiple locations)
- `server/index.js` (multiple locations)
- `server/routes/auth.js` (line 42)

---

### DIGITALOCEAN_AWS_ACCESS_KEY_ID
**API:** DigitalOcean Spaces (S3-compatible API)

**Usage:**
- AWS-compatible access key ID for Spaces authentication
- Used as part of S3 client credentials configuration

**Related Files:**
- `server/routes/files.js` (line 549)
- `server/index.js` (multiple locations)
- `server/routes/auth.js` (line 55)

---

### DIGITALOCEAN_AWS_SECRET_ACCESS_KEY
**API:** DigitalOcean Spaces (S3-compatible API)

**Usage:**
- AWS-compatible secret access key for Spaces authentication
- Used as part of S3 client credentials configuration

**Related Files:**
- `server/routes/files.js` (line 550)
- `server/index.js` (multiple locations)
- `server/routes/auth.js` (line 56)

---

### DIGITALOCEAN_ENDPOINT_URL
**API:** DigitalOcean Spaces (S3-compatible API)

**Default:** `https://tor1.digitaloceanspaces.com`

**S3 Operations Used:**
- `PutObjectCommand` - Upload files
- `GetObjectCommand` - Download files
- `DeleteObjectCommand` - Delete files
- `HeadObjectCommand` - Check file metadata
- `ListObjectsV2Command` - List files in bucket
- `CopyObjectCommand` - Copy/move files within bucket
- `GetObjectAttributesCommand` - Get file attributes
- Presigned URLs via `getSignedUrl()` - Generate temporary file access URLs

**Usage:**
- S3-compatible endpoint URL for DigitalOcean Spaces
- Used to configure AWS SDK S3Client
- Region defaults to `us-east-1` (for S3 compatibility, not actual region)

**Related Files:**
- `server/routes/files.js` (line 545)
- `server/index.js` (multiple locations)
- `server/routes/auth.js` (line 51)

---

### DO_REGION
**API:** DigitalOcean GenAI REST API v2

**Default:** `tor1`

**Usage:**
- Specifies the region for DigitalOcean GenAI resources
- Used when creating knowledge bases, agents, and other resources
- Passed to `DigitalOceanClient` constructor

**Related Files:**
- `lib/do-client/index.js` (line 22)
- `lib/do-client/kb.js` (line 50, 62)
- `server/index.js` (line 312)

---

### DO_PROJECT_ID
**API:** DigitalOcean GenAI REST API v2

**Endpoints:**
- Used when creating agents: `POST /v2/gen-ai/agents`
- Used when creating knowledge bases: `POST /v2/gen-ai/knowledge_bases`

**Usage:**
- UUID of the DigitalOcean project containing GenAI resources
- Required for creating agents and knowledge bases

**Related Files:**
- `lib/do-client/agent.js` (line 52)
- `lib/do-client/kb.js` (line 48)
- `server/index.js` (lines 2738, 6952)

---

### DO_DATABASE_ID
**API:** DigitalOcean GenAI REST API v2 / OpenSearch Database

**Endpoints:**
- Used when creating knowledge bases: `POST /v2/gen-ai/knowledge_bases`
- References a DigitalOcean OpenSearch/PostgreSQL database cluster

**Usage:**
- UUID of the DigitalOcean database cluster used for knowledge base storage
- Required for creating knowledge bases
- Also used for clinical notes OpenSearch indexing (if configured)

**Related Files:**
- `lib/do-client/kb.js` (line 49)
- `server/index.js` (lines 574, 2922, 6953)
- `server/routes/files.js` (line 574)

---

### DO_EMBEDDING_MODEL_ID
**API:** DigitalOcean GenAI REST API v2

**Endpoints:**
- Used when creating knowledge bases: `POST /v2/gen-ai/knowledge_bases` (optional field `embedding_model_uuid`)

**Usage:**
- UUID of the embedding model to use for knowledge base vectorization
- Optional parameter for knowledge base creation
- If not provided, DigitalOcean uses default embedding model

**Related Files:**
- `lib/do-client/kb.js` (line 67-68)
- `server/index.js` (lines 2923, 6954)

---

### DATABASE_URL
**Status:** Not used in codebase

**Note:** This environment variable is not referenced anywhere in the codebase. The application uses separate Cloudant environment variables (`CLOUDANT_URL`, `CLOUDANT_USERNAME`, `CLOUDANT_PASSWORD`) for database connections instead.

---

## Summary

### APIs Used:
1. **DigitalOcean GenAI Personal AI Chat API** (OpenAI-compatible)
   - Environment Variables: `DIGITALOCEAN_PERSONAL_API_KEY`, `DIGITALOCEAN_GENAI_ENDPOINT`

2. **DigitalOcean GenAI REST API v2**
   - Environment Variables: `DIGITALOCEAN_TOKEN`, `DO_REGION`, `DO_PROJECT_ID`, `DO_DATABASE_ID`, `DO_EMBEDDING_MODEL_ID`
   - Base URL: `https://api.digitalocean.com`

3. **DigitalOcean Spaces (S3-compatible API)**
   - Environment Variables: `DIGITALOCEAN_BUCKET`, `DIGITALOCEAN_AWS_ACCESS_KEY_ID`, `DIGITALOCEAN_AWS_SECRET_ACCESS_KEY`, `DIGITALOCEAN_ENDPOINT_URL`
   - Uses AWS SDK S3Client for operations

### Not Used:
- `DIGITALOCEAN_BASE_URL` - Not referenced in codebase
- `DATABASE_URL` - Not referenced in codebase (uses CLOUDANT_* variables instead)

