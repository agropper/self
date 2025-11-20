/**
 * OpenSearch client for Clinical Notes indexing
 * Uses separate indices per userId for security isolation
 */

export class ClinicalNotesClient {
  constructor(options = {}) {
    this.endpoint = options.endpoint || process.env.OPENSEARCH_ENDPOINT;
    this.username = options.username || process.env.OPENSEARCH_USERNAME;
    this.password = options.password || process.env.OPENSEARCH_PASSWORD;
    this.databaseId = options.databaseId || process.env.DO_DATABASE_ID;
    
    if (!this.endpoint) {
      throw new Error('OpenSearch endpoint is required (OPENSEARCH_ENDPOINT or options.endpoint)');
    }
    
    // Remove trailing slash
    this.endpoint = this.endpoint.replace(/\/$/, '');
    
    // Create basic auth header if credentials provided
    this.authHeader = null;
    if (this.username && this.password) {
      const credentials = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      this.authHeader = `Basic ${credentials}`;
    }
  }

  /**
   * Get index name for a userId
   * Uses separate index per userId for security isolation
   * Format: {userId}-clinical-notes (matches agents and knowledge bases pattern)
   */
  getIndexName(userId) {
    // Sanitize userId to be index-name safe (lowercase, alphanumeric and hyphens only)
    const safeUserId = userId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return `${safeUserId}-clinical-notes`;
  }

