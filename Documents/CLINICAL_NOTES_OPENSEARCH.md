# Clinical Notes OpenSearch Database

**Note:** The OpenSearch-backed Clinical Notes feature (indexing/search via direct OpenSearch access) has been removed. The app no longer uses OpenSearch credentials or the Clinical Notes API routes. This document is kept for historical reference only. Clinical Notes from PDFs still appear in the Lists UI as a category derived from markdown extraction.

---

This document described the Clinical Notes indexing system that stored clinical notes from PDF files in a DigitalOcean OpenSearch database.

## Overview

The Clinical Notes system indexes clinical notes extracted from PDF files into an OpenSearch database. Each clinical note is stored as a JSON document with the following fields:

- `userId`: User ID (for security isolation)
- `fileName`: Source document filename
- `page`: Page number in the source document
- `category`: Markdown category (e.g., "Allergies", "Clinical Notes")
- `content`: Plain text content
- `markdown`: Structured markdown content
- `indexedAt`: Timestamp when indexed

## Security Architecture

**Separate Indices Per User**: Each user has their own OpenSearch index named `{userId}-clinical-notes` (e.g., `user123-clinical-notes`). This provides:

1. **Complete Isolation**: Users cannot access each other's data even if there's a bug in query logic
2. **Performance**: Smaller indices are faster to query
3. **Consistency**: Matches the pattern used for knowledge bases (one KB per user)
4. **Easy Management**: Can delete or manage a user's data independently

**Query-Level Security**: All queries automatically include a `userId` filter, providing defense-in-depth security.

## Setup

### 1. Get OpenSearch Connection Details from DigitalOcean

1. Log into the DigitalOcean Control Panel
2. Navigate to **Databases** → Select your OpenSearch/Elasticsearch database
3. In the **Connection Details** section, you'll find:
   - **Host**: The database hostname (e.g., `genai1-driftwood-do-user-3963249-0.h.db.ondigitalocean.com`)
   - **Port**: Usually `25060` for OpenSearch (check your dashboard)
   - **Username**: Database username
   - **Password**: Database password

4. Construct the endpoint URL:
   - Format: `https://{host}:{port}`
   - Example: `https://genai1-driftwood-do-user-3963249-0.h.db.ondigitalocean.com:25060`
   - **Note**: Always use `https://` protocol. The port is typically `25060` for DigitalOcean OpenSearch, but verify in your dashboard.

### 2. Configure Environment Variables

Add these to your `.env` file:

```bash
# OpenSearch for Clinical Notes
# Format: https://{host}:{port}
# Example: https://genai1-driftwood-do-user-3963249-0.h.db.ondigitalocean.com:25060
OPENSEARCH_ENDPOINT=https://genai1-driftwood-do-user-3963249-0.h.db.ondigitalocean.com:25060
OPENSEARCH_USERNAME=your-username
OPENSEARCH_PASSWORD=your-password

# Note: Uses the same database cluster as knowledge bases
DO_DATABASE_ID=your-database-id
```

### 3. Verify Setup

The server will log on startup:
- `✅ Clinical Notes OpenSearch client initialized` - if configured correctly
- `⚠️  OPENSEARCH_ENDPOINT not configured - clinical notes indexing disabled` - if not configured

## API Endpoints

### Index Clinical Notes from Uploaded PDF

**POST** `/api/files/index-clinical-notes`

Upload a PDF file to extract and index clinical notes.

**Request:**
- `Content-Type: multipart/form-data`
- `pdfFile`: PDF file to process

**Response:**
```json
{
  "success": true,
  "indexed": 45,
  "errors": [],
  "fileName": "medical-records.pdf",
  "totalPages": 45,
  "categories": [
    { "category": "Allergies", "count": 3 },
    { "category": "Clinical Notes", "count": 12 }
  ]
}
```

### Index Clinical Notes from Bucket File

**POST** `/api/files/index-clinical-notes/:bucketKey(*)`

Index clinical notes from a file already stored in DigitalOcean Spaces.

