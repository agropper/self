/**
 * Agent client for DigitalOcean GenAI
 */

export class AgentClient {
  constructor(doClient) {
    this.client = doClient;
  }

  /**
   * List all agents
   */
  async list() {
    const response = await this.client.request('/v2/gen-ai/agents');
    return response.agents || response.data?.agents || [];
  }

  /**
   * Get agent details
   */
  async get(agentId) {
    const response = await this.client.request(`/v2/gen-ai/agents/${agentId}`);
    return response.agent || response.data?.agent || response.data || response;
  }

  /**
   * Create a new agent
   */
  async create(options) {
    const {
      name,
      instruction,
      modelId,
      projectId,
      apiKey
    } = options;

    if (!name || !modelId || !projectId) {
      throw new Error('name, modelId, and projectId are required');
    }

    const agentData = {
      name,
      instruction: instruction || '',
      model: { uuid: modelId },
      project_id: projectId
    };

    if (apiKey) {
      agentData.api_key = apiKey;
    }

    const response = await this.client.request('/v2/gen-ai/agents', {
      method: 'POST',
      body: JSON.stringify(agentData)
    });

    return response.agent || response.data || response;
  }

  /**
   * Update agent
   */
  async update(agentId, updates) {
    const response = await this.client.request(`/v2/gen-ai/agents/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });

    return response.agent || response.data || response;
  }

  /**
   * Delete agent
   */
  async delete(agentId) {
    await this.client.request(`/v2/gen-ai/agents/${agentId}`, {
      method: 'DELETE'
    });
    return { deleted: true };
  }

  /**
   * Attach knowledge base to agent
   */
  async attachKB(agentId, kbId) {
    const response = await this.client.request(
      `/v2/gen-ai/agents/${agentId}/knowledge_bases/${kbId}`,
      { method: 'POST' }
    );
    return response.data || response;
  }

  /**
   * Detach knowledge base from agent
   */
  async detachKB(agentId, kbId) {
    await this.client.request(
      `/v2/gen-ai/agents/${agentId}/knowledge_bases/${kbId}`,
      { method: 'DELETE' }
    );
    return { detached: true };
  }

  /**
   * Create API key for agent
   */
  async createApiKey(agentId, name = null, description = null) {
    console.log(`[API KEY] Creating API key for agent ${agentId}`);
    console.log(`[API KEY] Name: ${name || `agent-${agentId}-api-key`}`);
    
    const response = await this.client.request(
      `/v2/gen-ai/agents/${agentId}/api_keys`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: name || `agent-${agentId}-api-key`,
          description: description || `API key for agent ${agentId}`
        })
      }
    );
    
    console.log(`[API KEY] Response:`, JSON.stringify(response, null, 2));
    
    // DigitalOcean API returns: { api_key_info: { secret_key: "..." } }
    const apiKey = response.api_key_info?.secret_key || response.api_key?.key || response.key || response.data?.key;
    
    if (apiKey) {
      console.log(`[API KEY] ✅ Successfully created API key for agent ${agentId}`);
    } else {
      console.log(`[API KEY] ❌ No API key found in response for agent ${agentId}`);
    }
    
    return apiKey;
  }
}

