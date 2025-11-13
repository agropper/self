/**
 * Indexing jobs client for DigitalOcean GenAI
 */

export class IndexingClient {
  constructor(doClient) {
    this.client = doClient;
  }

  /**
   * Start an indexing job for a specific data source
   */
  async start(kbId, dataSourceUuid) {
    const response = await this.client.request(
      `/v2/gen-ai/knowledge_bases/${kbId}/indexing_jobs`,
      {
        method: 'POST',
        body: JSON.stringify({
          data_source_uuid: dataSourceUuid
        })
      }
    );

    return response.indexing_job || response.data || response;
  }

  /**
   * Start global indexing job (alternative endpoint)
   */
  async startGlobal(kbId, dataSourceUuids) {
    const response = await this.client.request('/v2/gen-ai/indexing_jobs', {
      method: 'POST',
      body: JSON.stringify({
        knowledge_base_uuid: kbId,
        data_source_uuids: Array.isArray(dataSourceUuids) ? dataSourceUuids : [dataSourceUuids]
      })
    });

    return response.indexing_job || response.data || response;
  }

  /**
   * Get indexing job status
   */
  async getStatus(jobId) {
    const response = await this.client.request(`/v2/gen-ai/indexing_jobs/${jobId}`);
    return response.indexing_job || response.data || response;
  }

  /**
   * List indexing jobs for a knowledge base
   * Returns the latest 15 indexing jobs for the specified KB
   */
  async listForKB(kbId) {
    const endpoint = `/v2/gen-ai/knowledge_bases/${kbId}/indexing_jobs`;
    const response = await this.client.request(endpoint);
    
    // Try multiple possible response formats
    // The actual API returns { "jobs": [...] }
    if (Array.isArray(response)) {
      return response;
    } else if (response.jobs && Array.isArray(response.jobs)) {
      return response.jobs; // This is the actual format!
    } else if (response.indexing_jobs && Array.isArray(response.indexing_jobs)) {
      return response.indexing_jobs;
    } else if (response.data && Array.isArray(response.data)) {
      return response.data;
    } else if (response.data && response.data.jobs && Array.isArray(response.data.jobs)) {
      return response.data.jobs;
    } else if (response.data && response.data.indexing_jobs && Array.isArray(response.data.indexing_jobs)) {
      return response.data.indexing_jobs;
    } else {
      // Return empty array if no jobs found
      return [];
    }
  }

  /**
   * Cancel an indexing job
   */
  async cancel(jobId) {
    const response = await this.client.request(
      `/v2/gen-ai/indexing_jobs/${jobId}`,
      {
        method: 'DELETE'
      }
    );
    return response;
  }

  /**
   * Poll indexing job until completion
   */
  async poll(jobId, options = {}) {
    const { maxAttempts = 500, intervalMs = 5000, onProgress } = options;

    let attempts = 0;
    while (attempts < maxAttempts) {
      const status = await this.getStatus(jobId);

      if (onProgress) {
        onProgress(status, attempts + 1);
      }

      if (status.status === 'INDEX_JOB_STATUS_COMPLETED') {
        return status;
      }

      if (status.status === 'INDEX_JOB_STATUS_FAILED') {
        throw new Error(`Indexing job failed: ${status.error || 'Unknown error'}`);
      }

      attempts++;
      if (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }

    throw new Error(`Indexing job timed out after ${maxAttempts} attempts`);
  }
}