  /**
   * Create index for a userId if it doesn't exist
   */
  async ensureIndex(userId) {
    const indexName = this.getIndexName(userId);
    
    try {
      // Check if index exists
      const checkResponse = await fetch(`${this.endpoint}/${indexName}`, {
        method: 'HEAD',
        headers: this.getHeaders()
      });

      if (checkResponse.ok) {
        console.log(`✅ Index ${indexName} already exists`);
        return { exists: true, indexName };
      }

      // Create index with mapping
      const indexMapping = {
        mappings: {
          properties: {
            userId: { type: 'keyword' }, // Exact match only, for security filtering
            fileName: { type: 'keyword' }, // Exact match for file name
            page: { type: 'integer' }, // Page number
            category: { type: 'keyword' }, // Markdown category (### heading)
            content: { type: 'text' }, // Full text search on content
            markdown: { type: 'text' }, // Full markdown text
            date: { type: 'keyword' }, // Note date (last found date)
            location: { type: 'keyword' }, // Note location (last found location)
            indexedAt: { type: 'date' } // When indexed
          }
        },
        settings: {
          number_of_shards: 1,
          number_of_replicas: 0 // Can be increased for production
        }
      };

      const createResponse = await fetch(`${this.endpoint}/${indexName}`, {
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify(indexMapping)
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        throw new Error(`Failed to create index: ${createResponse.status} - ${errorText}`);
      }

      console.log(`✅ Created index ${indexName}`);
      return { exists: false, indexName, created: true };
    } catch (error) {
      // If error is that index already exists, that's okay
      if (error.message.includes('resource_already_exists_exception')) {
        console.log(`✅ Index ${indexName} already exists`);
        return { exists: true, indexName };
      }
      throw error;
    }
  }

  /**
   * Index a clinical note
   * @param {string} userId - User ID (required for security)
   * @param {object} note - Note object with fileName, page, category, content, markdown
   * @returns {Promise<object>} Indexing result
   */
  async indexNote(userId, note) {
    if (!userId) {
      throw new Error('userId is required for indexing');
    }

    // Ensure index exists
    await this.ensureIndex(userId);

    const indexName = this.getIndexName(userId);
    
    // Create document with userId enforced
    const document = {
      userId: userId, // Always include userId for security
      fileName: note.fileName || '',
      page: note.page || 0,
      category: note.category || '',
      content: note.content || '',
      markdown: note.markdown || '',
      date: note.date || '',
      location: note.location || '',
      type: note.type || '',
      author: note.author || '',
      created: note.created || '',
      indexedAt: new Date().toISOString()
    };

    // Generate document ID from userId, fileName, page, category, and noteIndex for uniqueness
    // Include noteIndex to prevent overwrites when multiple notes share the same page/category
    const noteIndex = note.noteIndex || 0;
    const docId = `${userId}-${note.fileName || 'unknown'}-${note.page || 0}-${(note.category || 'uncategorized').replace(/[^a-z0-9-]/gi, '-')}-${noteIndex}`;
    const safeDocId = Buffer.from(docId).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 100);

    try {
      const response = await fetch(`${this.endpoint}/${indexName}/_doc/${safeDocId}`, {
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify(document)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to index note: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      
      // Refresh the index to make the document immediately searchable
      // This is optional but helps with testing and immediate searches
      try {
        await fetch(`${this.endpoint}/${indexName}/_refresh`, {
          method: 'POST',
          headers: this.getHeaders()
        });
      } catch (refreshError) {
        // Non-critical - index will refresh automatically
        console.warn('Note: Index refresh failed (non-critical):', refreshError.message);
      }
      
      return {
        success: true,
        index: indexName,
        id: result._id,
        result: result.result
      };
    } catch (error) {
      console.error('❌ Error indexing clinical note:', error);
      throw error;
    }
  }

  /**
   * Index multiple clinical notes in bulk
   * @param {string} userId - User ID (required for security)
   * @param {Array<object>} notes - Array of note objects
   * @returns {Promise<object>} Bulk indexing result
   */
  async indexNotesBulk(userId, notes) {
    if (!userId) {
      throw new Error('userId is required for bulk indexing');
    }

    if (!Array.isArray(notes) || notes.length === 0) {
      return { success: true, indexed: 0, errors: [] };
    }

    // Ensure index exists
    await this.ensureIndex(userId);

    const indexName = this.getIndexName(userId);
    
    // Build bulk request body
    const bulkBody = [];
    for (const note of notes) {
      const document = {
        userId: userId, // Always include userId for security
        fileName: note.fileName || '',
        page: note.page || 0,
        category: note.category || '',
        content: note.content || '',
        markdown: note.markdown || '',
        date: note.date || '',
        location: note.location || '',
        type: note.type || '',
        author: note.author || '',
        created: note.created || '',
        indexedAt: new Date().toISOString()
      };

      // Generate document ID
      // Include noteIndex to prevent overwrites when multiple notes share the same page/category
      const noteIndex = note.noteIndex || 0;
      const docId = `${userId}-${note.fileName || 'unknown'}-${note.page || 0}-${(note.category || 'uncategorized').replace(/[^a-z0-9-]/gi, '-')}-${noteIndex}`;
      const safeDocId = Buffer.from(docId).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 100);

      // Bulk format: action line + document line
      bulkBody.push(JSON.stringify({ index: { _index: indexName, _id: safeDocId } }));
      bulkBody.push(JSON.stringify(document));
    }

    try {
      const response = await fetch(`${this.endpoint}/_bulk`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/x-ndjson'
        },
        body: bulkBody.join('\n') + '\n'
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to bulk index notes: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      
      // Check for errors in bulk response
      const errors = [];
      if (result.items) {
        for (const item of result.items) {
          if (item.index && item.index.error) {
            errors.push(item.index.error);
          }
        }
      }

      // Refresh the index to make documents immediately searchable
      try {
        await fetch(`${this.endpoint}/${indexName}/_refresh`, {
          method: 'POST',
          headers: this.getHeaders()
        });
      } catch (refreshError) {
        // Non-critical - index will refresh automatically
        console.warn('Note: Index refresh failed (non-critical):', refreshError.message);
      }

      return {
        success: errors.length === 0,
        indexed: result.items ? result.items.length : 0,
        errors: errors
      };
    } catch (error) {
      console.error('❌ Error bulk indexing clinical notes:', error);
      throw error;
    }
  }

  /**
   * Search clinical notes for a userId
   * Security: userId is ALWAYS enforced in the query
   * @param {string} userId - User ID (required for security)
   * @param {object} searchOptions - Search options (query, category, fileName, page, etc.)
   * @returns {Promise<object>} Search results
   */
  async searchNotes(userId, searchOptions = {}) {
    if (!userId) {
      throw new Error('userId is required for searching');
    }

    const indexName = this.getIndexName(userId);
    
    // Build query with userId ALWAYS enforced
    const mustClauses = [
      { term: { userId: userId } } // CRITICAL: Always filter by userId for security
    ];

    // Add optional filters
    if (searchOptions.category) {
      mustClauses.push({ term: { category: searchOptions.category } });
    }

    if (searchOptions.fileName) {
      mustClauses.push({ term: { fileName: searchOptions.fileName } });
    }

    if (searchOptions.page !== undefined) {
      mustClauses.push({ term: { page: searchOptions.page } });
    }

    // Add text search if query provided
    // If query is '*', use match_all instead of text search
    if (searchOptions.query && searchOptions.query !== '*') {
      mustClauses.push({
        multi_match: {
          query: searchOptions.query,
          fields: ['content^2', 'markdown', 'category'], // Boost content field
          type: 'best_fields',
          fuzziness: 'AUTO'
        }
      });
    }

    // Build query - use match_all if query is '*', otherwise use bool with must clauses
    let query;
    if (searchOptions.query === '*') {
      // Match all documents (still filtered by userId)
      query = {
        query: {
          bool: {
            must: mustClauses // userId filter is always in mustClauses
          }
        },
        size: searchOptions.size || 100,
        from: searchOptions.from || 0,
        sort: searchOptions.sort || [
          { fileName: { order: 'asc' } },
          { page: { order: 'asc' } }
        ]
      };
    } else {
      query = {
        query: {
          bool: {
            must: mustClauses
          }
        },
        size: searchOptions.size || 100,
        from: searchOptions.from || 0,
        sort: searchOptions.sort || [
          { fileName: { order: 'asc' } },
          { page: { order: 'asc' } }
        ]
      };
    }

    try {
      const response = await fetch(`${this.endpoint}/${indexName}/_search`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(query)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to search notes: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      
      // Handle different total formats from OpenSearch
      let total = 0;
      if (result.hits?.total) {
        if (typeof result.hits.total === 'number') {
          total = result.hits.total;
        } else if (result.hits.total.value !== undefined) {
          total = result.hits.total.value;
        }
      }
      
      return {
        success: true,
        total: total,
        hits: (result.hits?.hits || []).map(hit => ({
          id: hit._id,
          score: hit._score,
          source: hit._source
        }))
      };
    } catch (error) {
      console.error('❌ Error searching clinical notes:', error);
      throw error;
    }
  }

  /**
   * Get all categories for a userId
   * @param {string} userId - User ID
   * @returns {Promise<Array<{category: string, count: number}>>} Categories with counts
   */
  async getCategories(userId) {
    if (!userId) {
      throw new Error('userId is required');
    }

    const indexName = this.getIndexName(userId);
    
    const query = {
      query: {
        term: { userId: userId } // Security: always filter by userId
      },
      size: 0, // Don't return documents, just aggregations
      aggs: {
        categories: {
          terms: {
            field: 'category',
            size: 1000
          }
        }
      }
    };

    try {
      const response = await fetch(`${this.endpoint}/${indexName}/_search`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(query)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to get categories: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      
      const categories = (result.aggregations?.categories?.buckets || []).map(bucket => ({
        category: bucket.key,
        count: bucket.doc_count
      }));

      return categories;
    } catch (error) {
      console.error('❌ Error getting categories:', error);
      throw error;
    }
  }

  /**
   * Delete all notes for a userId (useful for re-indexing)
   * @param {string} userId - User ID
   * @returns {Promise<object>} Deletion result
   */
  async deleteAllNotes(userId) {
    if (!userId) {
      throw new Error('userId is required');
    }

    const indexName = this.getIndexName(userId);
    
    // Delete by query - only delete documents with this userId (extra security)
    const query = {
      query: {
        term: { userId: userId }
      }
    };

    try {
      const response = await fetch(`${this.endpoint}/${indexName}/_delete_by_query`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(query)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to delete notes: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      return {
        success: true,
        deleted: result.deleted || 0
      };
    } catch (error) {
      console.error('❌ Error deleting notes:', error);
      throw error;
    }
  }

  /**
   * Delete notes for a specific fileName (useful when re-processing a PDF)
   * @param {string} userId - User ID
   * @param {string} fileName - File name to delete notes for
   * @returns {Promise<object>} Deletion result
   */
  async deleteNotesByFileName(userId, fileName) {
    if (!userId) {
      throw new Error('userId is required');
    }

    if (!fileName) {
      throw new Error('fileName is required');
    }

    const indexName = this.getIndexName(userId);
    
    // Delete by query - only delete documents with this userId AND fileName (security + specificity)
    const query = {
      query: {
        bool: {
          must: [
            { term: { userId: userId } }, // Security: always filter by userId
            { term: { fileName: fileName } } // Delete only notes from this file
          ]
        }
      }
    };

    try {
      const response = await fetch(`${this.endpoint}/${indexName}/_delete_by_query`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(query)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to delete notes: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      return {
        success: true,
        deleted: result.deleted || 0
      };
    } catch (error) {
      console.error('❌ Error deleting notes by fileName:', error);
      throw error;
    }
  }

  /**
   * Get headers for API requests
   */
  getHeaders() {
    const headers = {
      'Content-Type': 'application/json'
    };

    if (this.authHeader) {
      headers['Authorization'] = this.authHeader;
    }

    return headers;
  }
}

