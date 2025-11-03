/**
 * Agent helper for getting and creating API keys for agents
 */

import { AgentClient } from '../../lib/do-client/agent.js';

/**
 * Get agent API key from user document
 * If missing, create a new one
 */
export async function getOrCreateAgentApiKey(doClient, cloudant, userId, agentId) {
  console.log(`[API KEY] getOrCreateAgentApiKey called for user ${userId}, agent ${agentId}`);
  
  try {
    // Get user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    console.log(`[API KEY] User doc retrieved, has agentApiKey: ${!!userDoc.agentApiKey}`);
    
    // Check if user has a stored API key
    if (userDoc.agentApiKey) {
      console.log(`[API KEY] ✅ Using existing API key for agent ${agentId}`);
      return userDoc.agentApiKey;
    }
    
    // No API key stored - create one
    console.log(`[API KEY] No API key found in database for agent ${agentId}, creating one...`);
    
    try {
      const agentClient = new AgentClient(doClient);
      const apiKey = await agentClient.createApiKey(agentId, `agent-${agentId}-api-key`);
      
      if (!apiKey) {
        throw new Error('API key was null/undefined after creation');
      }
      
      // Save the new API key to the user document
      userDoc.agentApiKey = apiKey;
      await cloudant.saveDocument('maia_users', userDoc);
      
      console.log(`[API KEY] ✅ Created and saved new API key for agent ${agentId}`);
      return apiKey;
    } catch (createError) {
      console.error(`[API KEY] ❌ Failed to create API key for agent ${agentId}:`, createError.message);
      console.error(`[API KEY] Error stack:`, createError.stack);
      throw new Error(`Failed to create API key for agent: ${createError.message}`);
    }
    
  } catch (error) {
    console.error(`[API KEY] Error in getOrCreateAgentApiKey for user ${userId}:`, error.message);
    throw error;
  }
}

/**
 * Find user's agent by name pattern (e.g., "sun6-agent-*" for user "sun6")
 */
export async function findUserAgent(doClient, userId) {
  try {
    const agentClient = new AgentClient(doClient);
    const agents = await agentClient.list();
    
    // Pattern: {userId}-agent-*
    const agentPattern = new RegExp(`^${userId}-agent-`);
    const userAgent = agents.find(agent => agentPattern.test(agent.name));
    
    return userAgent || null;
  } catch (error) {
    console.error(`Error finding agent for user ${userId}:`, error.message);
    return null;
  }
}