**Parameters:**
- `bucketKey`: Path to file in bucket (e.g., `userId/filename.pdf`)

**Response:** Same as upload endpoint

### Search Clinical Notes

**POST** `/api/files/search-clinical-notes`

Search clinical notes for the authenticated user.

**Request Body:**
```json
{
  "query": "diabetes medication",
  "category": "Medication Records",
  "fileName": "medical-records.pdf",
  "page": 5,
  "size": 100,
  "from": 0
}
```

**Response:**
```json
{
  "success": true,
  "total": 15,
  "hits": [
    {
      "id": "doc-id",
      "score": 2.5,
      "source": {
        "userId": "user123",
        "fileName": "medical-records.pdf",
        "page": 5,
        "category": "Medication Records",
        "content": "...",
        "markdown": "...",
        "indexedAt": "2024-01-15T10:30:00Z"
      }
    }
  ]
}
```

**Security**: The `userId` is automatically extracted from the session and enforced in all queries. Users can only search their own notes.

### Get Categories

**GET** `/api/files/clinical-notes-categories`

Get all categories and their counts for the authenticated user.

**Response:**
```json
{
  "success": true,
  "categories": [
    { "category": "Allergies", "count": 3 },
    { "category": "Clinical Notes", "count": 12 },
    { "category": "Medication Records", "count": 8 }
  ]
}
```

## Usage Example

### Indexing a PDF

```javascript
const formData = new FormData();
formData.append('pdfFile', pdfFile);

const response = await fetch('/api/files/index-clinical-notes', {
  method: 'POST',
  body: formData,
  credentials: 'include' // Include session cookie
});

const result = await response.json();
console.log(`Indexed ${result.indexed} notes`);
```

### Searching Notes

```javascript
const response = await fetch('/api/files/search-clinical-notes', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'diabetes',
    category: 'Medication Records'
  }),
  credentials: 'include'
});

const result = await response.json();
console.log(`Found ${result.total} notes`);
```

## Index Structure

Each user's index (`{userId}-clinical-notes`) has the following mapping:

```json
{
  "mappings": {
    "properties": {
      "userId": { "type": "keyword" },
      "fileName": { "type": "keyword" },
      "page": { "type": "integer" },
      "category": { "type": "keyword" },
      "content": { "type": "text" },
      "markdown": { "type": "text" },
      "indexedAt": { "type": "date" }
    }
  }
}
```

## Integration with PDF Processing

The clinical notes indexing integrates with the existing PDF-to-markdown pipeline:

1. PDF is extracted with page boundaries preserved
2. Markdown categories are extracted using Private AI
3. Each page is indexed as a separate note
4. Category information is associated with each note

## Future Enhancements

- **Re-indexing**: Add endpoint to re-index all notes for a user
- **Deletion**: Add endpoint to delete notes for a specific file
- **Batch Operations**: Support for indexing multiple files at once
- **Metadata Extraction**: Extract additional metadata (dates, providers, etc.)
- **Full-Text Search Improvements**: Add fuzzy matching, phrase queries, etc.

## Using the OpenSearch Dashboard

### Accessing the Dashboard

1. Log into the DigitalOcean Control Panel
2. Navigate to **Databases** → Select your OpenSearch database
3. Click on the **"OpenSearch Dashboards"** link or button
4. Log in with your database credentials (username and password)

### Finding Your Index

1. In OpenSearch Dashboards, go to **Management** → **Index Management** (or **Stack Management** → **Index Management**)
2. Look for indices named `{userId}-clinical-notes` (e.g., `fri1-clinical-notes`)
3. Click on the index name to view its details

### Searching Clinical Notes

#### Method 1: Using Dev Tools (Recommended)

1. Go to **Dev Tools** (or **Management** → **Dev Tools**)
2. Use the following query examples:

**Search all notes for a user:**
```json
GET fri1-clinical-notes/_search
{
  "query": {
    "match_all": {}
  },
  "size": 10
}
```

**Search by text content:**
```json
GET fri1-clinical-notes/_search
{
  "query": {
    "multi_match": {
      "query": "diabetes medication",
      "fields": ["content^2", "markdown", "category"]
    }
  }
}
```

