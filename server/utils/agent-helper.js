/**
 * Agent helper for getting and creating API keys for agents
 */

import { AgentClient } from '../../lib/do-client/agent.js';

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const ensureAgentProfileApiKey = (userDoc, agentId, apiKey) => {
  if (!isPlainObject(userDoc.agentProfiles)) {
    userDoc.agentProfiles = {};
  }
  const defaultKey = userDoc.agentProfileDefaultKey || 'default';
  const existingProfile = isPlainObject(userDoc.agentProfiles[defaultKey])
    ? { ...userDoc.agentProfiles[defaultKey] }
    : {};

  let updated = false;

  if (!existingProfile.agentId) {
    existingProfile.agentId = agentId;
    updated = true;
  }
  if (existingProfile.agentId === agentId && apiKey && existingProfile.apiKey !== apiKey) {
    existingProfile.apiKey = apiKey;
    updated = true;
  }
  if (!existingProfile.agentName && userDoc.assignedAgentName) {
    existingProfile.agentName = userDoc.assignedAgentName;
    updated = true;
  }
  if (!existingProfile.endpoint && userDoc.agentEndpoint) {
    existingProfile.endpoint = userDoc.agentEndpoint;
    updated = true;
  }
  if (!existingProfile.modelName && userDoc.agentModelName) {
    existingProfile.modelName = userDoc.agentModelName;
    updated = true;
  }

  const now = new Date().toISOString();
  if (!existingProfile.createdAt) {
    existingProfile.createdAt = now;
    updated = true;
  }
  if (updated) {
    existingProfile.updatedAt = now;
    existingProfile.lastSyncedAt = now;
  }

  userDoc.agentProfiles[defaultKey] = existingProfile;
  if (!userDoc.agentProfileDefaultKey) {
    userDoc.agentProfileDefaultKey = defaultKey;
  }
  if (!isPlainObject(userDoc.deepLinkAgentOverrides)) {
    userDoc.deepLinkAgentOverrides = {};
  }
};

/**
 * Get agent API key from user document
 * If missing, create a new one
 * If invalid, recreate it
 */
export async function getOrCreateAgentApiKey(doClient, cloudant, userId, agentId) {
  try {
    const saveUserDocWithRetry = async (applyUpdate, maxRetries = 3) => {
      let attempt = 0;
      let lastError = null;
      while (attempt < maxRetries) {
        attempt += 1;
        const latestDoc = await cloudant.getDocument('maia_users', userId);
        const updatedDoc = applyUpdate(latestDoc);
        try {
          await cloudant.saveDocument('maia_users', updatedDoc);
          return updatedDoc;
        } catch (error) {
          const isConflict = error?.statusCode === 409 || error?.error === 'conflict' || /conflict/i.test(error?.message || '');
          if (!isConflict || attempt >= maxRetries) {
            throw error;
          }
          lastError = error;
        }
      }
      if (lastError) {
        throw lastError;
      }
    };

    // Get user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (isPlainObject(userDoc.agentProfiles)) {
      const profileWithKey = Object.values(userDoc.agentProfiles).find(profile =>
        isPlainObject(profile) && profile.agentId === agentId && profile.apiKey
      );
      if (profileWithKey?.apiKey) {
        if (!userDoc.agentApiKey || userDoc.agentApiKey !== profileWithKey.apiKey) {
          await saveUserDocWithRetry(latestDoc => {
            latestDoc.agentApiKey = profileWithKey.apiKey;
            ensureAgentProfileApiKey(latestDoc, agentId, profileWithKey.apiKey);
            return latestDoc;
          });
        }
        return profileWithKey.apiKey;
      }
    }

    // Check if user has a stored API key
    if (userDoc.agentApiKey) {
      // Note: We used to validate keys by calling listApiKeys(), but that endpoint
      // doesn't seem to return the keys we create (returns 0 keys even though keys exist).
      // Instead, we'll use a "lazy validation" approach:
      // - Return the stored key and let the actual API call determine if it's valid
      // - If we get a 401 Unauthorized, the error handler will call recreateAgentApiKey()
      // This is more reliable than trying to proactively validate via listApiKeys()
      return userDoc.agentApiKey;
    }
    
    // No API key stored - create one
    const agentClient = new AgentClient(doClient);
    const apiKey = await agentClient.createApiKey(agentId, `agent-${agentId}-api-key`);
    
    if (!apiKey) {
      throw new Error('API key was null/undefined after creation');
    }
    
    // Save the new API key to the user document
    await saveUserDocWithRetry(latestDoc => {
      latestDoc.agentApiKey = apiKey;
      ensureAgentProfileApiKey(latestDoc, agentId, apiKey);
      return latestDoc;
    });
    
    return apiKey;
  } catch (error) {
    console.error(`Error in getOrCreateAgentApiKey for user ${userId}:`, error.message);
    throw error;
  }
}

/**
 * Recreate agent API key (used when existing key is invalid)
 */
export async function recreateAgentApiKey(doClient, cloudant, userId, agentId) {
  try {
    const saveUserDocWithRetry = async (applyUpdate, maxRetries = 3) => {
      let attempt = 0;
      let lastError = null;
      while (attempt < maxRetries) {
        attempt += 1;
        const latestDoc = await cloudant.getDocument('maia_users', userId);
        const updatedDoc = applyUpdate(latestDoc);
        try {
          await cloudant.saveDocument('maia_users', updatedDoc);
          return updatedDoc;
        } catch (error) {
          const isConflict = error?.statusCode === 409 || error?.error === 'conflict' || /conflict/i.test(error?.message || '');
          if (!isConflict || attempt >= maxRetries) {
            throw error;
          }
          lastError = error;
        }
      }
      if (lastError) {
        throw lastError;
      }
    };

    const agentClient = new AgentClient(doClient);
    const apiKey = await agentClient.createApiKey(agentId, `agent-${agentId}-api-key`);
    
    if (!apiKey) {
      throw new Error('API key was null/undefined after creation');
    }
    
    // Save the new API key to the user document
    await saveUserDocWithRetry(latestDoc => {
      latestDoc.agentApiKey = apiKey;
      ensureAgentProfileApiKey(latestDoc, agentId, apiKey);
      return latestDoc;
    });
    
    return apiKey;
  } catch (error) {
    console.error(`Error recreating API key for agent ${agentId}:`, error.message);
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

    const agentPattern = new RegExp(`^${userId}-agent-`);
    const basicAgent = agents.find(agent => agentPattern.test(agent.name));

    if (!basicAgent) {
      return null;
    }

    // Don't log - this is called frequently during sync operations
    // The sync-agent endpoint already logs success/errors

    try {
      const detailedAgent = await agentClient.get(basicAgent.uuid || basicAgent.id || basicAgent.agent_id || basicAgent.agentId || basicAgent.agent_uuid);
      if (detailedAgent) {
        return detailedAgent;
      }
    } catch (detailError) {
      console.warn(`⚠️ Unable to fetch detailed info for agent ${basicAgent.uuid || basicAgent.id}: ${detailError.message}`);
    }

    return basicAgent;
  } catch (error) {
    console.error(`Error finding agent for user ${userId}:`, error.message);
    return null;
  }
}
