/**
 * TEMPORARY FILE: KB Creation Fallback Logic
 * 
 * This code was removed from setupKnowledgeBase() to simplify KB creation.
 * It contains fallback logic for getting projectId, databaseId, and embeddingModelId
 * from existing agents/KBs when environment variables are not set.
 * 
 * Date removed: 2025-11-06
 * 
 * To restore: Copy the getProjectIdAndDatabaseId() function and uncomment the call in setupKnowledgeBase()
 */

/**
 * Get project ID, database ID, and embedding model ID from existing resources
 * This is a fallback when environment variables are not set
 */
async function getProjectIdAndDatabaseId(allKBsCache, kbDetails, existingKbFound) {
  let projectId = process.env.DO_PROJECT_ID;
  let databaseId = process.env.DO_DATABASE_ID;
  let embeddingModelId = null;
  
  // Validate UUID format helper
  const isValidUUID = (str) => {
    if (!str || typeof str !== 'string') return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str.trim());
  };
  
  // Try to get project ID from existing agents if not in env
  if (!isValidUUID(projectId)) {
    try {
      console.log(`[KB AUTO] Calling doClient.agent.list() to get project ID from existing agents`);
      const agents = await doClient.agent.list();
      if (agents.length > 0) {
        console.log(`[KB AUTO] Calling doClient.agent.get(${agents[0].uuid}) to extract project ID`);
        const existingAgent = await doClient.agent.get(agents[0].uuid);
        if (existingAgent.project_id && isValidUUID(existingAgent.project_id)) {
          projectId = existingAgent.project_id;
          console.log(`[KB Setup] Using project ID from existing agent: ${projectId}`);
        }
      }
    } catch (error) {
      console.error('[KB Setup] Error getting project ID from agents:', error);
    }
  }
  
  // Try to get database ID and embedding model ID from existing KBs if not in env
  // Use cached KB list from Step 1, or fetch if needed
  if (!allKBsCache || allKBsCache.length === 0) {
    try {
      console.log(`[KB AUTO] Calling doClient.kb.list() (fallback) to get KB list for extracting IDs`);
      allKBsCache = await doClient.kb.list();
    } catch (error) {
      console.error('[KB Setup] Error getting KB list for fallback:', error);
    }
  }
  
  if (allKBsCache && allKBsCache.length > 0) {
    try {
      // Get the first KB to extract database ID and embedding model ID
      // Use cached KB details if available (from existing KB), otherwise fetch
      let firstKB = null;
      if (kbDetails && existingKbFound) {
        // If we have kbDetails from an existing KB (found in Step 1), use it
        firstKB = kbDetails;
      } else {
        // Otherwise fetch from first KB in list
        console.log(`[KB AUTO] Calling doClient.kb.get(${allKBsCache[0].uuid}) to extract database ID and embedding model ID`);
        firstKB = await doClient.kb.get(allKBsCache[0].uuid);
      }
      
      // Extract database ID if needed
      if (!isValidUUID(databaseId) && firstKB.database_id && isValidUUID(firstKB.database_id)) {
        databaseId = firstKB.database_id;
        console.log(`[KB Setup] Using database ID from existing KB: ${databaseId}`);
      }
      
      // Extract embedding model ID (always needed)
      if (firstKB.embedding_model_uuid && isValidUUID(firstKB.embedding_model_uuid)) {
        embeddingModelId = firstKB.embedding_model_uuid;
        console.log(`[KB Setup] Using embedding model ID from existing KB: ${embeddingModelId}`);
      } else if (firstKB.embedding_model && firstKB.embedding_model.uuid && isValidUUID(firstKB.embedding_model.uuid)) {
        embeddingModelId = firstKB.embedding_model.uuid;
        console.log(`[KB Setup] Using embedding model ID from existing KB (nested): ${embeddingModelId}`);
      }
    } catch (error) {
      console.error('[KB Setup] Error getting IDs from existing KBs:', error);
    }
  }
  
  return { projectId, databaseId, embeddingModelId, isValidUUID };
}

/**
 * REMOVED CODE FROM setupKnowledgeBase() - Date: 2025-11-06
 * 
 * This code was removed after KB creation to simplify the flow.
 * It included:
 * - Datasource checking and retry logic
 * - Polling for auto-started indexing jobs
 * - Data source management (add/update/delete)
 * - Manual indexing job start
 * 
 * The new approach: Create KB, then poll for indexing jobs every 10 seconds until completion.
 */

// REMOVED: Datasource checking and retry logic (lines 2832-2858)
// REMOVED: Polling for auto-started indexing job (lines 2860-2911)
// REMOVED: Step 3: Data source management (lines 2918-3035)
// REMOVED: Step 4: Manual indexing job start (lines 3037-3125)