**Search by date:**
```json
GET fri1-clinical-notes/_search
{
  "query": {
    "term": {
      "date": "Oct 27, 2025"
    }
  }
}
```

**Search by location:**
```json
GET fri1-clinical-notes/_search
{
  "query": {
    "term": {
      "location": "Mass General Brigham"
    }
  }
}
```

**Search by category:**
```json
GET fri1-clinical-notes/_search
{
  "query": {
    "term": {
      "category": "Clinical Note"
    }
  }
}
```

**Search by fileName:**
```json
GET fri1-clinical-notes/_search
{
  "query": {
    "term": {
      "fileName": "Apple_-_Adrian_Gropper_-_2025-11-17.pdf"
    }
  }
}
```

**Search by page number:**
```json
GET fri1-clinical-notes/_search
{
  "query": {
    "term": {
      "page": 20
    }
  }
}
```

**Complex query (multiple filters):**
```json
GET fri1-clinical-notes/_search
{
  "query": {
    "bool": {
      "must": [
        {
          "match": {
            "content": "anesthesia"
          }
        },
        {
          "term": {
            "location": "Mass General Brigham"
          }
        }
      ],
      "filter": [
        {
          "range": {
            "page": {
              "gte": 1,
              "lte": 50
            }
          }
        }
      ]
    }
  },
  "sort": [
    {
      "date": {
        "order": "desc"
      }
    }
  ]
}
```

#### Method 2: Using Discover

1. Go to **Discover** in the left sidebar
2. Select your index (`fri1-clinical-notes`) from the index pattern dropdown
3. Use the search bar to enter queries:
   - Simple text: `diabetes`
   - Field-specific: `content:diabetes AND location:"Mass General Brigham"`
   - Date range: Use the time picker to filter by `indexedAt`

4. Click on any result to see the full document with all fields:
   - `userId`
   - `fileName`
   - `page`
   - `category`
   - `content` (plain text)
   - `markdown` (structured markdown)
   - `date` (note date)
   - `location` (note location)
   - `indexedAt` (when indexed)

#### Method 3: Using Visualizations

1. Go to **Visualize** → **Create Visualization**
2. Choose a visualization type (e.g., **Data Table**, **Pie Chart**)
3. Select your index pattern
4. Create visualizations for:
   - Notes by location (pie chart)
   - Notes by category (bar chart)
   - Notes over time (line chart using `indexedAt`)
   - Notes per page (histogram)

### Available Fields for Searching

- **`userId`** (keyword): User ID - automatically filtered for security
- **`fileName`** (keyword): Source PDF filename
- **`page`** (integer): Page number in source document
- **`category`** (keyword): Note category (e.g., "Clinical Note", "Imaging, Radiology")
- **`content`** (text): Plain text content - full-text searchable
- **`markdown`** (text): Structured markdown - full-text searchable
- **`date`** (keyword): Note date (e.g., "Oct 27, 2025")
- **`location`** (keyword): Note location (e.g., "Mass General Brigham")
- **`indexedAt`** (date): Timestamp when the note was indexed

### Security Note

⚠️ **Important**: All queries automatically filter by `userId` in the API. When using the OpenSearch dashboard directly, make sure you're only querying the correct user's index (`{userId}-clinical-notes`). Never query across multiple user indices or use wildcards that could expose other users' data.

## Troubleshooting

### "Clinical Notes indexing not configured"

- Check that `OPENSEARCH_ENDPOINT` is set in `.env`
- Restart the server after adding environment variables

### "Failed to create index"

- Verify OpenSearch credentials are correct
- Check that the database allows index creation
- Ensure the endpoint URL is correct

### "Failed to index note"

- Check OpenSearch cluster health
- Verify network connectivity to OpenSearch endpoint
- Check OpenSearch logs for detailed error messages

### Search returns no results

- Verify notes were successfully indexed (check `indexed` count in response)
- Ensure you're searching with the correct `userId` (automatically handled by API)
- Check that the search query matches the indexed content

