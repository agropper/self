/**
 * Agent helper for getting and creating API keys for agents
 */

import { AgentClient } from '../../lib/do-client/agent.js';

/**
 * Get agent API key from user document
 * If missing, create a new one
 */
export async function getOrCreateAgentApiKey(doClient, cloudant, userId, agentId) {
  try {
    // Get user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    // Check if user has a stored API key
    if (userDoc.agentApiKey) {
      console.log(`✅ Using existing API key for agent ${agentId}`);
      return userDoc.agentApiKey;
    }
    
    // No API key stored - create one
    console.log(`No API key found in database for agent ${agentId}, creating one...`);
    
    try {
      const agentClient = new AgentClient(doClient);
      const apiKey = await agentClient.createApiKey(agentId, `agent-${agentId}-api-key`);
      
      // Save the new API key to the user document
      userDoc.agentApiKey = apiKey;
      await cloudant.saveDocument('maia_users', userDoc);
      
      console.log(`✅ Created and saved new API key for agent ${agentId}`);
      return apiKey;
    } catch (createError) {
      console.error(`❌ Failed to create API key for agent ${agentId}:`, createError.message);
      throw new Error(`Failed to create API key for agent: ${createError.message}`);
    }
    
  } catch (error) {
    console.error(`Error in getOrCreateAgentApiKey for user ${userId}:`, error.message);
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

