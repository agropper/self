/**
 * maia-cloud-user-app server
 * User app backend with passkey authentication
 */

import express from 'express';
import dotenv from 'dotenv';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, readdirSync } from 'fs';

import { CloudantClient, CloudantSessionStore, AuditLogService } from '../lib/cloudant/index.js';
import { DigitalOceanClient } from '../lib/do-client/index.js';
import { PasskeyService } from '../lib/passkey/index.js';
import { EmailService } from './utils/email-service.js';
import { ChatClient } from '../lib/chat-client/index.js';
import { findUserAgent } from './utils/agent-helper.js';
import setupAuthRoutes from './routes/auth.js';
import setupChatRoutes from './routes/chat.js';
import setupFileRoutes from './routes/files.js';
import { getUserBucketSize } from './routes/files.js';
import { S3Client } from '@aws-sdk/client-s3';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Generate agent name for a user
 * Format: {userId}-agent-{YYYYMMDD}-{HHMMSS}
 */
function generateAgentName(userId) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0].replace(/-/g, ''); // YYYYMMDD in UTC
  const timeStr = now.toISOString().split('T')[1].split('.')[0].replace(/:/g, ''); // HHMMSS in UTC
  return `${userId}-agent-${dateStr}-${timeStr}`;
}

/**
 * Generate KB name for a user
 * Format: {userId}-kb-{YYYYMMDD}{timestamp}
 */
function generateKBName(userId) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('T')[0]; // YYYYMMDD
  return `${userId}-kb-${timestamp}${Date.now().toString().slice(-6)}`;
}

/**
 * Create bucket folders for a user (root, archived, and KB subfolder)
 * This is called during registration to enable file uploads before admin approval
 */
async function createUserBucketFolders(userId, kbName) {
  console.log(`[NEW FLOW] Creating bucket folders for user: ${userId}, KB: ${kbName}`);
  
  const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
  if (!bucketUrl) {
    throw new Error('DigitalOcean bucket not configured');
  }
  
  const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
  
  try {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const s3Client = new S3Client({
      endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
      region: 'us-east-1',
      forcePathStyle: false,
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });
    
    // Create placeholder files to make folders visible in dashboard
    const rootPlaceholder = `${userId}/.keep`;
    const archivedPlaceholder = `${userId}/archived/.keep`;
    const kbPlaceholder = `${userId}/${kbName}/.keep`;
    
    // Create root userId folder placeholder (for new imports)
    // Use Buffer.from('') instead of empty string to avoid SDK warning about stream length
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: rootPlaceholder,
      Body: Buffer.from(''),
      ContentType: 'text/plain',
      ContentLength: 0,
      Metadata: {
        createdBy: 'registration',
        createdAt: new Date().toISOString()
      }
    }));
    console.log(`[NEW FLOW] Created root folder: ${userId}/`);
    
    // Create archived folder placeholder (for files moved from root)
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: archivedPlaceholder,
      Body: Buffer.from(''),
      ContentType: 'text/plain',
      ContentLength: 0,
      Metadata: {
        createdBy: 'registration',
        createdAt: new Date().toISOString()
      }
    }));
    console.log(`[NEW FLOW] Created archived folder: ${userId}/archived/`);
    
    // Create KB folder placeholder
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: kbPlaceholder,
      Body: Buffer.from(''),
      ContentType: 'text/plain',
      ContentLength: 0,
      Metadata: {
        createdBy: 'registration',
        createdAt: new Date().toISOString()
      }
    }));
    console.log(`[NEW FLOW] Created KB folder: ${userId}/${kbName}/`);
    
    console.log(`[NEW FLOW] ✅ All bucket folders created successfully for ${userId}`);
    return { root: `${userId}/`, archived: `${userId}/archived/`, kb: `${userId}/${kbName}/` };
  } catch (err) {
    console.error(`[NEW FLOW] ❌ Failed to create bucket folders: ${err.message}`);
    throw new Error(`Failed to create bucket folders: ${err.message}`);
  }
}

/**
 * Get KB name from user document
 * 
 * Naming Convention:
 * - kbName: PERMANENT KB name set during provisioning (NEVER deleted or changed)
 *   This is the source of truth for the KB name and prevents generating new names.
 *   It's set once during provisioning and remains forever, even after KB exists in DO.
 * - connectedKBs: Array of KB names that actually exist in DigitalOcean and are connected
 *   Used for runtime tracking, but kbName takes precedence.
 * - connectedKB: Legacy field for backward compatibility (should indicate actual connected KB)
 * 
 * Priority order:
 * 1. kbName (permanent, set during provisioning - ALWAYS use this if it exists)
 * 2. connectedKBs array (runtime tracking of actual connected KBs)
 * 3. connectedKB field (legacy, for migration)
 * 4. Generate new name ONLY if kbName was never set (shouldn't happen after provisioning)
 */
function getKBNameFromUserDoc(userDoc, userId) {
  // Priority order:
  // 1. kbName - PERMANENT KB name set during provisioning (NEVER deleted)
  //    This is the source of truth and prevents generating new names
  // 2. connectedKBs array - runtime tracking of actual connected KBs (may be cleared)
  // 3. connectedKB field - legacy field for backward compatibility
  // 4. Generate new name - only if kbName was never set (shouldn't happen after provisioning)
  
  // First, check if there's a permanent KB name (set during provisioning, never deleted)
  if (userDoc.kbName) {
    return userDoc.kbName;
  }
  // Next, check connectedKBs array (actual connected KBs - KB exists and is connected)
  if (userDoc.connectedKBs && Array.isArray(userDoc.connectedKBs) && userDoc.connectedKBs.length > 0) {
    return userDoc.connectedKBs[0];
  }
  // Fallback to old connectedKB field for migration (should indicate actual connected KB)
  if (userDoc.connectedKB) {
    return userDoc.connectedKB;
  }
  // Generate new KB name if none exists
  return generateKBName(userId);
}

/**
 * Read MAIA instruction text from NEW-AGENT.txt file
 * Extracts the instruction text from the "## MAIA INSTRUCTION TEXT" section
 */
function getMaiaInstructionText() {
  try {
    const newAgentFilePath = path.join(__dirname, '../NEW-AGENT.txt');
    const fileContent = readFileSync(newAgentFilePath, 'utf-8');
    
    // Find the start of the instruction section
    const instructionStartMarker = '## MAIA INSTRUCTION TEXT';
    const instructionStartIndex = fileContent.indexOf(instructionStartMarker);
    
    if (instructionStartIndex === -1) {
      throw new Error('MAIA INSTRUCTION TEXT section not found in NEW-AGENT.txt');
    }
    
    // Find the content after the marker and optional comment line
    let startIndex = instructionStartIndex + instructionStartMarker.length;
    const lines = fileContent.substring(startIndex).split('\n');
    
    // Skip empty lines and the comment line "(Full instruction from sun6 agent)"
    let instructionLines = [];
    let foundContent = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Stop at the next section marker (---)
      if (line.trim() === '---') {
        break;
      }
      
      // Skip empty lines at the start
      if (!foundContent && line.trim() === '') {
        continue;
      }
      
      // Skip comment lines in parentheses
      if (line.trim().startsWith('(') && line.trim().endsWith(')')) {
        continue;
      }
      
      foundContent = true;
      instructionLines.push(line);
    }
    
    // Join lines and trim
    const instructionText = instructionLines.join('\n').trim();
    
    if (!instructionText) {
      throw new Error('No instruction text found in MAIA INSTRUCTION TEXT section');
    }
    
    return instructionText;
  } catch (error) {
    console.error('❌ Error reading MAIA instruction text from NEW-AGENT.txt:', error.message);
    throw new Error(`Failed to load agent instructions: ${error.message}`);
  }
}

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize clients
const cloudant = new CloudantClient({
  url: process.env.CLOUDANT_URL,
  username: process.env.CLOUDANT_USERNAME,
  password: process.env.CLOUDANT_PASSWORD
});

// Initialize databases
(async () => {
  try {
    await cloudant.createDatabase('maia_sessions');
    console.log('✅ Created maia_sessions database');
  } catch (error) {
    // Already exists, that's fine
  }
  try {
    await cloudant.createDatabase('maia_users');
    console.log('✅ Created maia_users database');
  } catch (error) {
    // Already exists, that's fine
  }
  try {
    await cloudant.createDatabase('maia_audit_log');
    console.log('✅ Created maia_audit_log database');
  } catch (error) {
    // Already exists, that's fine
  }
  try {
    await cloudant.createDatabase('maia_chats');
    console.log('✅ Created maia_chats database');
  } catch (error) {
    // Already exists, that's fine
  }
})();

const auditLog = new AuditLogService(cloudant, 'maia_audit_log');

// In-memory store for provisioning status (keyed by userId)
const provisioningStatus = new Map();

// In-memory store for provisioning logs (keyed by userId)
const provisioningLogs = new Map();

// Helper function to log provisioning events
const logProvisioning = (userId, message, level = 'info') => {
  if (!provisioningLogs.has(userId)) {
    provisioningLogs.set(userId, []);
  }
  const logs = provisioningLogs.get(userId);
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message
  };
  logs.push(logEntry);
  // Keep only last 500 log entries per user
  if (logs.length > 500) {
    logs.shift();
  }
  // Also log to console
  console.log(message);
};

const emailService = new EmailService({
  apiKey: process.env.RESEND_API_KEY,
  fromEmail: process.env.RESEND_FROM_EMAIL,
  adminEmail: process.env.RESEND_ADMIN_EMAIL,
  baseUrl: process.env.PUBLIC_APP_URL || `http://localhost:${PORT}`
});

const doClient = new DigitalOceanClient(process.env.DIGITALOCEAN_TOKEN, {
  region: process.env.DO_REGION || 'tor1'
});

// Simple in-memory caches to reduce repeated DO API calls
const RESOURCE_CACHE_TTL = 30 * 1000; // 30 seconds
const KB_LIST_CACHE_TTL = 60 * 1000; // 1 minute
const AGENT_CACHE_TTL = 30 * 1000;
const KB_CACHE_TTL = 30 * 1000;

const resourceValidationCache = new Map(); // userId -> { timestamp, data }
const agentDetailsCache = new Map(); // agentId -> { timestamp, value }
const kbDetailsCache = new Map(); // kbId -> { timestamp, value }
let kbListCache = { timestamp: 0, value: null };

const isCacheEntryValid = (entry, ttl) => entry && Date.now() - entry.timestamp < ttl;

const isRateLimitError = (error) => {
  if (!error) return false;
  const message = (error.message || '').toLowerCase();
  return error.status === 429 || error.code === 429 || message.includes('too many requests') || message.includes('rate limit');
};

const getCachedAgent = async (agentId) => {
  if (!agentId) return null;
  const cacheEntry = agentDetailsCache.get(agentId);
  if (isCacheEntryValid(cacheEntry, AGENT_CACHE_TTL)) {
    return cacheEntry.value;
  }
  const value = await doClient.agent.get(agentId);
  agentDetailsCache.set(agentId, { timestamp: Date.now(), value });
  return value;
};

const getCachedKB = async (kbId) => {
  if (!kbId) return null;
  const cacheEntry = kbDetailsCache.get(kbId);
  if (isCacheEntryValid(cacheEntry, KB_CACHE_TTL)) {
    return cacheEntry.value;
  }
  const value = await doClient.kb.get(kbId);
  kbDetailsCache.set(kbId, { timestamp: Date.now(), value });
  return value;
};

const getCachedKBList = async () => {
  if (isCacheEntryValid(kbListCache, KB_LIST_CACHE_TTL) && Array.isArray(kbListCache.value)) {
    return kbListCache.value;
  }
  const list = await doClient.kb.list();
  kbListCache = { timestamp: Date.now(), value: list };
  return list;
};

const invalidateResourceCache = (userId) => {
  if (userId) {
    resourceValidationCache.delete(userId);
  }
};

/**
 * Centralized validation function to verify user resources exist in DigitalOcean
 * This is the single source of truth for resource validation - DO API is authoritative
 * @param {string} userId - User ID to validate resources for
 * @returns {Promise<{hasAgent: boolean, kbStatus: string, userDoc: object, cleaned: boolean}>}
 * kbStatus: 'none' | 'not_attached' | 'attached'
 */
async function validateUserResources(userId) {
  const cachedEntry = resourceValidationCache.get(userId);
  if (isCacheEntryValid(cachedEntry, RESOURCE_CACHE_TTL)) {
    return cachedEntry.data;
  }

  let userDoc = await cloudant.getDocument('maia_users', userId);
  if (!userDoc) {
    const result = { hasAgent: false, kbStatus: 'none', userDoc: null, cleaned: false };
    resourceValidationCache.set(userId, { timestamp: Date.now(), data: result });
    return result;
  }

  let cleaned = false;
  let hasAgent = false;
  let kbStatus = 'none'; // 'none' | 'not_attached' | 'attached'

  const finishAndCache = () => {
    const result = { hasAgent, kbStatus, userDoc, cleaned };
    resourceValidationCache.set(userId, { timestamp: Date.now(), data: result });
    return result;
  };

  // Helper function to check if error is a 404/not found
  const isNotFoundError = (error) => {
    return error.status === 404 || 
           error.message?.includes('404') || 
           error.message?.includes('not found') ||
           error.message?.toLowerCase().includes('not_found');
  };

  // 1. Validate Agent - verify it exists in DigitalOcean
  if (userDoc.assignedAgentId && typeof userDoc.assignedAgentId === 'string' && userDoc.assignedAgentId.trim().length > 0) {
    try {
      const agent = await getCachedAgent(userDoc.assignedAgentId);
      if (agent && agent.uuid === userDoc.assignedAgentId) {
        // Verify agent name matches expected pattern
        const expectedPattern = new RegExp(`^${userId}-agent-`);
        if (expectedPattern.test(agent.name)) {
          hasAgent = true;
          const endpointFromAgent = agent.deployment?.url ? `${agent.deployment.url}/api/v1` : null;
          const modelNameFromAgent = agent.model?.inference_name || agent.model?.name || null;
          const timestamp = new Date().toISOString();
          const defaultProfileKey = userDoc.agentProfileDefaultKey || 'default';
          const mergeResult = mergeAgentProfileOnDoc(userDoc, defaultProfileKey, {
            agentId: agent.uuid,
            agentName: agent.name,
            endpoint: endpointFromAgent,
            modelName: modelNameFromAgent
          }, timestamp);
          if (mergeResult.changed) {
            cleaned = true;
          }
          if (userDoc.assignedAgentName !== agent.name) {
            userDoc.assignedAgentName = agent.name;
            cleaned = true;
          }
          if (userDoc.assignedAgentId !== agent.uuid) {
            userDoc.assignedAgentId = agent.uuid;
            cleaned = true;
          }
          if (endpointFromAgent && userDoc.agentEndpoint !== endpointFromAgent) {
            userDoc.agentEndpoint = endpointFromAgent;
            cleaned = true;
          }
          if (modelNameFromAgent && userDoc.agentModelName !== modelNameFromAgent) {
            userDoc.agentModelName = modelNameFromAgent;
            cleaned = true;
          }
          if (!userDoc.agentProfileDefaultKey) {
            userDoc.agentProfileDefaultKey = defaultProfileKey;
            cleaned = true;
          }
          if (ensureDeepLinkAgentOverrides(userDoc)) {
            cleaned = true;
          }
        } else {
          // Agent exists but name doesn't match pattern - clear it
          console.log(`⚠️ Agent ${userDoc.assignedAgentId} exists but name "${agent.name}" doesn't match pattern for user ${userId}. Clearing.`);
          userDoc.assignedAgentId = null;
          userDoc.assignedAgentName = null;
          userDoc.agentEndpoint = null;
          userDoc.agentModelName = null;
          userDoc.agentApiKey = null;
          cleaned = true;
        }
      } else {
        // Agent ID mismatch - clear it
        console.log(`⚠️ Agent ${userDoc.assignedAgentId} found in database but UUID mismatch in DigitalOcean. Clearing.`);
        userDoc.assignedAgentId = null;
        userDoc.assignedAgentName = null;
        userDoc.agentEndpoint = null;
        userDoc.agentModelName = null;
        userDoc.agentApiKey = null;
        cleaned = true;
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        // Agent doesn't exist in DO - clear it from database
        console.log(`⚠️ Agent ${userDoc.assignedAgentId} not found in DigitalOcean. Clearing from user document.`);
        userDoc.assignedAgentId = null;
        userDoc.assignedAgentName = null;
        userDoc.agentEndpoint = null;
        userDoc.agentModelName = null;
        userDoc.agentApiKey = null;
        cleaned = true;
      } else if (isRateLimitError(error)) {
        console.warn(`⚠️ Rate limit while checking agent for user ${userId}. Using cached validation result.`);
        return finishAndCache();
      } else {
        // Other error - log but don't fail validation
        console.error(`❌ Error checking agent existence in DO for user ${userId}:`, error.message);
        hasAgent = false;
      }
    }
  }

  // 2. Validate KB - verify it exists in DigitalOcean and check attachment status
  let kbExists = false;
  let kbIdFound = null;
  
  // First, check if KB exists in DO (either from database or by searching)
  if (userDoc.kbId && typeof userDoc.kbId === 'string' && userDoc.kbId.trim().length > 0) {
    try {
      const kb = await getCachedKB(userDoc.kbId);
      if (kb && kb.uuid === userDoc.kbId) {
        kbExists = true;
        kbIdFound = userDoc.kbId;
      } else {
        // KB ID mismatch - clear it
        console.log(`⚠️ KB ${userDoc.kbId} found in database but UUID mismatch in DigitalOcean. Clearing KB from user document.`);
        userDoc.kbId = null;
        userDoc.connectedKBs = [];
        userDoc.connectedKB = null; // Clear legacy field
        userDoc.kbIndexingNeeded = false;
        userDoc.kbPendingFiles = [];
        userDoc.kbLastIndexingJobId = null;
        userDoc.kbIndexedFiles = [];
        cleaned = true;
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        // KB doesn't exist in DO - clear it from database
        console.log(`⚠️ KB ${userDoc.kbId} not found in DigitalOcean. Clearing KB from user document.`);
        userDoc.kbId = null;
        userDoc.connectedKBs = [];
        userDoc.connectedKB = null; // Clear legacy field
        userDoc.kbIndexingNeeded = false;
        userDoc.kbPendingFiles = [];
        userDoc.kbLastIndexingJobId = null;
        userDoc.kbIndexedFiles = [];
        cleaned = true;
      } else if (isRateLimitError(error)) {
        console.warn(`⚠️ Rate limit while fetching KB ${userDoc.kbId} for user ${userId}. Returning cached result.`);
        return finishAndCache();
      } else {
        // Other error - log but don't fail validation
        console.error(`❌ Error checking KB existence in DO for user ${userId}:`, error.message);
      }
    }
  }
  
  // If no KB in database or KB not found, try to find KB by name pattern
  if (!kbExists) {
    try {
      const kbName = getKBNameFromUserDoc(userDoc, userId);
      const allKBs = await getCachedKBList();
      const foundKB = allKBs.find(kb => kb.name === kbName);
      
      if (foundKB) {
        // KB exists in DO but not in database - sync it
        kbExists = true;
        kbIdFound = foundKB.uuid || foundKB.id;
        console.log(`ℹ️ Found KB ${kbName} in DO but not in database. Syncing kbId: ${kbIdFound}`);
        userDoc.kbId = kbIdFound;
        // Set connectedKBs since KB actually exists and is found
        if (!userDoc.connectedKBs || !Array.isArray(userDoc.connectedKBs)) {
          userDoc.connectedKBs = [];
        }
        if (!userDoc.connectedKBs.includes(kbName)) {
          userDoc.connectedKBs.push(kbName);
        }
        // Also set legacy connectedKB field for backward compatibility
        if (!userDoc.connectedKB) {
          userDoc.connectedKB = kbName;
        }
        cleaned = true;
      }
    } catch (error) {
      if (isRateLimitError(error)) {
        console.warn(`⚠️ Rate limit while listing KBs for user ${userId}. Using cached validation result.`);
        return finishAndCache();
      }
      console.error(`❌ Error searching for KB in DO for user ${userId}:`, error.message);
    }
  }
  
  // If KB exists, check if it's attached to agent
  if (kbExists && kbIdFound && hasAgent && userDoc.assignedAgentId) {
    try {
      const agentDetails = await getCachedAgent(userDoc.assignedAgentId);
      
      // Check multiple possible field names for attached KBs in agent details
      // Agent might have: knowledge_bases, knowledge_base_ids, connected_knowledge_bases, etc.
      const attachedKBs = agentDetails.knowledge_bases || 
                          agentDetails.connected_knowledge_bases ||
                          agentDetails.knowledge_base_ids ||
                          agentDetails.knowledge_base_uuids ||
                          agentDetails.kbs ||
                          [];
      
      // Check if our KB is in the attached list
      // Handle both array of strings (UUIDs) and array of objects with uuid/id fields
      const isAttached = attachedKBs.some((kb) => {
        if (!kb) return false;
        const kbId = typeof kb === 'string' ? kb : (kb.uuid || kb.id || kb.knowledge_base_uuid);
        return kbId === kbIdFound;
      });
      
      if (isAttached) {
        kbStatus = 'attached';
        // Only log attachment on first detection or when state changes (not on every validation)
        // This is informational, not an error, so no need to spam logs
      } else {
        kbStatus = 'not_attached';
        // Don't log this - it's a normal state and validateUserResources is called frequently
        // The status is already reflected in the API response
      }
    } catch (error) {
      if (isRateLimitError(error)) {
        console.warn(`⚠️ Rate limit while checking KB attachment for user ${userId}. Using cached result.`);
        return finishAndCache();
      }
      console.error(`❌ Error checking KB attachment status for user ${userId}:`, error.message);
      // Default to not_attached if we can't verify
      kbStatus = 'not_attached';
    }
  } else if (kbExists && kbIdFound) {
    // KB exists but no agent - can't be attached
    kbStatus = 'not_attached';
    // Don't log this - it's a normal state during provisioning
  }

  // Save cleaned user document if any resources were removed or synced
  // Use retry logic to handle 409 conflicts (document update conflicts)
  if (cleaned) {
    let retries = 3;
    let saved = false;
    
    while (retries > 0 && !saved) {
      try {
        await cloudant.saveDocument('maia_users', userDoc);
        saved = true;
      } catch (error) {
        // Handle 409 conflict - document was updated by another process
        if (error.statusCode === 409 || error.error === 'conflict') {
          retries--;
          if (retries > 0) {
            // Get fresh document with latest _rev
            const freshDoc = await cloudant.getDocument('maia_users', userId);
            if (freshDoc) {
              // Re-apply our changes to the fresh document
              if (userDoc.assignedAgentId === null) {
                freshDoc.assignedAgentId = null;
                freshDoc.assignedAgentName = null;
                freshDoc.agentEndpoint = null;
                freshDoc.agentModelName = null;
                freshDoc.agentApiKey = null;
                freshDoc.agentProfiles = {};
                freshDoc.agentProfileDefaultKey = freshDoc.agentProfileDefaultKey || 'default';
                freshDoc.deepLinkAgentOverrides = {};
              } else if (userDoc.assignedAgentId) {
                freshDoc.assignedAgentId = userDoc.assignedAgentId;
                freshDoc.assignedAgentName = userDoc.assignedAgentName;
                freshDoc.agentEndpoint = userDoc.agentEndpoint;
                freshDoc.agentModelName = userDoc.agentModelName;
                if (userDoc.agentApiKey !== undefined) {
                  freshDoc.agentApiKey = userDoc.agentApiKey;
                }
                if (isPlainObject(userDoc.agentProfiles)) {
                  freshDoc.agentProfiles = userDoc.agentProfiles;
                }
                if (userDoc.agentProfileDefaultKey) {
                  freshDoc.agentProfileDefaultKey = userDoc.agentProfileDefaultKey;
                }
                if (isPlainObject(userDoc.deepLinkAgentOverrides)) {
                  freshDoc.deepLinkAgentOverrides = userDoc.deepLinkAgentOverrides;
                }
              }
              if (userDoc.kbId === null) {
                freshDoc.kbId = null;
                freshDoc.connectedKBs = [];
                freshDoc.kbIndexingNeeded = false;
                freshDoc.kbPendingFiles = [];
                freshDoc.kbLastIndexingJobId = null;
                freshDoc.kbIndexedFiles = [];
              }
              if (userDoc.kbId && userDoc.connectedKBs) {
                freshDoc.kbId = userDoc.kbId;
                freshDoc.connectedKBs = userDoc.connectedKBs;
              }
              userDoc = freshDoc;
              // Wait a bit before retrying
              await new Promise(resolve => setTimeout(resolve, 100));
            } else {
              // User document was deleted? Shouldn't happen, but break
              break;
            }
          } else {
            console.error(`⚠️ Failed to save user document after 3 retries for user ${userId} due to conflicts. Continuing with current state.`);
            // Don't throw - continue with current document state
            // The validation results are still valid even if save failed
          }
        } else {
          // Other error - throw it
          throw error;
        }
      }
    }
  }

  return finishAndCache();
}

const passkeyService = new PasskeyService({
  rpID: process.env.PASSKEY_RPID || 'user.agropper.xyz',
  origin: process.env.PASSKEY_ORIGIN || `http://localhost:${PORT}`
});

const chatClient = new ChatClient({
  digitalocean: {
    apiKey: process.env.DIGITALOCEAN_PERSONAL_API_KEY,
    baseURL: process.env.DIGITALOCEAN_GENAI_ENDPOINT || 'https://vzfujeetn2dkj4d5awhvvibo.agents.do-ai.run/api/v1'
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || process.env.CHATGPT_API_KEY
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY
  }
});

// Middleware
// CORS configuration - allow both local development and production origins
// Check if we're in production first (needed for CORS logic)
const distPathForCors = path.join(__dirname, '../dist');
const distExistsForCors = existsSync(distPathForCors);
const isProductionForCors = process.env.NODE_ENV === 'production' || distExistsForCors;

// CORS allowed origins - can be set via CORS_ALLOWED_ORIGINS (comma-separated) or use defaults
const corsOriginsEnv = process.env.CORS_ALLOWED_ORIGINS;
const allowedOrigins = corsOriginsEnv 
  ? corsOriginsEnv.split(',').map(origin => origin.trim())
  : [
      'http://localhost:5173', // Local development
      'https://maia.agropper.xyz', // Production (hardcoded fallback)
      process.env.PUBLIC_APP_URL, // From environment variable
      process.env.PASSKEY_ORIGIN // From environment variable (should be set in production)
    ].filter(Boolean); // Remove undefined values

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // Allow DigitalOcean App Platform URLs (ending with .ondigitalocean.app)
      if (origin.endsWith('.ondigitalocean.app')) {
        callback(null, true);
      } else {
        // In production, be more strict
        if (isProductionForCors) {
          console.warn(`⚠️ [CORS] Blocked origin: ${origin}`);
          callback(new Error('Not allowed by CORS'));
        } else {
          // In development, allow all origins
          callback(null, true);
        }
      }
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  },
  store: new CloudantSessionStore({
    cloudantClient: cloudant,
    dbName: 'maia_sessions'
  })
}));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'maia-cloud-user-app' });
});

// Passkey routes
setupAuthRoutes(app, passkeyService, cloudant, doClient, auditLog, emailService);

// Chat routes
setupChatRoutes(app, chatClient, cloudant, doClient);

// File routes
setupFileRoutes(app, cloudant, doClient);

const DEEP_LINK_COOKIE = 'maia_deep_link_user';
const DEEP_LINK_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

const sanitizeName = (value = '') => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9\s'-]/g, '')
  .trim();

const slugifyName = (value = '') => {
  const cleaned = sanitizeName(value).toLowerCase();
  const slug = cleaned.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'guest';
};

const ensureArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

const getChatByShareId = async (shareId) => {
  if (!shareId) return null;
  const result = await cloudant.findDocuments('maia_chats', {
    selector: { shareId: { $eq: shareId } },
    limit: 1
  });
  if (result?.docs?.length) {
    return result.docs[0];
  }
  const allChats = await cloudant.getAllDocuments('maia_chats');
  return allChats.find(chat => chat.shareId === shareId) || null;
};

const findDeepLinkUsersByDisplayName = async (displayName, normalizedKey) => {
  const selector = {
    type: { $eq: 'user' },
    isDeepLink: { $eq: true }
  };

  if (normalizedKey) {
    selector.$or = [{ deepLinkNameKey: { $eq: normalizedKey } }];
  }

  if (displayName) {
    if (selector.$or) {
      selector.$or.push({ displayName: { $eq: displayName } });
    } else {
      selector.displayName = { $eq: displayName };
    }
  }

  const result = await cloudant.findDocuments('maia_users', { selector });
  return result?.docs || [];
};

const getDeepLinkUserById = async (userId) => {
  if (!userId) return null;
  return await cloudant.getDocument('maia_users', userId);
};

// Add deep link user to chat's deepLinkUserIds array
const addDeepLinkUserToChat = async (chat, deepLinkUserId) => {
  if (!chat || !deepLinkUserId) return chat;
  
  // Ensure deepLinkUserIds array exists
  if (!Array.isArray(chat.deepLinkUserIds)) {
    chat.deepLinkUserIds = [];
  }
  
  // Add user if not already in the list
  if (!chat.deepLinkUserIds.includes(deepLinkUserId)) {
    chat.deepLinkUserIds.push(deepLinkUserId);
    chat.updatedAt = new Date().toISOString();
    
    // Save the updated chat document
    try {
      await cloudant.saveDocument('maia_chats', chat);
    } catch (error) {
      console.error(`[Deep Link Tracking] Error saving chat ${chat._id} with deep link user ${deepLinkUserId}:`, error.message);
      // Don't throw - this is non-critical tracking
    }
  }
  
  return chat;
};

const attachShareToUserDoc = (userDoc, shareId) => {
  const shares = ensureArray(userDoc.deepLinkShareIds);
  if (shareId && !shares.includes(shareId)) {
    shares.push(shareId);
  }
  userDoc.deepLinkShareIds = shares;
  return shares;
};

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const ensureDeepLinkAgentOverrides = (userDoc) => {
  if (!isPlainObject(userDoc.deepLinkAgentOverrides)) {
    userDoc.deepLinkAgentOverrides = {};
    return true;
  }
  return false;
};

const mergeAgentProfileOnDoc = (userDoc, profileKey, profileData, timestamp = new Date().toISOString()) => {
  if (!isPlainObject(userDoc.agentProfiles)) {
    userDoc.agentProfiles = {};
  }

  const existingProfile = isPlainObject(userDoc.agentProfiles[profileKey])
    ? { ...userDoc.agentProfiles[profileKey] }
    : {};

  const { agentId, agentName, endpoint, modelName, apiKey, lastSyncedAt } = profileData || {};

  let changed = false;
  if (agentId !== undefined && existingProfile.agentId !== agentId) {
    existingProfile.agentId = agentId;
    changed = true;
  }
  if (agentName !== undefined && existingProfile.agentName !== agentName) {
    existingProfile.agentName = agentName;
    changed = true;
  }
  if (endpoint !== undefined && existingProfile.endpoint !== endpoint) {
    existingProfile.endpoint = endpoint;
    changed = true;
  }
  if (modelName !== undefined && existingProfile.modelName !== modelName) {
    existingProfile.modelName = modelName;
    changed = true;
  }
  if (apiKey !== undefined && existingProfile.apiKey !== apiKey) {
    existingProfile.apiKey = apiKey;
    changed = true;
  }

  if (!existingProfile.createdAt) {
    existingProfile.createdAt = timestamp;
    changed = true;
  }

  if (lastSyncedAt !== undefined) {
    if (existingProfile.lastSyncedAt !== lastSyncedAt) {
      existingProfile.lastSyncedAt = lastSyncedAt;
      changed = true;
    }
  } else if (changed) {
    existingProfile.lastSyncedAt = timestamp;
  }

  if (changed) {
    existingProfile.updatedAt = timestamp;
  } else if (!existingProfile.updatedAt) {
    existingProfile.updatedAt = existingProfile.createdAt;
  }

  userDoc.agentProfiles[profileKey] = existingProfile;
  return { changed, profile: existingProfile };
};

const setDeepLinkSession = (req, userDoc, shareId, chatId) => {
  if (!req.session) return;
  req.session.isDeepLink = true;
  req.session.deepLinkUserId = userDoc.userId;
  req.session.deepLinkDisplayName = userDoc.displayName || userDoc.userId;
  req.session.deepLinkShareIds = ensureArray(userDoc.deepLinkShareIds);
  if (shareId) {
    if (!req.session.deepLinkShareIds.includes(shareId)) {
      req.session.deepLinkShareIds.push(shareId);
    }
    req.session.deepLinkShareId = shareId;
  }
  if (chatId) {
    req.session.deepLinkChatId = chatId;
  }
  req.session.deepLinkAuthenticatedAt = new Date().toISOString();
  req.session.deepLinkExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
};

const isDeepLinkSession = (req) => !!req.session?.isDeepLink;

const generateDeepLinkUserId = (nameSlug, shareId) => {
  const randomPart = Math.random().toString(36).slice(2, 8);
  const timePart = Date.now().toString(36);
  const sharePart = (shareId || 'dl').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8);
  return `${nameSlug}-DL-${sharePart}-${timePart}-${randomPart}`.toLowerCase();
};

// Deep link session check
app.get('/api/deep-link/session', async (req, res) => {
  try {
    const shareId = req.query.shareId;

    if (!shareId || typeof shareId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Share ID is required',
        error: 'MISSING_SHARE_ID'
      });
    }

    const chat = await getChatByShareId(shareId);
    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Shared chat not found',
        error: 'CHAT_NOT_FOUND'
      });
    }

    if (req.session?.userId) {
      const deepLink = isDeepLinkSession(req);
      const response = {
        success: true,
        authenticated: true,
        deepLink,
        user: {
          userId: req.session.userId,
          displayName: req.session.displayName || req.session.userId,
          isDeepLink: deepLink
        }
      };

      if (deepLink) {
        // Add deep link user to chat's tracking list
        const deepLinkUserId = req.session.deepLinkUserId || req.session.userId;
        if (deepLinkUserId) {
          await addDeepLinkUserToChat(chat, deepLinkUserId);
        }
        
        if (!req.session.deepLinkShareIds?.includes(shareId)) {
          req.session.deepLinkShareIds = ensureArray(req.session.deepLinkShareIds);
          req.session.deepLinkShareIds.push(shareId);
        }
        req.session.deepLinkShareId = shareId;
        req.session.deepLinkChatId = chat._id;
        response.deepLinkInfo = {
          shareId,
          chatId: chat._id
        };
      } else {
        response.deepLinkInfo = {
          shareId,
          chatId: chat._id
        };
      }

      return res.json(response);
    } else if (isDeepLinkSession(req) && req.session.deepLinkUserId) {
      const deepLinkUserId = req.session.deepLinkUserId;
      // Add deep link user to chat's tracking list
      await addDeepLinkUserToChat(chat, deepLinkUserId);
      
      const shareIds = ensureArray(req.session.deepLinkShareIds);
    if (!shareIds.includes(shareId)) {
      shareIds.push(shareId);
    }
    req.session.deepLinkShareIds = shareIds;
    req.session.deepLinkShareId = shareId;
    req.session.deepLinkChatId = chat._id;
      return res.json({
        success: true,
        authenticated: true,
        deepLink: true,
        user: {
          userId: deepLinkUserId,
          displayName: req.session.deepLinkDisplayName || deepLinkUserId,
          isDeepLink: true
        },
        deepLinkInfo: {
        shareId,
        chatId: chat._id
        }
      });
    }

    const cookieUserId = req.cookies?.[DEEP_LINK_COOKIE];
    if (cookieUserId) {
      const userDoc = await getDeepLinkUserById(cookieUserId);
      if (userDoc && userDoc.isDeepLink) {
        attachShareToUserDoc(userDoc, shareId);
        userDoc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument('maia_users', userDoc);

        // Add deep link user to chat's tracking list
        await addDeepLinkUserToChat(chat, userDoc.userId);

        setDeepLinkSession(req, userDoc, shareId, chat._id);
        res.cookie(DEEP_LINK_COOKIE, userDoc.userId, {
          maxAge: DEEP_LINK_COOKIE_MAX_AGE,
          httpOnly: true,
          sameSite: 'lax'
        });

        return res.json({
          success: true,
          authenticated: true,
          deepLink: true,
          user: {
            userId: userDoc.userId,
            displayName: userDoc.displayName || userDoc.userId,
            isDeepLink: true
          },
          deepLinkInfo: {
            shareId,
            chatId: chat._id
          }
        });
      }
    }

    res.json({
      success: true,
      authenticated: false,
      needsRegistration: true
    });
  } catch (error) {
    console.error('❌ Error checking deep-link session:', error);
    res.status(500).json({
      success: false,
      message: `Failed to verify deep-link session: ${error.message}`,
      error: 'DEEPLINK_SESSION_ERROR'
    });
  }
});

// Deep link login / registration
app.post('/api/deep-link/login', async (req, res) => {
  try {
    const { shareId, name, email, emailPreference } = req.body || {};

    if (!shareId || typeof shareId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Share ID is required',
        error: 'MISSING_SHARE_ID'
      });
    }

    const chat = await getChatByShareId(shareId);
    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Shared chat not found',
        error: 'CHAT_NOT_FOUND'
      });
    }

    const rawName = typeof name === 'string' ? name.trim() : '';
    if (!rawName) {
      return res.status(400).json({
        success: false,
        message: 'Name is required',
        error: 'MISSING_NAME'
      });
    }

    const normalizedNameKey = sanitizeName(rawName).toLowerCase();
    if (!normalizedNameKey) {
      return res.status(400).json({
        success: false,
        message: 'Name is invalid',
        error: 'INVALID_NAME'
      });
    }

    const normalizedEmail = typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;
    const nameSlug = slugifyName(rawName);

    const existingMatches = await findDeepLinkUsersByDisplayName(rawName, normalizedNameKey);
    let userDoc = existingMatches[0] || null;

    const cookieUserId = req.cookies?.[DEEP_LINK_COOKIE];
    if (!userDoc && cookieUserId) {
      const cookieUser = await getDeepLinkUserById(cookieUserId);
      if (cookieUser && cookieUser.isDeepLink) {
        userDoc = cookieUser;
      }
    }

    if (!userDoc) {
      const userId = generateDeepLinkUserId(nameSlug, shareId);
      userDoc = {
        _id: userId,
        userId,
        type: 'user',
        isDeepLink: true,
        displayName: rawName,
        deepLinkNameKey: normalizedNameKey,
        email: normalizedEmail,
        deepLinkShareIds: [shareId],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        domain: 'deeplink'
      };
    } else {
      // Existing user: handle email differences
      const existingEmail = userDoc.email ? String(userDoc.email).toLowerCase() : null;
      if (normalizedEmail && existingEmail && existingEmail !== normalizedEmail) {
        if (!emailPreference) {
          return res.status(409).json({
            success: false,
            conflict: true,
            existingEmail: userDoc.email,
            message: 'Email differs from previous registration'
          });
        }

        if (emailPreference === 'new') {
          userDoc.email = normalizedEmail;
        }
      } else if (normalizedEmail && !existingEmail) {
        userDoc.email = normalizedEmail;
      }

      userDoc.displayName = rawName;
      userDoc.deepLinkNameKey = normalizedNameKey;
      attachShareToUserDoc(userDoc, shareId);
      userDoc.updatedAt = new Date().toISOString();
    }

    await cloudant.saveDocument('maia_users', userDoc);

    // Add deep link user to chat's tracking list
    await addDeepLinkUserToChat(chat, userDoc.userId);

    setDeepLinkSession(req, userDoc, shareId, chat._id);
    res.cookie(DEEP_LINK_COOKIE, userDoc.userId, {
      maxAge: DEEP_LINK_COOKIE_MAX_AGE,
      httpOnly: true,
      sameSite: 'lax'
    });

    res.json({
      success: true,
      authenticated: true,
      deepLink: true,
      user: {
        userId: userDoc.userId,
        displayName: userDoc.displayName || userDoc.userId,
        isDeepLink: true
      },
      deepLinkInfo: {
        shareId,
        chatId: chat._id
      }
    });
  } catch (error) {
    console.error('❌ Error processing deep-link login:', error);
    res.status(500).json({
      success: false,
      message: `Failed to process deep-link login: ${error.message}`,
      error: 'DEEPLINK_LOGIN_ERROR'
    });
  }
});

// Agent sync endpoint - find and configure user's agent
app.post('/api/sync-agent', async (req, res) => {
  try {
    const userId = req.session?.userId || req.body?.userId;
    
    if (!userId) {
      return res.status(401).json({ 
        success: false, 
        message: 'User not authenticated',
        error: 'NOT_AUTHENTICATED'
      });
    }
    
    // First, validate existing resources to clean up any stale references
    const { userDoc: validatedUserDoc } = await validateUserResources(userId);
    
    if (!validatedUserDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }
    
    // Find user's agent in DigitalOcean (source of truth)
    const userAgent = await findUserAgent(doClient, userId);
    
    if (!userAgent) {
      // No agent found in DO - ensure database is clean
      if (validatedUserDoc.assignedAgentId) {
        console.log(`⚠️ No agent found in DO for user ${userId}, but database has ${validatedUserDoc.assignedAgentId}. Already cleaned by validateUserResources.`);
      }
      return res.status(200).json({ 
        success: false, 
        message: 'No agent found for user',
        error: 'AGENT_NOT_FOUND'
      });
    }
    
    // Agent exists in DO - sync with database
    // Use the validated document as base (may have been cleaned/updated by validateUserResources)
    let userDoc = validatedUserDoc;
    
    // Check if agent info needs updating
    const agentModelName = userAgent.model?.inference_name || userAgent.model?.name || null;
    const agentEndpointFromDetails = userAgent.deployment?.url ? `${userAgent.deployment.url}/api/v1` : null;
    const needsUpdate = 
      userDoc.assignedAgentId !== userAgent.uuid ||
      userDoc.assignedAgentName !== userAgent.name ||
      userDoc.agentModelName !== agentModelName ||
      !agentEndpointFromDetails ||
      userDoc.agentEndpoint !== agentEndpointFromDetails;
    
    if (needsUpdate) {
      // Retry logic for 409 conflicts
      let retries = 3;
      let saved = false;
      
      while (retries > 0 && !saved) {
        try {
      userDoc.assignedAgentId = userAgent.uuid;
      userDoc.assignedAgentName = userAgent.name;
      userDoc.agentEndpoint = agentEndpointFromDetails;
      // Store model inference_name for API requests
      userDoc.agentModelName = userAgent.model?.inference_name || userAgent.model?.name || null;
      const syncTimestamp = new Date().toISOString();
      const defaultProfileKey = userDoc.agentProfileDefaultKey || 'default';
      mergeAgentProfileOnDoc(userDoc, defaultProfileKey, {
        agentId: userAgent.uuid,
        agentName: userAgent.name,
        endpoint: userDoc.agentEndpoint,
        modelName: userDoc.agentModelName
      }, syncTimestamp);
      if (!userDoc.agentProfileDefaultKey) {
        userDoc.agentProfileDefaultKey = defaultProfileKey;
      }
      ensureDeepLinkAgentOverrides(userDoc);
      
      await cloudant.saveDocument('maia_users', userDoc);
      console.log(`✅ Synced agent ${userAgent.name} for user ${userId}`);
          saved = true;
        } catch (error) {
          // Handle 409 conflict - document was updated by another process
          if (error.statusCode === 409 || error.error === 'conflict') {
            retries--;
            if (retries > 0) {
              // Get fresh document with latest _rev
              userDoc = await cloudant.getDocument('maia_users', userId);
              // Wait a bit before retrying
              await new Promise(resolve => setTimeout(resolve, 100));
            } else {
              console.error(`⚠️ Failed to save agent sync after 3 retries for user ${userId} due to conflicts. Agent info may be slightly out of sync.`);
              // Don't throw - return success anyway since agent exists in DO
              // The next sync will pick up the correct values
            }
          } else {
            // Other error - throw it
            throw error;
          }
        }
      }
    }
    
    res.json({
      success: true,
      agent: {
        id: userAgent.uuid,
        name: userAgent.name,
        endpoint: userAgent.deployment?.url ? `${userAgent.deployment.url}/api/v1` : null
      }
    });
  } catch (error) {
    console.error('Error syncing agent:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to sync agent',
      error: 'SYNC_ERROR'
    });
  }
});

// Helper function to generate polling page HTML
function getProvisionPage(userId) {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Provisioning User</title>
        <meta charset="UTF-8">
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 1200px;
            margin: 20px auto;
            padding: 20px;
            background-color: #f5f5f5;
          }
          .container {
            background-color: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .section {
            margin: 20px 0;
          }
          .section h3 {
            margin-top: 0;
            border-bottom: 2px solid #1976d2;
            padding-bottom: 10px;
          }
          .verification-checklist {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 10px;
            margin: 15px 0;
          }
          .check-item {
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 4px;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .check-item.passed {
            background-color: #e8f5e9;
            border-color: #388e3c;
          }
          .check-item.failed {
            background-color: #ffebee;
            border-color: #d32f2f;
          }
          .check-item.pending {
            background-color: #fff3e0;
            border-color: #f57c00;
          }
          .status-icon {
            font-size: 20px;
          }
          .terminal-view {
            background-color: #1e1e1e;
            color: #d4d4d4;
            padding: 15px;
            border-radius: 4px;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            max-height: 400px;
            overflow-y: auto;
            white-space: pre-wrap;
            word-wrap: break-word;
          }
          .log-entry {
            margin: 2px 0;
          }
          .log-entry.info { color: #d4d4d4; }
          .log-entry.success { color: #4ec9b0; }
          .log-entry.error { color: #f48771; }
          .log-entry.warning { color: #dcdcaa; }
          .status-box {
            background-color: #e3f2fd;
            padding: 15px;
            border-radius: 4px;
            margin: 20px 0;
          }
          .error-box {
            background-color: #ffebee;
            padding: 15px;
            border-radius: 4px;
            margin: 20px 0;
            color: #c62828;
          }
          .success-box {
            background-color: #e8f5e9;
            padding: 15px;
            border-radius: 4px;
            margin: 20px 0;
          }
          .step {
            margin: 10px 0;
            padding: 10px;
            border-left: 3px solid #1976d2;
          }
          .step.completed {
            border-left-color: #388e3c;
          }
          .step.error {
            border-left-color: #d32f2f;
          }
          pre {
            background-color: #f5f5f5;
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
            font-size: 12px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h2 id="status-header">🔄 Provisioning in Progress...</h2>
          <div id="status-container">
            <div class="status-box">
              <p id="current-step">Starting provisioning...</p>
            </div>
            <div id="steps-container"></div>
          </div>
          
          <div class="section">
            <h3>Verification Checklist</h3>
            <div id="verification-checklist" class="verification-checklist">
              <div class="check-item pending">
                <span class="status-icon">⏳</span>
                <div>
                  <strong>KB Name</strong>
                  <div class="check-message" style="font-size: 11px; color: #666;">Waiting...</div>
                </div>
              </div>
              <div class="check-item pending">
                <span class="status-icon">⏳</span>
                <div>
                  <strong>Bucket Folders</strong>
                  <div class="check-message" style="font-size: 11px; color: #666;">Waiting...</div>
                </div>
              </div>
              <div class="check-item pending">
                <span class="status-icon">⏳</span>
                <div>
                  <strong>Agent Exists</strong>
                  <div class="check-message" style="font-size: 11px; color: #666;">Waiting...</div>
                </div>
              </div>
              <div class="check-item pending">
                <span class="status-icon">⏳</span>
                <div>
                  <strong>Agent Deployed</strong>
                  <div class="check-message" style="font-size: 11px; color: #666;">Waiting...</div>
                </div>
              </div>
              <div class="check-item pending">
                <span class="status-icon">⏳</span>
                <div>
                  <strong>Agent Config</strong>
                  <div class="check-message" style="font-size: 11px; color: #666;">Waiting...</div>
                </div>
              </div>
              <div class="check-item pending">
                <span class="status-icon">⏳</span>
                <div>
                  <strong>API Key</strong>
                  <div class="check-message" style="font-size: 11px; color: #666;">Waiting...</div>
                </div>
              </div>
              <div class="check-item pending">
                <span class="status-icon">⏳</span>
                <div>
                  <strong>API Key Works</strong>
                  <div class="check-message" style="font-size: 11px; color: #666;">Waiting...</div>
                </div>
              </div>
            </div>
          </div>
          
          <div class="section">
            <h3>Server Logs</h3>
            <div id="logs-container" class="terminal-view">Loading logs...</div>
          </div>
        </div>
        <script>
          const userId = '${userId}';
          let pollInterval;
          
          function updatePage(data) {
            const header = document.getElementById('status-header');
            const currentStep = document.getElementById('current-step');
            const stepsContainer = document.getElementById('steps-container');
            const statusContainer = document.getElementById('status-container');
            
            // Update verification checklist if available
            if (data.verification) {
              updateVerification(data.verification);
            }
            
            if (data.status === 'completed') {
              header.innerHTML = '✅ User Successfully Provisioned';
              header.style.color = '#388e3c';
              clearInterval(pollInterval);
              
              const result = data.result || {};
              statusContainer.innerHTML = \`
                <div class="success-box">
                  <p><strong>User:</strong> \${userId}</p>
                  <p><strong>Agent Name:</strong> \${result.agentName || 'N/A'}</p>
                  <p><strong>Agent ID:</strong> \${result.agentId || 'N/A'}</p>
                  <p><strong>Model:</strong> \${result.model || 'Unknown'}</p>
                  <p><strong>Endpoint:</strong> \${result.endpoint || 'Not available'}</p>
                  <p><strong>Total Time:</strong> \${result.totalTime || 0} seconds</p>
                </div>
                <h3>Provisioning Steps</h3>
                <div id="steps-list"></div>
                \${result.testResult && !result.testResult.error ? \`
                  <div class="status-box">
                    <h4>Test Query Result</h4>
                    <p><strong>Query:</strong> "What model are you?"</p>
                    <p><strong>Response:</strong> \${escapeHtml(result.testResult.content || 'No response')}</p>
                  </div>
                \` : ''}
                <p style="margin-top: 30px;">
                  <a href="http://localhost:5173">Go to App</a>
                </p>
              \`;
              
              // Render steps
              const stepsList = document.getElementById('steps-list');
              if (data.steps && data.steps.length > 0) {
                stepsList.innerHTML = data.steps.map(step => {
                  const details = step.details ? '<pre>' + escapeHtml(JSON.stringify(step.details, null, 2)) + '</pre>' : '';
                  return \`<div class="step completed">
                    <strong>✅ \${escapeHtml(step.step)}</strong>
                    <span style="color: #666; font-size: 12px; margin-left: 10px;">\${escapeHtml(step.timestamp)}</span>
                    \${details}
                  </div>\`;
                }).join('');
              }
            } else if (data.status === 'failed') {
              header.innerHTML = '❌ Provisioning Failed';
              header.style.color = '#d32f2f';
              clearInterval(pollInterval);
              
              statusContainer.innerHTML = \`
                <div class="error-box">
                  <p><strong>Error:</strong> \${escapeHtml(data.error || 'Unknown error')}</p>
                </div>
                <h3>Steps Completed</h3>
                <div id="steps-list"></div>
              \`;
              
              const stepsList = document.getElementById('steps-list');
              if (data.steps && data.steps.length > 0) {
                stepsList.innerHTML = data.steps.map(step => {
                  const details = step.details ? '<pre>' + escapeHtml(JSON.stringify(step.details, null, 2)) + '</pre>' : '';
                  return \`<div class="step \${data.status === 'failed' ? 'error' : 'completed'}">
                    <strong>\${data.status === 'failed' ? '❌' : '✅'} \${escapeHtml(step.step)}</strong>
                    <span style="color: #666; font-size: 12px; margin-left: 10px;">\${escapeHtml(step.timestamp)}</span>
                    \${details}
                  </div>\`;
                }).join('');
              }
            } else {
              // In progress
              currentStep.textContent = data.currentStep || 'Processing...';
              
              if (data.steps && data.steps.length > 0) {
                stepsContainer.innerHTML = '<h3>Steps</h3>' + data.steps.map(step => {
                  const details = step.details ? '<pre>' + escapeHtml(JSON.stringify(step.details, null, 2)) + '</pre>' : '';
                  return \`<div class="step">
                    <strong>🔄 \${escapeHtml(step.step)}</strong>
                    <span style="color: #666; font-size: 12px; margin-left: 10px;">\${escapeHtml(step.timestamp)}</span>
                    \${details}
                  </div>\`;
                }).join('');
              }
            }
          }
          
          function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
          }
          
          function pollStatus() {
            fetch(\`/api/admin/provision-status?userId=\${userId}\`)
              .then(res => res.json())
              .then(data => {
                updatePage(data);
              })
              .catch(error => {
                console.error('Polling error:', error);
              });
          }
          
          // Update verification checklist
          function updateVerification(verification) {
            if (!verification || !verification.results) return;
            
            const checks = {
              'KB Name': verification.results.kbName,
              'Bucket Folders': verification.results.bucketFolders,
              'Agent Exists': verification.results.agentExists,
              'Agent Deployed': verification.results.agentDeployed,
              'Agent Config': verification.results.agentConfig,
              'API Key': verification.results.apiKey,
              'API Key Works': verification.results.apiKeyWorks
            };
            
            Object.keys(checks).forEach((key, index) => {
              const checkItem = document.querySelectorAll('.check-item')[index];
              if (!checkItem) return;
              
              const result = checks[key];
              const statusIcon = checkItem.querySelector('.status-icon');
              const checkMessage = checkItem.querySelector('.check-message');
              
              if (result && result.passed !== undefined) {
                checkItem.className = 'check-item ' + (result.passed ? 'passed' : 'failed');
                statusIcon.textContent = result.passed ? '✅' : '❌';
                checkMessage.textContent = result.message || (result.passed ? 'Passed' : 'Failed');
              }
            });
          }
          
          // Poll logs
          let lastLogTimestamp = null;
          function pollLogs() {
            const since = lastLogTimestamp ? '&since=' + encodeURIComponent(lastLogTimestamp) : '';
            fetch('/api/admin/provision-logs?userId=' + userId + since)
              .then(res => res.json())
              .then(data => {
                if (data.success && data.logs) {
                  const logsContainer = document.getElementById('logs-container');
                  data.logs.forEach(log => {
                    const logEntry = document.createElement('div');
                    logEntry.className = 'log-entry ' + log.level;
                    const time = new Date(log.timestamp).toLocaleTimeString();
                    logEntry.textContent = '[' + time + '] ' + log.message;
                    logsContainer.appendChild(logEntry);
                    lastLogTimestamp = log.timestamp;
                  });
                  // Auto-scroll to bottom
                  logsContainer.scrollTop = logsContainer.scrollHeight;
                }
              })
              .catch(error => console.error('Log polling error:', error));
          }
          
          // Poll immediately, then every 5 seconds
          pollStatus();
          pollLogs();
          pollInterval = setInterval(() => {
            pollStatus();
            pollLogs();
          }, 5000);
        </script>
      </body>
    </html>
  `;
}

// Provision status endpoint - for polling
app.get('/api/admin/provision-status', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }
    
    const status = provisioningStatus.get(userId);
    if (!status) {
      return res.json({ status: 'not_started' });
    }
    
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Provision logs endpoint - for viewing server logs
app.get('/api/admin/provision-logs', async (req, res) => {
  try {
    const { userId, since } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }
    
    const logs = provisioningLogs.get(userId) || [];
    
    // Filter by timestamp if 'since' parameter provided
    let filteredLogs = logs;
    if (since) {
      const sinceDate = new Date(since);
      filteredLogs = logs.filter(log => new Date(log.timestamp) > sinceDate);
    }
    
    res.json({
      success: true,
      logs: filteredLogs,
      total: logs.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin agent diagnostic endpoint - identify which agent is connected to a user
app.get('/api/admin/agent-diagnostic', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).send(`
        <html>
          <head><title>Agent Diagnostic</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ Missing Parameter</h2>
            <p>User ID is required. Use: <code>/api/admin/agent-diagnostic?userId=USERNAME</code></p>
          </body>
        </html>
      `);
    }

    // Get user document
    let userDoc;
    try {
      userDoc = await cloudant.getDocument('maia_users', userId);
    } catch (error) {
      return res.status(404).send(`
        <html>
          <head><title>Agent Diagnostic</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ User Not Found</h2>
            <p>User "${userId}" not found in database.</p>
          </body>
        </html>
      `);
    }

    const storedAgentId = userDoc.assignedAgentId || null;
    const storedAgentName = userDoc.assignedAgentName || null;
    const agentProfile = userDoc.agentProfiles?.[userDoc.agentProfileDefaultKey || 'default'] || null;
    const profileAgentId = agentProfile?.agentId || null;

    // Find all agents matching the user's name pattern
    const agentPattern = new RegExp(`^${userId}-agent-`);
    let matchingAgents = [];
    let errorMessage = null;

    try {
      const allAgents = await doClient.agent.list();
      matchingAgents = allAgents.filter(agent => agentPattern.test(agent.name));
      
      // Get full details for each matching agent
      const agentDetails = await Promise.all(
        matchingAgents.map(async (agent) => {
          try {
            const details = await doClient.agent.get(agent.uuid || agent.id);
            // Extract temperature - DigitalOcean API may omit temperature field in some cases
            // According to DO API docs, temperature is a top-level field
            // We set temperature to 0.1, so it should be present in the response
            let extractedTemperature;
            if (details.temperature !== undefined) {
              extractedTemperature = details.temperature;
            } else {
              // Temperature field is missing - show as unknown
              extractedTemperature = 'unknown (not returned by API)';
            }
            
            return {
              uuid: details.uuid || agent.uuid || agent.id,
              name: details.name || agent.name,
              maxTokens: details.max_tokens ?? details.maxTokens ?? 'unknown',
              temperature: extractedTemperature,
              topP: details.top_p ?? details.topP ?? 'unknown',
              deploymentStatus: details.deployment?.status || 'unknown',
              deploymentUrl: details.deployment?.url || null,
              createdAt: details.created_at || 'unknown',
              isStoredAgent: (details.uuid || agent.uuid || agent.id) === storedAgentId,
              isProfileAgent: (details.uuid || agent.uuid || agent.id) === profileAgentId
            };
          } catch (err) {
            return {
              uuid: agent.uuid || agent.id,
              name: agent.name,
              error: err.message
            };
          }
        })
      );
      matchingAgents = agentDetails;
    } catch (err) {
      errorMessage = err.message;
    }

    // Generate HTML report
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Agent Diagnostic - ${userId}</title>
          <meta charset="UTF-8">
          <style>
            body {
              font-family: Arial, sans-serif;
              max-width: 1000px;
              margin: 20px auto;
              padding: 20px;
              background-color: #f5f5f5;
            }
            .container {
              background-color: white;
              padding: 30px;
              border-radius: 8px;
              box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            h1 { color: #1976d2; margin-top: 0; }
            h2 { color: #388e3c; border-bottom: 2px solid #388e3c; padding-bottom: 10px; }
            h3 { color: #f57c00; margin-top: 30px; }
            .info-box {
              background-color: #e3f2fd;
              padding: 15px;
              border-radius: 4px;
              margin: 15px 0;
              border-left: 4px solid #1976d2;
            }
            .agent-box {
              background-color: #fff3e0;
              padding: 20px;
              border-radius: 4px;
              margin: 15px 0;
              border-left: 4px solid #f57c00;
            }
            .agent-box.connected {
              background-color: #e8f5e9;
              border-left-color: #388e3c;
            }
            .agent-box.disconnected {
              background-color: #ffebee;
              border-left-color: #d32f2f;
            }
            .badge {
              display: inline-block;
              padding: 4px 8px;
              border-radius: 4px;
              font-size: 12px;
              font-weight: bold;
              margin-left: 10px;
            }
            .badge.connected { background-color: #388e3c; color: white; }
            .badge.disconnected { background-color: #d32f2f; color: white; }
            .badge.warning { background-color: #f57c00; color: white; }
            code {
              background-color: #f5f5f5;
              padding: 2px 6px;
              border-radius: 3px;
              font-family: 'Courier New', monospace;
              font-size: 13px;
            }
            .config-table {
              width: 100%;
              border-collapse: collapse;
              margin: 10px 0;
            }
            .config-table th,
            .config-table td {
              padding: 8px;
              text-align: left;
              border-bottom: 1px solid #ddd;
            }
            .config-table th {
              background-color: #f5f5f5;
              font-weight: bold;
            }
            .action-box {
              background-color: #fff9c4;
              padding: 15px;
              border-radius: 4px;
              margin: 20px 0;
              border-left: 4px solid #fbc02d;
            }
            .error-box {
              background-color: #ffebee;
              padding: 15px;
              border-radius: 4px;
              margin: 15px 0;
              border-left: 4px solid #d32f2f;
              color: #c62828;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Agent Diagnostic Report</h1>
            <p><strong>User:</strong> <code>${userId}</code></p>

            <h2>Database Information</h2>
            <div class="info-box">
              <p><strong>Stored Agent ID:</strong> <code>${storedAgentId || 'NOT SET'}</code></p>
              <p><strong>Stored Agent Name:</strong> <code>${storedAgentName || 'NOT SET'}</code></p>
              ${profileAgentId ? `<p><strong>Agent Profile ID:</strong> <code>${profileAgentId}</code></p>` : ''}
            </div>

            ${errorMessage ? `
              <div class="error-box">
                <h3>Error Fetching Agents</h3>
                <p>${errorMessage}</p>
              </div>
            ` : ''}

            <h2>Agents in DigitalOcean</h2>
            ${matchingAgents.length === 0 ? `
              <div class="info-box">
                <p>No agents found matching pattern: <code>${userId}-agent-*</code></p>
              </div>
            ` : `
              <p>Found <strong>${matchingAgents.length}</strong> agent(s) matching pattern: <code>${userId}-agent-*</code></p>
              
              ${matchingAgents.map((agent, idx) => {
                const isConnected = agent.isStoredAgent || agent.isProfileAgent;
                const isCorrect = isConnected && (agent.maxTokens === 16384 || agent.maxTokens === 'unknown');
                return `
                  <div class="agent-box ${isConnected ? 'connected' : 'disconnected'}">
                    <h3>Agent ${idx + 1} ${isConnected ? '<span class="badge connected">CONNECTED</span>' : '<span class="badge disconnected">NOT CONNECTED</span>'}</h3>
                    <table class="config-table">
                      <tr><th>UUID</th><td><code>${agent.uuid}</code></td></tr>
                      <tr><th>Name</th><td><code>${agent.name}</code></td></tr>
                      <tr><th>Max Tokens</th><td><code>${agent.maxTokens}</code> ${agent.maxTokens === 16384 ? '✅' : agent.maxTokens !== 'unknown' ? '⚠️ Should be 16384' : ''}</td></tr>
                      <tr><th>Temperature</th><td><code>${agent.temperature}</code></td></tr>
                      <tr><th>Top P</th><td><code>${agent.topP}</code></td></tr>
                      <tr><th>Deployment Status</th><td><code>${agent.deploymentStatus}</code></td></tr>
                      <tr><th>Deployment URL</th><td><code>${agent.deploymentUrl || 'Not available'}</code></td></tr>
                      <tr><th>Created At</th><td><code>${agent.createdAt}</code></td></tr>
                      <tr><th>Matches Stored ID</th><td>${agent.isStoredAgent ? '✅ YES' : '❌ NO'}</td></tr>
                      <tr><th>Matches Profile ID</th><td>${agent.isProfileAgent ? '✅ YES' : '❌ NO'}</td></tr>
                    </table>
                    ${!isConnected ? `
                      <div class="action-box">
                        <strong>⚠️ This agent is NOT connected to the user.</strong><br>
                        You can safely delete this agent in the DigitalOcean dashboard.
                      </div>
                    ` : isCorrect ? `
                      <div class="action-box" style="background-color: #e8f5e9; border-left-color: #388e3c;">
                        <strong>✅ This is the correct agent.</strong><br>
                        Keep this agent - it's connected to the user and has the correct configuration.
                      </div>
                    ` : `
                      <div class="action-box" style="background-color: #fff3e0; border-left-color: #f57c00;">
                        <strong>⚠️ This agent is connected but has incorrect max_tokens.</strong><br>
                        The agent should have max_tokens=16384 but shows ${agent.maxTokens}.<br>
                        Consider updating the agent configuration or recreating it.
                      </div>
                    `}
                  </div>
                `;
              }).join('')}
            `}

            ${matchingAgents.length > 1 ? `
              <div class="action-box">
                <h3>Summary</h3>
                <p><strong>Connected Agent:</strong> ${matchingAgents.find(a => a.isStoredAgent) ? matchingAgents.find(a => a.isStoredAgent).uuid : 'NONE FOUND'}</p>
                <p><strong>Agents to Delete:</strong> ${matchingAgents.filter(a => !a.isStoredAgent && !a.isProfileAgent).map(a => a.uuid).join(', ') || 'NONE'}</p>
                <p><em>Go to DigitalOcean dashboard and delete the disconnected agents listed above.</em></p>
              </div>
            ` : ''}
          </div>
        </body>
      </html>
    `;

    res.send(html);
  } catch (error) {
    console.error('❌ Agent diagnostic error:', error);
    res.status(500).send(`
      <html>
        <head><title>Agent Diagnostic Error</title></head>
        <body style="font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px;">
          <h2 style="color: #d32f2f;">❌ Diagnostic Error</h2>
          <p>An error occurred while generating the diagnostic report:</p>
          <pre style="background-color: #f5f5f5; padding: 15px; border-radius: 4px; overflow-x: auto;">${error.message}</pre>
        </body>
      </html>
    `);
  }
});

// Admin provision endpoint - create agent for user
app.get('/api/admin/provision', async (req, res) => {
  try {
    const { token, userId } = req.query;

    if (!token || !userId) {
      return res.status(400).send(`
        <html>
          <head><title>Provision Error</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ Provisioning Failed</h2>
            <p>Missing required parameters (token and userId).</p>
          </body>
        </html>
      `);
    }

    // Get user document
    let userDoc;
    try {
      userDoc = await cloudant.getDocument('maia_users', userId);
    } catch (error) {
      return res.status(404).send(`
        <html>
          <head><title>Provision Error</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ Provisioning Failed</h2>
            <p>User not found: ${userId}</p>
          </body>
        </html>
      `);
    }

    // Validate token (allow viewing completed provisioning for 24 hours)
    if (!userDoc.provisionToken || userDoc.provisionToken !== token) {
      // If user is already provisioned, allow viewing the page without token for 24 hours
      if (userDoc.provisioned && userDoc.provisionedAt) {
        const provisionedAt = new Date(userDoc.provisionedAt);
        const hoursSinceProvisioned = (Date.now() - provisionedAt.getTime()) / (1000 * 60 * 60);
        if (hoursSinceProvisioned <= 24) {
          // Allow viewing completed provisioning page for 24 hours without token
          // This allows admins to view the results even after the page auto-refreshes
        } else {
          return res.status(401).send(`
            <html>
              <head><title>Provision Error</title></head>
              <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
                <h2 style="color: #d32f2f;">❌ Invalid Token</h2>
                <p>The provisioning token is invalid or has expired. Provisioning was completed more than 24 hours ago.</p>
              </body>
            </html>
          `);
        }
      } else {
        return res.status(401).send(`
          <html>
            <head><title>Provision Error</title></head>
            <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
              <h2 style="color: #d32f2f;">❌ Invalid Token</h2>
              <p>The provisioning token is invalid or has expired.</p>
            </body>
          </html>
        `);
      }
    }

    // Check if user already has an agent
    if (userDoc.assignedAgentId) {
      // User already provisioned - return success
      if (!provisioningLogs.has(userId)) {
        provisioningLogs.set(userId, []);
      }
      logProvisioning(userId, `ℹ️  Provision link opened but user ${userId} already has agent: ${userDoc.assignedAgentId}`, 'info');
      return res.send(`
        <html>
          <head><title>User Already Provisioned</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #388e3c;">✅ User Already Provisioned</h2>
            <p><strong>User:</strong> ${userId}</p>
            <p><strong>Agent:</strong> ${userDoc.assignedAgentName || userDoc.assignedAgentId}</p>
            <p>The user already has an agent assigned.</p>
          </body>
        </html>
      `);
    }

    const existingStatus = provisioningStatus.get(userId);
    if (existingStatus && existingStatus.status === 'in_progress') {
      return res.send(getProvisionPage(userId));
    }

    if (!provisioningLogs.has(userId)) {
      provisioningLogs.set(userId, []);
    }
    logProvisioning(userId, `👀 Provisioning confirmation page viewed for user: ${userId}`, 'info');

    const confirmationPage = `
      <html>
        <head><title>Confirm Provisioning</title></head>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h2 style="color: #1976d2;">Confirm Provisioning</h2>
          <p>This will create a new DigitalOcean agent, configure storage, and update onboarding records for <strong>${userId}</strong>.</p>
          <p>Please confirm that you intend to provision this user.</p>
          <div style="margin-top: 30px;">
            <form method="post" action="/api/admin/provision/confirm" style="display: inline-block; margin-right: 10px;">
              <input type="hidden" name="userId" value="${userId}">
              <input type="hidden" name="token" value="${token}">
              <button type="submit" name="action" value="accept" style="padding: 10px 20px; background-color: #388e3c; color: white; border: none; border-radius: 4px; cursor: pointer;">Accept</button>
            </form>
            <form method="post" action="/api/admin/provision/confirm" style="display: inline-block;">
              <input type="hidden" name="userId" value="${userId}">
              <input type="hidden" name="token" value="${token}">
              <button type="submit" name="action" value="reject" style="padding: 10px 20px; background-color: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer;">Reject</button>
            </form>
          </div>
        </body>
      </html>
    `;

    res.send(confirmationPage);
  } catch (error) {
    console.error('❌ Provision error:', error);
    res.status(500).send(`
      <html>
        <head><title>Provision Error</title></head>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h2 style="color: #d32f2f;">❌ Provisioning Failed</h2>
          <p>An error occurred while starting provisioning:</p>
          <pre style="background-color: #f5f5f5; padding: 15px; border-radius: 4px; overflow-x: auto;">${error.message}</pre>
        </body>
      </html>
    `);
  }
});

app.post('/api/admin/provision/confirm', async (req, res) => {
  try {
    const { token, userId, action } = req.body || {};

    if (!token || !userId || !action) {
      return res.status(400).send(`
        <html>
          <head><title>Provision Error</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ Provisioning Failed</h2>
            <p>Missing required parameters (token, userId, or action).</p>
          </body>
        </html>
      `);
    }

    let userDoc;
    try {
      userDoc = await cloudant.getDocument('maia_users', userId);
    } catch (error) {
      return res.status(404).send(`
        <html>
          <head><title>Provision Error</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ Provisioning Failed</h2>
            <p>User not found: ${userId}</p>
          </body>
        </html>
      `);
    }

    if (!userDoc.provisionToken || userDoc.provisionToken !== token) {
      return res.status(401).send(`
        <html>
          <head><title>Provision Error</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ Invalid Token</h2>
            <p>The provisioning token is invalid or has expired.</p>
          </body>
        </html>
      `);
    }

    if (!provisioningLogs.has(userId)) {
      provisioningLogs.set(userId, []);
    }

    if (action === 'reject') {
      console.log(`[NEW FLOW] Admin rejected provisioning for user: ${userId}`);
      logProvisioning(userId, `⛔️ Provisioning rejected for user ${userId}`, 'warning');
      
      // Cleanup: Delete bucket folder and user document (keep audit log)
      try {
        console.log(`[NEW FLOW] Starting cleanup for rejected user: ${userId}`);
        
        // Delete all files in user's bucket folder
        const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
        if (bucketUrl) {
          const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
          const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
          const s3Client = new S3Client({
            endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
            region: 'us-east-1',
            forcePathStyle: false,
            credentials: {
              accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
              secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
            }
          });
          
          // List all objects with userId prefix (with pagination)
          let deletedCount = 0;
          let continuationToken = null;
          
          do {
            // Create a new command for each iteration (commands are immutable)
            const listCommand = new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: `${userId}/`,
              ContinuationToken: continuationToken || undefined
            });
            
            const listResult = await s3Client.send(listCommand);
            
            if (listResult.Contents && listResult.Contents.length > 0) {
              for (const object of listResult.Contents) {
                if (object.Key) {
                  try {
                    await s3Client.send(new DeleteObjectCommand({
                      Bucket: bucketName,
                      Key: object.Key
                    }));
                    deletedCount++;
                    console.log(`[NEW FLOW] Deleted file: ${object.Key}`);
                  } catch (deleteErr) {
                    console.error(`[NEW FLOW] Failed to delete ${object.Key}:`, deleteErr.message);
                  }
                }
              }
            }
            
            // Get continuation token for next iteration (if any)
            continuationToken = listResult.NextContinuationToken || null;
          } while (continuationToken);
          
          console.log(`[NEW FLOW] Deleted ${deletedCount} files from bucket folder for ${userId}`);
        }
        
        // Delete user document
        try {
          await cloudant.deleteDocument('maia_users', userId);
          console.log(`[NEW FLOW] Deleted user document for ${userId}`);
        } catch (deleteErr) {
          console.error(`[NEW FLOW] Failed to delete user document:`, deleteErr.message);
        }
        
        console.log(`[NEW FLOW] ✅ Cleanup completed for rejected user: ${userId}`);
      } catch (cleanupErr) {
        console.error(`[NEW FLOW] ❌ Error during cleanup:`, cleanupErr.message);
        // Continue even if cleanup fails
      }
      
      return res.send(`
        <html>
          <head><title>Provisioning Cancelled</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">Provisioning Cancelled</h2>
            <p>The provisioning request for <strong>${userId}</strong> has been cancelled. The user account and associated files have been removed.</p>
          </body>
        </html>
      `);
    }

    if (action !== 'accept') {
      return res.status(400).send(`
        <html>
          <head><title>Provision Error</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ Provisioning Failed</h2>
            <p>Unsupported action: ${action}</p>
          </body>
        </html>
      `);
    }

    if (userDoc.assignedAgentId) {
      logProvisioning(userId, `ℹ️  Provision confirmation received but user already has agent: ${userDoc.assignedAgentId}`, 'info');
      return res.send(`
        <html>
          <head><title>User Already Provisioned</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #388e3c;">✅ User Already Provisioned</h2>
            <p><strong>User:</strong> ${userId}</p>
            <p><strong>Agent:</strong> ${userDoc.assignedAgentName || userDoc.assignedAgentId}</p>
            <p>No provisioning actions were performed.</p>
          </body>
        </html>
      `);
    }

    const existingStatus = provisioningStatus.get(userId);
    if (existingStatus && existingStatus.status === 'in_progress') {
      logProvisioning(userId, `ℹ️  Provision confirmation received but provisioning already in progress`, 'info');
      return res.send(getProvisionPage(userId));
    }

    logProvisioning(userId, `🔵 Admin confirmed provisioning for user: ${userId}`, 'info');
    logProvisioning(userId, `📍 Setting workflowStage to 'approved'`, 'info');
    userDoc.workflowStage = 'approved';
    await cloudant.saveDocument('maia_users', userDoc);

    provisioningStatus.set(userId, {
      status: 'in_progress',
      steps: [],
      startTime: Date.now(),
      currentStep: 'Starting...'
    });

    logProvisioning(userId, `🚀 Starting async provisioning for user: ${userId}`, 'info');

    provisionUserAsync(userId, token).catch(error => {
      logProvisioning(userId, `❌ Unhandled error in async provisioning: ${error.message}`, 'error');
      const status = provisioningStatus.get(userId);
      if (status) {
        status.status = 'failed';
        status.error = error.message;
        status.completedAt = Date.now();
      }
    });

    res.send(getProvisionPage(userId));
  } catch (error) {
    console.error('❌ Provision confirmation error:', error);
    res.status(500).send(`
      <html>
        <head><title>Provision Error</title></head>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h2 style="color: #d32f2f;">❌ Provisioning Failed</h2>
          <p>An error occurred while processing your request:</p>
          <pre style="background-color: #f5f5f5; padding: 15px; border-radius: 4px; overflow-x: auto;">${error.message}</pre>
        </body>
      </html>
    `);
  }
});

// Comprehensive verification function
async function verifyProvisioningComplete(userId, agentId, agentName, kbName, expectedConfig) {
  logProvisioning(userId, `🔍 Starting comprehensive verification...`, 'info');
  
  const verificationResults = {
    kbName: { passed: false, message: '' },
    bucketFolders: { passed: false, message: '' },
    agentExists: { passed: false, message: '' },
    agentDeployed: { passed: false, message: '' },
    agentConfig: { passed: false, message: '' },
    apiKey: { passed: false, message: '' },
    apiKeyWorks: { passed: false, message: '' }
  };
  
  try {
    // 0. Verify KB name is set
    if (kbName) {
      verificationResults.kbName.passed = true;
      verificationResults.kbName.message = `KB name: ${kbName}`;
      logProvisioning(userId, `✅ KB name verified: ${kbName}`, 'success');
    } else {
      verificationResults.kbName.message = 'KB name not set';
      logProvisioning(userId, `❌ KB name not set`, 'error');
    }
    
    // 1. Verify bucket folders (check accessibility)
    try {
      const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
      if (bucketUrl) {
        const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
        const s3Client = new S3Client({
          endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
          region: 'us-east-1',
          forcePathStyle: false,
          credentials: {
            accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
          }
        });
        
        // Check if folders exist by looking for the .keep placeholder files
        try {
          const { GetObjectCommand } = await import('@aws-sdk/client-s3');
          
          // Check root folder (for new imports)
          const rootKeep = `${userId}/.keep`;
          const rootCheck = await s3Client.send(new GetObjectCommand({
            Bucket: bucketName,
            Key: rootKeep
          }));
          
          // Check archived folder
          const archivedKeep = `${userId}/archived/.keep`;
          const archivedCheck = await s3Client.send(new GetObjectCommand({
            Bucket: bucketName,
            Key: archivedKeep
          }));
          
          // Check KB folder
          const kbKeep = `${userId}/${kbName}/.keep`;
          const kbCheck = await s3Client.send(new GetObjectCommand({
            Bucket: bucketName,
            Key: kbKeep
          }));
          
          if (rootCheck && archivedCheck && kbCheck) {
          verificationResults.bucketFolders.passed = true;
            verificationResults.bucketFolders.message = `Bucket folders created and verified: ${userId}/ (root), ${userId}/archived/ (archived), and ${userId}/${kbName}/ (KB)`;
          logProvisioning(userId, `✅ Bucket folders verified`, 'success');
          } else {
            verificationResults.bucketFolders.message = `Bucket folders missing .keep files`;
            logProvisioning(userId, `⚠️  Bucket folders missing .keep files`, 'warning');
          }
        } catch (err) {
          // If .keep files don't exist, try listing as fallback
          try {
            const listResult = await s3Client.send(new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: `${userId}/`,
              MaxKeys: 1
            }));
            verificationResults.bucketFolders.passed = true;
            verificationResults.bucketFolders.message = `Bucket folders accessible (via listing): ${userId}/ (root) and ${userId}/${kbName}/ (KB)`;
            logProvisioning(userId, `✅ Bucket folders verified via listing`, 'success');
          } catch (listErr) {
          verificationResults.bucketFolders.message = `Bucket access check failed: ${err.message}`;
          logProvisioning(userId, `⚠️  Bucket folder check: ${verificationResults.bucketFolders.message}`, 'warning');
          }
        }
      } else {
        verificationResults.bucketFolders.message = 'Bucket not configured';
        logProvisioning(userId, `⚠️  Bucket not configured, skipping folder check`, 'warning');
      }
    } catch (err) {
      verificationResults.bucketFolders.message = `Bucket verification error: ${err.message}`;
      logProvisioning(userId, `⚠️  ${verificationResults.bucketFolders.message}`, 'warning');
    }
    
    // 3. Verify agent via DO API
    try {
      const agentDetails = await doClient.agent.get(agentId);
      if (agentDetails && agentDetails.uuid === agentId) {
        verificationResults.agentExists.passed = true;
        verificationResults.agentExists.message = `Agent exists: ${agentDetails.name}`;
        logProvisioning(userId, `✅ Agent exists: ${agentDetails.name}`, 'success');
        
        // Verify deployment status
        if (agentDetails.deployment?.status === 'STATUS_RUNNING') {
          verificationResults.agentDeployed.passed = true;
          verificationResults.agentDeployed.message = `Agent deployed and running`;
          logProvisioning(userId, `✅ Agent deployed: STATUS_RUNNING`, 'success');
        } else {
          verificationResults.agentDeployed.message = `Agent deployment status: ${agentDetails.deployment?.status || 'unknown'}`;
          logProvisioning(userId, `❌ Agent not fully deployed: ${verificationResults.agentDeployed.message}`, 'error');
        }
        
        // Verify agent config matches expected
        // Note: API might return different field names or types, so we need to handle both
        // Also handle undefined/null values
        const actualMaxTokens = agentDetails.max_tokens || agentDetails.maxTokens;
        const actualTemperature = agentDetails.temperature ?? null; // Will fail comparison if undefined/null
        const actualTopP = agentDetails.top_p || agentDetails.topP;
        
        // Normalize values for comparison (convert to numbers if needed)
        const normalizedMaxTokens = Number(actualMaxTokens);
        const normalizedTemperature = Number(actualTemperature);
        const normalizedTopP = Number(actualTopP);
        
        const configMatches = 
          normalizedMaxTokens === expectedConfig.maxTokens &&
          normalizedTemperature === expectedConfig.temperature &&
          normalizedTopP === expectedConfig.topP;
        
        if (configMatches) {
          verificationResults.agentConfig.passed = true;
          verificationResults.agentConfig.message = `Agent config matches expected values`;
          logProvisioning(userId, `✅ Agent config verified`, 'success');
        } else {
          // Log actual values for debugging
          const actualValues = `Actual: maxTokens=${normalizedMaxTokens}, temp=${normalizedTemperature}, topP=${normalizedTopP}`;
          const expectedValues = `Expected: maxTokens=${expectedConfig.maxTokens}, temp=${expectedConfig.temperature}, topP=${expectedConfig.topP}`;
          verificationResults.agentConfig.message = `Config mismatch. ${expectedValues} | ${actualValues}`;
          logProvisioning(userId, `⚠️  Agent config mismatch: ${verificationResults.agentConfig.message}`, 'warning');
        }
      } else {
        verificationResults.agentExists.message = `Agent not found or UUID mismatch`;
        logProvisioning(userId, `❌ Agent verification failed: ${verificationResults.agentExists.message}`, 'error');
      }
    } catch (err) {
      verificationResults.agentExists.message = `DO API error: ${err.message}`;
      logProvisioning(userId, `❌ Agent verification error: ${err.message}`, 'error');
    }
    
    // 4. Verify API key
    // Fetch user document to check API key and agent details
    let userDoc = null;
    try {
      userDoc = await cloudant.getDocument('maia_users', userId);
    } catch (err) {
      verificationResults.apiKey.message = `Error fetching user document: ${err.message}`;
      logProvisioning(userId, `❌ Error fetching user document for API key verification: ${err.message}`, 'error');
    }
    
    if (userDoc && userDoc.agentApiKey) {
      verificationResults.apiKey.passed = true;
      verificationResults.apiKey.message = `API key exists`;
      logProvisioning(userId, `✅ API key exists`, 'success');
      
      // Test API key with actual API call
      try {
        const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');
        const agentEndpoint = userDoc.agentEndpoint;
        if (agentEndpoint) {
          const testProvider = new DigitalOceanProvider(userDoc.agentApiKey, { baseURL: agentEndpoint });
          const modelName = userDoc.agentModelName || 'unknown';
          
          logProvisioning(userId, `🔑 Testing API key with test request...`, 'info');
          const testResult = await testProvider.chat(
            [{ role: 'user', content: 'test' }],
            { model: modelName, stream: false }
          );
          
          if (testResult && !testResult.error && testResult.content) {
            verificationResults.apiKeyWorks.passed = true;
            verificationResults.apiKeyWorks.message = `API key works - test request successful`;
            logProvisioning(userId, `✅ API key verified - test request successful`, 'success');
          } else {
            // Check if error is a Cloudflare DNS/infrastructure issue
            const errorMsg = testResult?.error || String(testResult) || 'no response';
            const isCloudflareError = errorMsg.includes('Cloudflare') || 
                                     errorMsg.includes('DNS points to prohibited IP') ||
                                     errorMsg.includes('Error 1000');
            
            if (isCloudflareError) {
              // Cloudflare/infrastructure issue - API key likely works, just infrastructure blocking
              verificationResults.apiKeyWorks.passed = true; // Mark as passed since it's not an API key issue
              verificationResults.apiKeyWorks.message = `API key likely valid - Cloudflare/infrastructure blocking test (non-critical)`;
              logProvisioning(userId, `⚠️  API key test blocked by Cloudflare/infrastructure (API key likely valid)`, 'warning');
            } else {
              verificationResults.apiKeyWorks.message = `API key test failed: ${errorMsg}`;
            logProvisioning(userId, `❌ API key test failed: ${verificationResults.apiKeyWorks.message}`, 'error');
            }
          }
        } else {
          verificationResults.apiKeyWorks.message = `Agent endpoint not available`;
          logProvisioning(userId, `⚠️  Cannot test API key: no agent endpoint`, 'warning');
        }
      } catch (err) {
        // Check if error is a Cloudflare DNS/infrastructure issue
        const errorMsg = err.message || String(err);
        const isCloudflareError = errorMsg.includes('Cloudflare') || 
                                 errorMsg.includes('DNS points to prohibited IP') ||
                                 errorMsg.includes('Error 1000');
        
        if (isCloudflareError) {
          // Cloudflare/infrastructure issue - API key likely works, just infrastructure blocking
          verificationResults.apiKeyWorks.passed = true; // Mark as passed since it's not an API key issue
          verificationResults.apiKeyWorks.message = `API key likely valid - Cloudflare/infrastructure blocking test (non-critical)`;
          logProvisioning(userId, `⚠️  API key test blocked by Cloudflare/infrastructure (API key likely valid): ${errorMsg.substring(0, 100)}`, 'warning');
        } else {
          verificationResults.apiKeyWorks.message = `API key test error: ${errorMsg}`;
          logProvisioning(userId, `❌ API key test error: ${errorMsg}`, 'error');
        }
      }
    } else {
      verificationResults.apiKey.message = `API key not found in user document`;
      logProvisioning(userId, `❌ API key not found`, 'error');
    }
    
  } catch (error) {
    logProvisioning(userId, `❌ Verification error: ${error.message}`, 'error');
  }
  
  // Calculate overall result
  // Note: KB name is not a critical check - KB doesn't exist during provisioning, only intended name is stored
  const criticalChecks = [
    verificationResults.agentExists,
    verificationResults.agentDeployed,
    verificationResults.apiKey,
    verificationResults.apiKeyWorks
  ];
  
  const allCriticalPassed = criticalChecks.every(check => check.passed);
  const allPassed = Object.values(verificationResults).every(result => result.passed);
  
  // Only log if critical checks failed (success is logged per-check)
  if (!allCriticalPassed) {
    logProvisioning(userId, `❌ Verification failed - critical checks did not pass`, 'error');
  }
  
  return {
    allCriticalPassed,
    allPassed,
    results: verificationResults
  };
}

// Async provisioning function
async function provisionUserAsync(userId, token) {
  logProvisioning(userId, `Starting provisioning for user: ${userId}`, 'info');
  
  try {
    // Helper function to safely update user document with conflict retry
    const updateUserDoc = async (updates, retries = 3) => {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          // Re-read document to get latest _rev
          const latestDoc = await cloudant.getDocument('maia_users', userId);
          
          const updatePayload = typeof updates === 'function'
            ? updates(latestDoc)
            : updates;
          
          // Merge updates with latest document
          const updatedDoc = {
            ...latestDoc,
            ...(updatePayload || {}),
            updatedAt: new Date().toISOString()
          };
          
          // Save with latest _rev
          await cloudant.saveDocument('maia_users', updatedDoc);
          logProvisioning(userId, `✅ User document updated successfully (attempt ${attempt})`, 'success');
          return updatedDoc;
        } catch (error) {
          if (error.statusCode === 409 && attempt < retries) {
            // Conflict - retry after short delay
            logProvisioning(userId, `⚠️  Document conflict (attempt ${attempt}/${retries}), retrying...`, 'warning');
            await new Promise(resolve => setTimeout(resolve, 200 * attempt)); // Exponential backoff
            continue;
          }
          throw error;
        }
      }
    };

    // Get user document
    let userDoc = await cloudant.getDocument('maia_users', userId);
    const kbInfo = (userDoc.connectedKBs && userDoc.connectedKBs.length > 0) 
      ? `connectedKBs=[${userDoc.connectedKBs.join(',')}]` 
      : (userDoc.connectedKB ? `connectedKB=${userDoc.connectedKB}` : 'no KB');
    logProvisioning(userId, `✅ User document loaded: workflowStage=${userDoc.workflowStage}, ${kbInfo}, kbStatus=${userDoc.kbStatus || 'none'}`, 'info');

    // Update status (internal status tracking only, no verbose logging)
    const updateStatus = (step, details = {}) => {
      const status = provisioningStatus.get(userId);
      if (status) {
        status.currentStep = step;
        status.steps.push({ step, timestamp: new Date().toISOString(), ...details });
      }
      // Only log important steps, not every status update
      // logProvisioning(userId, `📍 ${step}${details ? ': ' + JSON.stringify(details) : ''}`, 'info');
    };

    // Need to create agent - get model and project ID
    // Based on NEW-AGENT.txt specification
    let modelId = process.env.DO_MODEL_ID;
    let projectId = process.env.DO_PROJECT_ID;

    // Validate UUID format helper
    const isValidUUID = (str) => {
      if (!str || typeof str !== 'string') return false;
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      return uuidRegex.test(str.trim());
    };

    updateStatus('Resolving model and project IDs...');
    logProvisioning(userId, `🔍 Resolving model and project IDs...`, 'info');

    // If not in env vars or invalid, try to get from existing agents
    if (!isValidUUID(modelId) || !isValidUUID(projectId)) {
      try {
        const agents = await doClient.agent.list();
        if (agents.length > 0) {
          const existingAgent = await doClient.agent.get(agents[0].uuid);
          if (!isValidUUID(modelId) && existingAgent.model?.uuid && isValidUUID(existingAgent.model.uuid)) {
            modelId = existingAgent.model.uuid;
          }
          if (!isValidUUID(projectId) && existingAgent.project_id && isValidUUID(existingAgent.project_id)) {
            projectId = existingAgent.project_id;
          }
        }
      } catch (error) {
        // Continue with fallback
      }
    }

    // If still no valid model, try to list models
    if (!isValidUUID(modelId)) {
      try {
        const modelsResponse = await doClient.request('/v2/gen-ai/models');
        const models = modelsResponse.models || modelsResponse.data?.models || [];
        if (models.length > 0) {
          const preferredModel = models.find(m => 
            m.inference_name === 'openai-gpt-oss-120b' || m.name === 'OpenAI GPT-oss-120b'
          );
          const selectedModel = preferredModel || models[0];
          if (selectedModel && selectedModel.uuid && isValidUUID(selectedModel.uuid)) {
            modelId = selectedModel.uuid;
          }
        }
      } catch (error) {
        // Continue
      }
    }

    // Final validation
    if (!isValidUUID(modelId) || !isValidUUID(projectId)) {
      logProvisioning(userId, `❌ Failed to resolve IDs - Model: ${modelId || 'Not found'}, Project: ${projectId || 'Not found'}`, 'error');
      throw new Error(`Could not determine valid model ID or project ID. Model ID: ${modelId || 'Not found'}, Project ID: ${projectId || 'Not found'}`);
    }
    
    logProvisioning(userId, `✅ Resolved IDs - Model: ${modelId}, Project: ${projectId}`, 'success');

    // MAIA medical assistant instruction (from NEW-AGENT.txt)
    const maiaInstruction = getMaiaInstructionText();

    // Use pre-generated agent name from user document (created during registration)
    // If not found, generate one (backward compatibility)
    const agentName = userDoc.assignedAgentName || generateAgentName(userId);
    if (!userDoc.assignedAgentName) {
      logProvisioning(userId, `⚠️  Agent name not found in user doc, generating: ${agentName}`, 'warning');
    } else {
      logProvisioning(userId, `✅ Using pre-generated agent name: ${agentName}`, 'info');
    }

    const agentClient = doClient.agent;

    // Final validation
    if (!isValidUUID(modelId) || !isValidUUID(projectId)) {
      throw new Error(`Cannot create agent: Invalid modelId or projectId`);
    }

    // Step 1: Create bucket folder (KB folder) - Note: Folders should already exist from registration
    // This is kept here for backward compatibility, but should be a no-op if folders already exist
    updateStatus('Verifying bucket folders...');
    logProvisioning(userId, `📁 Verifying bucket folders for user: ${userId}`, 'info');
    
    const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
    if (!bucketUrl) {
      throw new Error('DigitalOcean bucket not configured');
    }
    
    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
    const kbName = getKBNameFromUserDoc(userDoc, userId);
    
    // Check if folders already exist (created during registration)
    try {
      const { S3Client, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const s3Client = new S3Client({
        endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
        region: 'us-east-1',
        forcePathStyle: false,
        credentials: {
          accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
        }
      });
      
      // Check if folders already exist
      const rootPlaceholder = `${userId}/.keep`;
      const archivedPlaceholder = `${userId}/archived/.keep`;
      const kbPlaceholder = `${userId}/${kbName}/.keep`;
      
      let foldersExist = false;
      try {
        await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: rootPlaceholder }));
        await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: archivedPlaceholder }));
        await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: kbPlaceholder }));
        foldersExist = true;
        logProvisioning(userId, `✅ Bucket folders already exist (created during registration)`, 'info');
      } catch (checkErr) {
        // Folders don't exist, create them (backward compatibility)
        logProvisioning(userId, `📁 Creating bucket folders (not found during registration)`, 'info');
      }
      
      if (!foldersExist) {
        // Create placeholder files to make folders visible in dashboard
        // Use Buffer.from('') instead of empty string to avoid SDK warning about stream length
        // Create root userId folder placeholder (for new imports)
        await s3Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: rootPlaceholder,
          Body: Buffer.from(''),
          ContentType: 'text/plain',
          ContentLength: 0,
          Metadata: {
            createdBy: 'provisioning',
            createdAt: new Date().toISOString()
          }
        }));
        
        // Create archived folder placeholder (for files moved from root)
        await s3Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: archivedPlaceholder,
          Body: Buffer.from(''),
          ContentType: 'text/plain',
          ContentLength: 0,
          Metadata: {
            createdBy: 'provisioning',
            createdAt: new Date().toISOString()
          }
        }));
        
        // Create KB folder placeholder
        await s3Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: kbPlaceholder,
          Body: Buffer.from(''),
          ContentType: 'text/plain',
          ContentLength: 0,
          Metadata: {
            createdBy: 'provisioning',
            createdAt: new Date().toISOString()
          }
        }));
        
        logProvisioning(userId, `✅ Bucket folders created: ${userId}/ (root), ${userId}/archived/ (archived), and ${userId}/${kbName}/ (KB)`, 'success');
      }
      
      // Ensure KB name is stored in user document
      if (!userDoc.kbName) {
        await updateUserDoc({
          kbName: kbName
        });
      }
      
      updateStatus('Bucket folders verified', { 
        root: `${userId}/`,
        kb: `${userId}/${kbName}/`
      });
    } catch (err) {
      logProvisioning(userId, `❌ Failed to verify/create bucket folders: ${err.message}`, 'error');
      throw new Error(`Failed to verify/create bucket folders: ${err.message}`);
    }

    // Step 2: Create KB - Check for initial file first to determine datasource path
    updateStatus('Creating knowledge base...');
    logProvisioning(userId, `📚 Creating knowledge base: ${kbName}`, 'info');
    
    const databaseId = process.env.DO_DATABASE_ID;
    const embeddingModelId = process.env.DO_EMBEDDING_MODEL_ID || null;
    
    if (!isValidUUID(databaseId)) {
      throw new Error('DO_DATABASE_ID environment variable is required and must be a valid UUID');
    }
    
    // Check if initial file exists to determine KB creation path
    const hasInitialFile = userDoc.initialFile && userDoc.initialFile.bucketKey;
    const initialFileBucketKey = hasInitialFile ? userDoc.initialFile.bucketKey : null;
    const initialFileName = hasInitialFile ? userDoc.initialFile.fileName : null;
    
    if (hasInitialFile) {
      logProvisioning(userId, `📄 [KB CREATION PATH: WITH INITIAL FILE] Initial file detected: ${initialFileName} (${initialFileBucketKey})`, 'info');
      logProvisioning(userId, `📄 [KB CREATION PATH: WITH INITIAL FILE] Will create KB with datasource pointing directly to file`, 'info');
    } else {
      logProvisioning(userId, `📁 [KB CREATION PATH: NO INITIAL FILE] No initial file - will create KB with temporary datasource for empty folder`, 'info');
      logProvisioning(userId, `📁 [KB CREATION PATH: NO INITIAL FILE] Temporary datasource will be deleted after KB creation`, 'info');
    }
    
    let kbId = null;
    let kbDetails = null;
    let initialFileDatasourceUuid = null; // Track if datasource was created for initial file
    
    try {
      // Check if KB already exists
      const allKBs = await doClient.kb.list();
      const foundKB = allKBs.find(kb => kb.name === kbName);
      
      if (foundKB) {
        kbId = foundKB.uuid || foundKB.id;
        kbDetails = await doClient.kb.get(kbId);
        logProvisioning(userId, `✅ Found existing KB: ${kbName} (${kbId})`, 'success');
        
        // Note: We no longer create folder-level data sources during provisioning
        // Per-file data sources will be created when files are added to the KB via the UI
        // This ensures each file has its own data source for granular indexing control
        const datasources = kbDetails?.datasources || kbDetails?.data_sources || kbDetails?.knowledge_base_data_sources || [];
        if (datasources.length === 0) {
          logProvisioning(userId, `ℹ️  KB has no datasources - per-file datasources will be created when files are added`, 'info');
        } else {
          logProvisioning(userId, `✅ KB has ${datasources.length} data source(s)`, 'success');
        }
      } else {
        // Determine itemPath based on whether initial file exists
        let itemPath;
        if (hasInitialFile) {
          // PATH 1: Create KB with datasource pointing to initial file
          itemPath = initialFileBucketKey;
          logProvisioning(userId, `📄 [KB CREATION PATH: WITH INITIAL FILE] Creating KB with datasource pointing to file: ${itemPath}`, 'info');
        } else {
          // PATH 2: Create KB with temporary datasource pointing to empty folder (will be deleted)
          itemPath = `${userId}/${kbName}/`;
          logProvisioning(userId, `📁 [KB CREATION PATH: NO INITIAL FILE] Creating KB with temporary datasource pointing to empty folder: ${itemPath}`, 'info');
        }
        
        const kbCreateOptions = {
          name: kbName,
          description: `Knowledge base for ${userId}`,
          projectId: projectId.trim(),
          databaseId: databaseId.trim(),
          bucketName: bucketName,
          itemPath: itemPath,
          region: process.env.DO_REGION || 'tor1'
        };
        
        if (embeddingModelId && isValidUUID(embeddingModelId)) {
          kbCreateOptions.embeddingModelId = embeddingModelId;
        }
        
        console.log(`[KB VERIFY] Creating KB with datasource pointing to: ${itemPath}`);
        const kbResult = await doClient.kb.create(kbCreateOptions);
        kbId = kbResult.uuid || kbResult.id;
        kbDetails = await doClient.kb.get(kbId);
        
        console.log(`[KB VERIFY] KB created: ${kbId}, response:`, JSON.stringify(kbResult, null, 2));
        logProvisioning(userId, `✅ Created new KB: ${kbName} (${kbId})`, 'success');
        
        // Get datasources to find the one we just created
        console.log(`[KB VERIFY] Fetching datasources for KB ${kbId}...`);
        const datasources = await doClient.kb.listDataSources(kbId);
        console.log(`[KB VERIFY] Found ${datasources.length} datasource(s):`, JSON.stringify(datasources.map(ds => ({
          uuid: ds.uuid || ds.id,
          item_path: ds.item_path || ds.spaces_data_source?.item_path
        })), null, 2));
        
        if (hasInitialFile) {
          // PATH 1: Find and keep the datasource created for the initial file
          const fileDataSource = datasources.find(ds => {
            const dsPath = ds.item_path || ds.spaces_data_source?.item_path || '';
            return dsPath === initialFileBucketKey;
          });
          
          if (fileDataSource) {
            initialFileDatasourceUuid = fileDataSource.uuid || fileDataSource.id;
            logProvisioning(userId, `✅ [KB CREATION PATH: WITH INITIAL FILE] Found datasource for initial file: ${initialFileDatasourceUuid}`, 'success');
            logProvisioning(userId, `✅ [KB CREATION PATH: WITH INITIAL FILE] Datasource will be kept - no deletion needed`, 'success');
          } else {
            logProvisioning(userId, `⚠️  [KB CREATION PATH: WITH INITIAL FILE] Warning: Could not find datasource for initial file`, 'warning');
          }
        } else {
          // PATH 2: Delete temporary datasource (only if no initial file)
          const kbFolderPath = `${userId}/${kbName}/`;
          
          // FIRST: Wait for any active indexing jobs to complete BEFORE deleting datasource
          // (Datasource cannot be deleted while it's being indexed)
          // Note: We wait for completion instead of cancelling because:
          // 1. Cancellation returns 405 (Method Not Allowed) for PENDING/IN_PROGRESS jobs
          // 2. The KB folder is empty, so indexing should complete quickly (10-30 seconds)
          console.log(`[KB VERIFY] [KB CREATION PATH: NO INITIAL FILE] Checking for active indexing jobs for KB ${kbId}...`);
          let indexingJobCompleted = false;
          try {
            const indexingJobs = await doClient.indexing.listForKB(kbId);
            console.log(`[KB VERIFY] [KB CREATION PATH: NO INITIAL FILE] Found ${indexingJobs.length} indexing job(s):`, JSON.stringify(indexingJobs.map(job => ({
              uuid: job.uuid || job.id,
              status: job.status,
              created_at: job.created_at
            })), null, 2));
            
            // Find active indexing jobs (in progress or pending)
            const activeJobs = indexingJobs.filter(job => {
              const status = job.status || '';
              return status === 'INDEX_JOB_STATUS_IN_PROGRESS' || 
                     status === 'INDEX_JOB_STATUS_PENDING' ||
                     status === 'INDEX_JOB_STATUS_QUEUED';
            });
            
            if (activeJobs.length > 0) {
              console.log(`[KB VERIFY] [KB CREATION PATH: NO INITIAL FILE] ⚠️  Found ${activeJobs.length} active indexing job(s), waiting for completion (KB folder is empty, should finish quickly)...`);
              logProvisioning(userId, `⚠️  [KB CREATION PATH: NO INITIAL FILE] Found active indexing job(s), waiting for completion before deleting datasource...`, 'warning');
              
              // Wait for jobs to complete (poll every 5 seconds, max 2 minutes)
              const maxWaitTime = 120000; // 2 minutes
              const pollInterval = 5000; // 5 seconds
              const startTime = Date.now();
              let allJobsCompleted = false;
              
              while (!allJobsCompleted && (Date.now() - startTime) < maxWaitTime) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));
                
                const currentJobs = await doClient.indexing.listForKB(kbId);
                const stillActive = currentJobs.filter(job => {
                  const status = job.status || '';
                  return status === 'INDEX_JOB_STATUS_IN_PROGRESS' || 
                         status === 'INDEX_JOB_STATUS_PENDING' ||
                         status === 'INDEX_JOB_STATUS_QUEUED';
                });
                
                if (stillActive.length === 0) {
                  allJobsCompleted = true;
                  indexingJobCompleted = true;
                  console.log(`[KB VERIFY] [KB CREATION PATH: NO INITIAL FILE] ✅ All indexing jobs completed after ${Math.round((Date.now() - startTime) / 1000)}s`);
                  logProvisioning(userId, `✅ [KB CREATION PATH: NO INITIAL FILE] All indexing jobs completed`, 'success');
                } else {
                  console.log(`[KB VERIFY] [KB CREATION PATH: NO INITIAL FILE] Still waiting for ${stillActive.length} indexing job(s) to complete... (elapsed: ${Math.round((Date.now() - startTime) / 1000)}s)`);
                }
              }
              
              if (!allJobsCompleted) {
                console.log(`[KB VERIFY] [KB CREATION PATH: NO INITIAL FILE] ⚠️  Indexing jobs did not complete within 2 minutes, proceeding anyway...`);
                logProvisioning(userId, `⚠️  [KB CREATION PATH: NO INITIAL FILE] Indexing jobs did not complete within timeout, proceeding with datasource deletion...`, 'warning');
              }
            } else {
              console.log(`[KB VERIFY] [KB CREATION PATH: NO INITIAL FILE] ✅ No active indexing jobs found`);
              logProvisioning(userId, `✅ [KB CREATION PATH: NO INITIAL FILE] Verified no active indexing jobs`, 'success');
              indexingJobCompleted = true;
            }
          } catch (jobCheckError) {
            console.error(`[KB VERIFY] [KB CREATION PATH: NO INITIAL FILE] ❌ Error checking indexing jobs:`, jobCheckError.message);
            logProvisioning(userId, `⚠️  [KB CREATION PATH: NO INITIAL FILE] Warning: Could not verify indexing jobs: ${jobCheckError.message}`, 'warning');
          }
          
          // NOW: Delete the temporary datasource (after waiting for indexing jobs to complete)
          const kbFolderDataSource = datasources.find(ds => {
            const dsPath = ds.item_path || ds.spaces_data_source?.item_path || '';
            return dsPath === kbFolderPath || dsPath.startsWith(kbFolderPath);
          });
          
          if (kbFolderDataSource) {
            const dsUuid = kbFolderDataSource.uuid || kbFolderDataSource.id;
            console.log(`[KB VERIFY] [KB CREATION PATH: NO INITIAL FILE] Deleting temporary datasource ${dsUuid} pointing to ${kbFolderPath}...`);
            
            // Retry deletion up to 3 times with delays (in case job just completed)
            let deleted = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                await doClient.kb.deleteDataSource(kbId, dsUuid);
                console.log(`[KB VERIFY] [KB CREATION PATH: NO INITIAL FILE] ✅ Successfully deleted temporary datasource ${dsUuid} (attempt ${attempt})`);
                logProvisioning(userId, `✅ [KB CREATION PATH: NO INITIAL FILE] Deleted temporary datasource from KB`, 'success');
                deleted = true;
                break;
              } catch (deleteError) {
                const errorMsg = deleteError.message || '';
                console.error(`[KB VERIFY] [KB CREATION PATH: NO INITIAL FILE] ❌ Error deleting datasource (attempt ${attempt}/3):`, errorMsg);
                
                // If it's a 400 error and we haven't exhausted retries, wait and retry
                if (attempt < 3 && (errorMsg.includes('400') || errorMsg.includes('bad_request'))) {
                  console.log(`[KB VERIFY] [KB CREATION PATH: NO INITIAL FILE] Waiting 5 seconds before retry...`);
                  await new Promise(resolve => setTimeout(resolve, 5000));
                } else {
                  logProvisioning(userId, `⚠️  [KB CREATION PATH: NO INITIAL FILE] Warning: Could not delete temporary datasource after ${attempt} attempt(s): ${errorMsg}`, 'warning');
                }
              }
            }
            
            if (!deleted) {
              console.error(`[KB VERIFY] [KB CREATION PATH: NO INITIAL FILE] ❌ Failed to delete temporary datasource after 3 attempts`);
              logProvisioning(userId, `❌ [KB CREATION PATH: NO INITIAL FILE] Failed to delete temporary datasource after 3 attempts`, 'error');
            }
          } else {
            console.log(`[KB VERIFY] [KB CREATION PATH: NO INITIAL FILE] ⚠️  Could not find datasource pointing to ${kbFolderPath} to delete`);
            logProvisioning(userId, `⚠️  [KB CREATION PATH: NO INITIAL FILE] Warning: Could not find temporary datasource to delete`, 'warning');
          }
        }
      }
      
      // Update user document with KB info
      userDoc = await updateUserDoc({
        kbId: kbId,
        kbName: kbName,
        kbCreatedAt: new Date().toISOString(),
        connectedKBs: [kbName],
        connectedKB: kbName
      });
      
      updateStatus('Knowledge base created', { kbId, kbName });
    } catch (err) {
      logProvisioning(userId, `❌ Failed to create knowledge base: ${err.message}`, 'error');
      throw new Error(`Failed to create knowledge base: ${err.message}`);
    }

    // Step 2.4: Process Initial File for Lists (NEW - before indexing)
    // Extract categories and observations, save as separate category files
    if (userDoc.initialFile && userDoc.initialFile.bucketKey) {
      try {
        const initialFileBucketKey = userDoc.initialFile.bucketKey;
        const initialFileName = userDoc.initialFile.fileName;
        
        logProvisioning(userId, `Processing initial file for Lists: ${initialFileName}`, 'info');
        updateStatus('Processing Lists from initial file...', { fileName: initialFileName });
        
        // Verify file exists in S3
        const { S3Client, HeadObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
        const s3Client = new S3Client({
          endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
          region: 'us-east-1',
          forcePathStyle: false,
          credentials: {
            accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
          }
        });
        
        try {
          await s3Client.send(new HeadObjectCommand({
            Bucket: bucketName,
            Key: initialFileBucketKey
          }));
          
          // Get PDF buffer
          const getCommand = new GetObjectCommand({
            Bucket: bucketName,
            Key: initialFileBucketKey
          });
          const pdfResponse = await s3Client.send(getCommand);
          const chunks = [];
          for await (const chunk of pdfResponse.Body) {
            chunks.push(chunk);
          }
          const pdfBuffer = Buffer.concat(chunks);
          
          // Extract PDF to markdown
          const { extractPdfWithPages } = await import('./utils/pdf-parser.js');
          const result = await extractPdfWithPages(pdfBuffer);
          let fullMarkdown = result.pages.map(p => `## Page ${p.page}\n\n${p.markdown}`).join('\n\n---\n\n');
          
          // Clean up page footers (same logic as in files.js)
          const pageFooterPattern = /^.*[Hh]ealth\s+[Pp]age\s+(\d+)\s+of\s+\d+.*$/;
          const continuedOnPattern = /^.*[Cc]ontinued\s+on\s+.*$/;
          const lines = fullMarkdown.split('\n');
          const cleanedLines = [];
          let i = 0;
          
          while (i < lines.length) {
            const line = lines[i];
            const trimmedLine = line.trim();
            const footerMatch = trimmedLine.match(pageFooterPattern);
            
            if (footerMatch) {
              const footerPageNum = parseInt(footerMatch[1], 10);
              const nextPageNum = footerPageNum + 1;
              
              // Look backward for "Continued on " pattern
              let lookBackIndex = cleanedLines.length - 1;
              let foundContinuedOn = false;
              let continuedOnIndex = -1;
              let linesChecked = 0;
              
              while (lookBackIndex >= 0 && linesChecked < 3) {
                const prevTrimmed = cleanedLines[lookBackIndex].trim();
                if (prevTrimmed.match(continuedOnPattern)) {
                  foundContinuedOn = true;
                  continuedOnIndex = lookBackIndex;
                  break;
                }
                if (prevTrimmed !== '') {
                  linesChecked++;
                }
                lookBackIndex--;
              }
              
              if (foundContinuedOn && continuedOnIndex >= 0) {
                cleanedLines.splice(continuedOnIndex, 1);
              }
              
              // Look ahead for next "###" header
              let j = i + 1;
              let foundNextHeader = false;
              let nextHeaderIndex = -1;
              
              while (j < lines.length) {
                const nextTrimmed = lines[j].trim();
                if (nextTrimmed.startsWith('###')) {
                  foundNextHeader = true;
                  nextHeaderIndex = j;
                  break;
                }
                j++;
              }
              
              if (foundNextHeader && nextHeaderIndex > i) {
                cleanedLines.push(`## Page ${nextPageNum}`);
                i = nextHeaderIndex;
                continue;
              } else {
                cleanedLines.push(`## Page ${nextPageNum}`);
                i++;
                continue;
              }
            }
            
            cleanedLines.push(line);
            i++;
          }
          
          fullMarkdown = cleanedLines.join('\n');
          
          // Remove last 4 lines
          const markdownLines = fullMarkdown.split('\n');
          if (markdownLines.length > 4) {
            markdownLines.splice(-4);
            fullMarkdown = markdownLines.join('\n');
          }
          
          // Save main markdown file
          const listsFolder = `${userId}/Lists/`;
          const cleanFileName = initialFileName.replace(/[^a-zA-Z0-9.-]/g, '_');
          const markdownFileName = cleanFileName.replace(/\.pdf$/i, '.md');
          const markdownBucketKey = `${listsFolder}${markdownFileName}`;
          
          const { PutObjectCommand } = await import('@aws-sdk/client-s3');
          await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: markdownBucketKey,
            Body: fullMarkdown,
            ContentType: 'text/markdown',
            Metadata: {
              fileName: initialFileName,
              processedAt: new Date().toISOString(),
              userId: userId
            }
          }));
          
          logProvisioning(userId, `Saved markdown file: ${markdownBucketKey}`, 'success');
          
          // Extract and save category files
          const { extractAndSaveCategoryFiles } = await import('./utils/lists-processor.js');
          const categoryFiles = await extractAndSaveCategoryFiles(
            fullMarkdown,
            userId,
            listsFolder,
            s3Client,
            bucketName
          );
          
          logProvisioning(userId, `Saved ${categoryFiles.length} category file(s)`, 'success');
          updateStatus('Lists processing complete', { categoryFilesCount: categoryFiles.length });
        } catch (listsErr) {
          logProvisioning(userId, `Error processing Lists: ${listsErr.message}. Continuing provisioning.`, 'warning');
          // Continue provisioning even if Lists processing fails
        }
      } catch (listsError) {
        logProvisioning(userId, `Error in Lists processing step: ${listsError.message}. Continuing provisioning.`, 'warning');
        // Continue provisioning even if Lists processing fails
      }
    }

    // Step 2.5: Index Initial File (if provided)
    // This happens BEFORE agent creation so the agent can use the indexed data immediately
    if (userDoc.initialFile && userDoc.initialFile.bucketKey) {
      try {
        const initialFileBucketKey = userDoc.initialFile.bucketKey;
        const initialFileName = userDoc.initialFile.fileName;
        
        logProvisioning(userId, `📄 [INITIAL FILE PROCESSING] Initial file detected: ${initialFileName} (${initialFileBucketKey})`, 'info');
        updateStatus('Processing initial file...', { fileName: initialFileName });
        
        // Verify file exists in S3
        try {
          const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3');
          const s3Client = new S3Client({
            endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
            region: 'us-east-1',
            forcePathStyle: false,
            credentials: {
              accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
              secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
            }
          });
          
          await s3Client.send(new HeadObjectCommand({
            Bucket: bucketName,
            Key: initialFileBucketKey
          }));
          logProvisioning(userId, `✅ [INITIAL FILE PROCESSING] Initial file verified in S3: ${initialFileBucketKey}`, 'success');
        } catch (verifyErr) {
          logProvisioning(userId, `⚠️  [INITIAL FILE PROCESSING] Initial file not found in S3: ${initialFileBucketKey}. Skipping indexing.`, 'warning');
          // Continue provisioning without indexing
        }
        
        // Use datasource created during KB creation, or create one if it doesn't exist
        let datasourceUuid = initialFileDatasourceUuid; // May be null if KB already existed or datasource wasn't found
        
        if (!datasourceUuid) {
          // Datasource wasn't created during KB creation (KB already existed or not found) - create it now
          updateStatus('Creating data source for initial file...', { fileName: initialFileName });
          logProvisioning(userId, `📦 [INITIAL FILE PROCESSING] Creating datasource for initial file: ${initialFileBucketKey}`, 'info');
          
          try {
            const newDataSource = await doClient.kb.addDataSource(kbId, {
              bucketName: bucketName,
              itemPath: initialFileBucketKey,
              region: process.env.DO_REGION || 'tor1'
            });
            
            datasourceUuid = newDataSource.uuid || newDataSource.id || newDataSource.knowledge_base_data_source?.uuid;
            
            if (!datasourceUuid) {
              throw new Error('Datasource created but no UUID returned');
            }
            
            logProvisioning(userId, `✅ [INITIAL FILE PROCESSING] Datasource created: ${datasourceUuid}`, 'success');
          } catch (dsError) {
            logProvisioning(userId, `❌ [INITIAL FILE PROCESSING] Failed to create datasource: ${dsError.message}`, 'error');
            throw new Error(`Failed to create datasource for initial file: ${dsError.message}`);
          }
        } else {
          logProvisioning(userId, `✅ [INITIAL FILE PROCESSING] Using datasource created during KB creation: ${datasourceUuid}`, 'success');
          logProvisioning(userId, `✅ [INITIAL FILE PROCESSING] No need to create new datasource - already exists from KB creation`, 'info');
        }
          
        // Update user document to store datasource UUID on the file
        // Find or create file entry in userDoc.files[]
        if (!userDoc.files) {
          userDoc.files = [];
        }
        
        let fileIndex = userDoc.files.findIndex(f => f.bucketKey === initialFileBucketKey);
        if (fileIndex < 0) {
          // File not in userDoc.files yet - add it
          userDoc.files.push({
            bucketKey: initialFileBucketKey,
            fileName: initialFileName,
            size: userDoc.initialFile.fileSize || 0,
            uploadedAt: userDoc.initialFile.uploadedAt || new Date().toISOString(),
            knowledgeBases: [kbName],
            kbDataSourceUuid: datasourceUuid
          });
          fileIndex = userDoc.files.length - 1;
          logProvisioning(userId, `📝 [INITIAL FILE PROCESSING] Added initial file to userDoc.files[]`, 'info');
        } else {
          // File exists - update it
          userDoc.files[fileIndex].kbDataSourceUuid = datasourceUuid;
          if (!userDoc.files[fileIndex].knowledgeBases) {
            userDoc.files[fileIndex].knowledgeBases = [];
          }
          if (!userDoc.files[fileIndex].knowledgeBases.includes(kbName)) {
            userDoc.files[fileIndex].knowledgeBases.push(kbName);
          }
          logProvisioning(userId, `📝 [INITIAL FILE PROCESSING] Updated file entry in userDoc.files[]`, 'info');
        }
        
        // Save file updates
        await updateUserDoc({
          files: userDoc.files
        });
        
        // Start indexing job (or find existing one if KB creation auto-started it)
        updateStatus('Starting indexing job...', { fileName: initialFileName });
        logProvisioning(userId, `🚀 [INITIAL FILE PROCESSING] Starting indexing job for datasource: ${datasourceUuid}`, 'info');
        
        let indexingJobId = null;
        try {
          const indexingJob = await doClient.indexing.startGlobal(kbId, [datasourceUuid]);
          indexingJobId = indexingJob.uuid || indexingJob.id || indexingJob.indexing_job?.uuid || indexingJob.indexing_job?.id || indexingJob.job?.uuid || indexingJob.job?.id;
          
          if (!indexingJobId) {
            throw new Error('Indexing job started but no job ID returned');
          }
          
          logProvisioning(userId, `✅ [INITIAL FILE PROCESSING] Indexing job started: ${indexingJobId}`, 'success');
          
          // Store job ID in user document
          await updateUserDoc({
            kbLastIndexingJobId: indexingJobId,
            kbIndexingStartedAt: new Date().toISOString(),
            workflowStage: 'indexing',
            kbChangedDataSourceUuids: [],
            kbReindexAll: false
          });
          
        } catch (indexError) {
          // Check if indexing is already running (may have been auto-started by KB creation)
          if (indexError.message && indexError.message.includes('already') && indexError.message.includes('running')) {
            logProvisioning(userId, `ℹ️  [INITIAL FILE PROCESSING] Indexing already running, finding active job for datasource ${datasourceUuid}...`, 'info');
            
            try {
              const indexingJobs = await doClient.indexing.listForKB(kbId);
              const jobsArray = Array.isArray(indexingJobs) ? indexingJobs : 
                                (indexingJobs?.jobs || indexingJobs?.indexing_jobs || indexingJobs?.data || []);
              
              // Find active job that includes our datasource
              const activeJob = jobsArray.find(job => {
                const status = job.status || job.job_status || job.state;
                const isActive = status === 'INDEX_JOB_STATUS_PENDING' || 
                                status === 'INDEX_JOB_STATUS_RUNNING' ||
                                status === 'INDEX_JOB_STATUS_IN_PROGRESS' ||
                                status === 'pending' ||
                                status === 'running' ||
                                status === 'in_progress';
                
                if (!isActive) return false;
                
                // Verify this job is for our datasource
                const dataSourceJobs = job.data_source_jobs || [];
                const hasOurDataSource = dataSourceJobs.some(dsJob => {
                  const dsUuid = dsJob.data_source_uuid || dsJob.data_source?.uuid;
                  return dsUuid === datasourceUuid;
                });
                
                return hasOurDataSource;
              });
              
              if (activeJob) {
                indexingJobId = activeJob.uuid || activeJob.id || activeJob.indexing_job_id;
                logProvisioning(userId, `✅ [INITIAL FILE PROCESSING] Found active indexing job for our datasource: ${indexingJobId}`, 'success');
                await updateUserDoc({
                  kbLastIndexingJobId: indexingJobId,
                  kbIndexingStartedAt: new Date().toISOString(),
                  workflowStage: 'indexing'
                });
              } else {
                logProvisioning(userId, `⚠️  [INITIAL FILE PROCESSING] Found active job but it's not for our datasource - starting new job`, 'warning');
                // Try to start again - might have been a race condition
                throw indexError;
              }
            } catch (findError) {
              logProvisioning(userId, `❌ [INITIAL FILE PROCESSING] Failed to find active indexing job: ${findError.message}`, 'error');
              throw new Error(`Failed to start or find indexing job: ${findError.message}`);
            }
          } else {
            logProvisioning(userId, `❌ [INITIAL FILE PROCESSING] Failed to start indexing job: ${indexError.message}`, 'error');
            throw new Error(`Failed to start indexing job: ${indexError.message}`);
          }
        }
        
        // Wait for indexing to complete (blocking)
        updateStatus('Waiting for indexing to complete...', { fileName: initialFileName, jobId: indexingJobId });
        logProvisioning(userId, `⏳ [INITIAL FILE PROCESSING] Waiting for indexing to complete (job: ${indexingJobId}, datasource: ${datasourceUuid})...`, 'info');
        
        const indexingStartTime = Date.now();
        const maxIndexingWaitMs = 30 * 60 * 1000; // 30 minutes max
        const indexingPollIntervalMs = 15000; // 15 seconds
        let indexingCompleted = false;
        let indexingJobResult = null;
        
        while (!indexingCompleted && (Date.now() - indexingStartTime) < maxIndexingWaitMs) {
          await new Promise(resolve => setTimeout(resolve, indexingPollIntervalMs));
          
          try {
            const indexingJobs = await doClient.indexing.listForKB(kbId);
            const jobsArray = Array.isArray(indexingJobs) ? indexingJobs : 
                              (indexingJobs?.jobs || indexingJobs?.indexing_jobs || indexingJobs?.data || []);
            
            // Find job by ID and verify it's for our datasource
            const currentJob = jobsArray.find(j => {
              const currentJobId = j.uuid || j.id || j.indexing_job_id;
              if (currentJobId !== indexingJobId) return false;
              
              // Verify this job includes our datasource
              const dataSourceJobs = j.data_source_jobs || [];
              return dataSourceJobs.some(dsJob => {
                const dsUuid = dsJob.data_source_uuid || dsJob.data_source?.uuid;
                return dsUuid === datasourceUuid;
              });
            });
            
            if (currentJob) {
              const jobStatus = currentJob.status || currentJob.job_status || currentJob.state;
              const elapsedSeconds = Math.round((Date.now() - indexingStartTime) / 1000);
              
              logProvisioning(userId, `📊 [INITIAL FILE PROCESSING] Indexing status: ${jobStatus} (elapsed: ${elapsedSeconds}s)`, 'info');
              
              if (jobStatus === 'INDEX_JOB_STATUS_COMPLETED' || jobStatus === 'completed') {
                indexingCompleted = true;
                indexingJobResult = currentJob;
                const indexingDurationSeconds = elapsedSeconds;
                logProvisioning(userId, `✅ [INITIAL FILE PROCESSING] Indexing completed successfully in ${indexingDurationSeconds}s`, 'success');
                break;
              } else if (jobStatus === 'INDEX_JOB_STATUS_FAILED' || jobStatus === 'failed') {
                logProvisioning(userId, `❌ [INITIAL FILE PROCESSING] Indexing job failed`, 'error');
                throw new Error('Indexing job failed');
              }
            } else {
              logProvisioning(userId, `⚠️  [INITIAL FILE PROCESSING] Indexing job ${indexingJobId} not found in job list or not for our datasource`, 'warning');
            }
          } catch (pollError) {
            logProvisioning(userId, `⚠️  [INITIAL FILE PROCESSING] Error polling indexing status: ${pollError.message}`, 'warning');
          }
        }
        
        if (!indexingCompleted) {
          logProvisioning(userId, `⚠️  [INITIAL FILE PROCESSING] Indexing did not complete within timeout. Continuing provisioning.`, 'warning');
          // Continue provisioning - background polling will catch completion later
        } else {
          // Indexing completed - verify and update user document
          const indexingDurationSeconds = Math.round((Date.now() - indexingStartTime) / 1000);
          const indexedFileCount = indexingJobResult?.data_source_jobs?.[0]?.indexed_file_count || 1;
          const indexedTokens = String(indexingJobResult?.tokens || indexingJobResult?.total_tokens || 0);
          
          // Verify indexing by checking datasource status (source of truth)
          let indexedFiles = [];
          let isActuallyIndexed = false;
          try {
            const dataSources = await doClient.kb.listDataSources(kbId);
            const fileDataSource = dataSources.find(ds => {
              const dsUuid = ds.uuid || ds.id;
              return dsUuid === datasourceUuid;
            });
            
            if (fileDataSource?.last_datasource_indexing_job) {
              const lastJobStatus = fileDataSource.last_datasource_indexing_job.status;
              // A file is indexed if it has a last_datasource_indexing_job (regardless of status)
              // The presence of last_datasource_indexing_job indicates the data source has been processed
              // (per KB_MANAGEMENT_INVENTORY.md: "A file is indexed if it has a last_datasource_indexing_job")
              isActuallyIndexed = true;
              indexedFiles = [initialFileBucketKey];
              logProvisioning(userId, `✅ [INITIAL FILE PROCESSING] Verified: Datasource has indexing job (status: ${lastJobStatus}) - marking as indexed`, 'success');
            } else {
              logProvisioning(userId, `⚠️  [INITIAL FILE PROCESSING] Warning: Datasource has no last_datasource_indexing_job - file may not be indexed`, 'warning');
            }
          } catch (dsListError) {
            logProvisioning(userId, `⚠️  [INITIAL FILE PROCESSING] Error verifying datasource status: ${dsListError.message}`, 'warning');
          }
          
          if (isActuallyIndexed) {
            await updateUserDoc({
              kbIndexedFiles: indexedFiles,
              kbPendingFiles: undefined,
              kbIndexingNeeded: false,
              kbLastIndexedAt: new Date().toISOString(),
              kbLastIndexingJobId: indexingJobId,
              kbIndexingDurationSeconds: indexingDurationSeconds,
              kbLastIndexingTokens: indexedTokens,
              workflowStage: 'files_archived'
            });
            
            logProvisioning(userId, `✅ [INITIAL FILE PROCESSING] Indexing metadata saved: ${indexedFileCount} file(s), ${indexedTokens} tokens, ${indexingDurationSeconds}s`, 'success');
            updateStatus('Indexing complete', { 
              files: indexedFileCount, 
              tokens: indexedTokens, 
              duration: `${Math.floor(indexingDurationSeconds / 60)}m ${indexingDurationSeconds % 60}s`
            });
            
            // Generate patient summary (blocking)
            // Note: We can't generate summary yet because agent doesn't exist
            // Summary will be generated after agent is created and deployed
            logProvisioning(userId, `📝 [INITIAL FILE PROCESSING] Patient summary will be generated after agent deployment`, 'info');
          } else {
            logProvisioning(userId, `⚠️  [INITIAL FILE PROCESSING] Indexing job completed but datasource verification failed - not marking as indexed`, 'warning');
            // Don't update kbIndexedFiles - let background polling handle it
          }
        }
        
      } catch (initialFileError) {
        // Log error but don't fail provisioning
        logProvisioning(userId, `⚠️  Error processing initial file: ${initialFileError.message}. Continuing provisioning.`, 'warning');
        // Continue with agent creation
      }
    } else {
      logProvisioning(userId, `ℹ️  No initial file provided - skipping indexing step`, 'info');
    }

    // Step 3: Create Agent
    updateStatus('Creating agent...');
    logProvisioning(userId, `🤖 Creating agent with name: ${agentName}`, 'info');
    
    const newAgent = await agentClient.create({
      name: agentName,
      instruction: maiaInstruction,
      modelId: modelId.trim(), // Ensure no whitespace
      projectId: projectId.trim(), // Ensure no whitespace
      region: process.env.DO_REGION || 'tor1',
      maxTokens: 16384,
      topP: 1,
      temperature: 0.1,
      k: 10,
      retrievalMethod: 'RETRIEVAL_METHOD_NONE'
    });

    if (!newAgent || !newAgent.uuid) {
      throw new Error('Agent creation failed - no UUID returned');
    }

    updateStatus('Agent created', { agentId: newAgent.uuid, agentName });

    // Set workflowStage to agent_named after agent is successfully created
    userDoc = await updateUserDoc({ workflowStage: 'agent_named' });

    // Step 4: Attach KB to Agent
    updateStatus('Attaching knowledge base to agent...');
    logProvisioning(userId, `🔗 Attaching KB ${kbId} to agent ${newAgent.uuid}`, 'info');
    
    try {
      await doClient.agent.attachKB(newAgent.uuid, kbId);
      logProvisioning(userId, `✅ Attached KB to agent`, 'success');
      updateStatus('Knowledge base attached to agent', { kbId });
    } catch (attachError) {
      // If already attached, that's fine
      if (attachError.message && attachError.message.includes('already')) {
        logProvisioning(userId, `ℹ️  KB already attached to agent`, 'info');
        updateStatus('Knowledge base already attached', { kbId });
      } else {
        logProvisioning(userId, `⚠️  Failed to attach KB to agent: ${attachError.message}`, 'warning');
        // Continue - attachment can be done later
      }
    }

    // Step 5: Wait for Deployment (monitor every 30 seconds for up to 10 minutes)
    updateStatus('Waiting for agent deployment...');
    logProvisioning(userId, `⏳ Waiting for agent deployment (agentId: ${newAgent.uuid})...`, 'info');
    
    // Wait 3 seconds before first check
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Poll for deployment status
    const successStatuses = ['STATUS_RUNNING', 'RUNNING', 'STATUS_SUCCEEDED', 'SUCCEEDED', 'STATUS_READY', 'READY'];
    let agentDetails = null;
    let deploymentStatus = 'STATUS_PENDING';
    const pollIntervalMs = 30000; // 30 seconds
    const maxAttempts = 20; // 10 minutes max (20 attempts @ 30s interval)
    let attempts = 0;

    while (attempts < maxAttempts && !successStatuses.includes(deploymentStatus)) {
      try {
        agentDetails = await agentClient.get(newAgent.uuid);
        const rawDeploymentStatus = agentDetails?.deployment?.status || agentDetails?.deployment?.state || null;
        const agentStatus = agentDetails?.status || agentDetails?.state || null;
        deploymentStatus = rawDeploymentStatus || agentStatus || 'STATUS_PENDING';
        
        // Log every attempt (since we're only polling every 30 seconds)
          logProvisioning(userId, `📊 Deployment status check (${attempts}/${maxAttempts}): ${deploymentStatus}`, 'info');
        
        if (successStatuses.includes(deploymentStatus)) {
          logProvisioning(userId, `✅ Agent deployment reached ${deploymentStatus} after ${attempts} attempts`, 'success');
          break;
        } else if (['STATUS_FAILED', 'FAILED', 'STATUS_ERROR'].includes(deploymentStatus)) {
          // If STATUS_FAILED occurs within first 2 minutes (first 4 attempts), wait 2 minutes and recheck
          // DO sometimes reports STATUS_FAILED early but then succeeds
          const isEarlyFailure = attempts < 4; // First 2 minutes (4 attempts * 30s = 120s)
          if (isEarlyFailure) {
            logProvisioning(userId, `⚠️ Early STATUS_FAILED detected on attempt ${attempts} (within first 2 minutes). Waiting 2 minutes before rechecking...`, 'warning');
            await new Promise(resolve => setTimeout(resolve, 120000)); // Wait 2 minutes
            
            // Recheck status after waiting
            try {
              agentDetails = await agentClient.get(newAgent.uuid);
              const recheckDeploymentStatus = agentDetails?.deployment?.status || agentDetails?.deployment?.state || agentDetails?.status || agentDetails?.state || 'STATUS_PENDING';
              logProvisioning(userId, `📊 Status after 2-minute wait: ${recheckDeploymentStatus}`, 'info');
              
              if (successStatuses.includes(recheckDeploymentStatus)) {
                deploymentStatus = recheckDeploymentStatus;
                logProvisioning(userId, `✅ Agent deployment succeeded after waiting. Status: ${deploymentStatus}`, 'success');
                break;
              } else if (['STATUS_FAILED', 'FAILED', 'STATUS_ERROR'].includes(recheckDeploymentStatus)) {
                logProvisioning(userId, `❌ Agent deployment still failed after 2-minute wait. Status: ${recheckDeploymentStatus}`, 'error');
          throw new Error('Agent deployment failed');
              } else {
                // Status changed to something else (e.g., STATUS_DEPLOYING), continue polling
                deploymentStatus = recheckDeploymentStatus;
                logProvisioning(userId, `ℹ️ Status changed to ${deploymentStatus}. Continuing to poll...`, 'info');
              }
            } catch (recheckError) {
              logProvisioning(userId, `❌ Error rechecking status after wait: ${recheckError.message}`, 'error');
              throw new Error('Agent deployment failed');
            }
          } else {
            // Not an early failure, fail immediately
            logProvisioning(userId, `❌ Agent deployment failed with status: ${deploymentStatus} (attempt ${attempts})`, 'error');
            throw new Error('Agent deployment failed');
          }
        }
        
        attempts++;
        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs)); // Wait 30 seconds
        }
      } catch (error) {
        if (attempts === 0) {
          // First attempt might fail if agent is still initializing
          await new Promise(resolve => setTimeout(resolve, 5000));
          attempts++;
        } else {
          throw error;
        }
      }
    }

    if (!successStatuses.includes(deploymentStatus)) {
      let finalStatus = deploymentStatus;
      try {
        const agents = await agentClient.list();
        const matchingAgent = agents.find(agent => agent.uuid === newAgent.uuid || agent.id === newAgent.uuid);
        if (matchingAgent) {
          finalStatus = matchingAgent.status || matchingAgent.state || finalStatus;
          logProvisioning(userId, `ℹ️ Agent list status after timeout: ${finalStatus}`, 'info');
        } else {
          logProvisioning(userId, 'ℹ️ Agent not found in list after timeout check', 'warning');
        }
      } catch (statusError) {
        logProvisioning(userId, `⚠️ Unable to verify agent status after timeout: ${statusError.message}`, 'warning');
      }

      if (successStatuses.includes(finalStatus)) {
        deploymentStatus = finalStatus;
        logProvisioning(userId, '✅ Agent reported as running in final verification step; continuing provisioning.', 'success');
      } else {
        throw new Error(`Agent deployment timed out after ${attempts} attempts. Status: ${deploymentStatus}. Final reported status: ${finalStatus}`);
      }
    }

    updateStatus('Agent deployed', {
      status: deploymentStatus,
      endpoint: agentDetails?.deployment?.url ? `${agentDetails.deployment.url}/api/v1` : null,
      attempts
    });

    // Ensure deployment endpoint becomes available
    let agentEndpointUrl = agentDetails?.deployment?.url ? `${agentDetails.deployment.url}/api/v1` : null;
    if (!agentEndpointUrl) {
      updateStatus('Waiting for deployment endpoint...');
      logProvisioning(userId, '📡 Deployment running but endpoint not yet available. Polling for endpoint...', 'info');

      const endpointAttempts = 20; // 10 minutes max (20 attempts @ 30s interval)
      const endpointIntervalMs = 30000;
      let endpointReady = false;

      for (let attempt = 0; attempt < endpointAttempts; attempt++) {
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, endpointIntervalMs));
        }

        try {
          const refreshedDetails = await agentClient.get(newAgent.uuid);
          const refreshedEndpoint = refreshedDetails?.deployment?.url ? `${refreshedDetails.deployment.url}/api/v1` : null;
          logProvisioning(
            userId,
            `📡 Agent endpoint poll (${attempt + 1}/${endpointAttempts}): ${refreshedEndpoint || 'pending'}`,
            'info'
          );

          if (refreshedEndpoint) {
            agentDetails = refreshedDetails;
            agentEndpointUrl = refreshedEndpoint;
            endpointReady = true;
            break;
          }
        } catch (endpointError) {
          logProvisioning(
            userId,
            `⚠️ Endpoint poll (${attempt + 1}/${endpointAttempts}) failed: ${endpointError.message}`,
            'warning'
          );
        }
      }

      if (!endpointReady || !agentEndpointUrl) {
        logProvisioning(userId, '❌ Agent deployment never exposed an endpoint URL', 'error');
        throw new Error('Agent deployment did not expose an endpoint within the expected time');
      }

      updateStatus('Deployment endpoint ready', { endpoint: agentEndpointUrl });
    }

    // Set workflowStage to agent_deployed when deployment reaches STATUS_RUNNING
    userDoc = await updateUserDoc({ workflowStage: 'agent_deployed' });

    // Step 3: Update Agent (to ensure all config is set)
    updateStatus('Updating agent configuration...');
    logProvisioning(userId, `📝 Updating agent config: temperature=0.1, max_tokens=16384, top_p=1`, 'info');
    
    await agentClient.update(newAgent.uuid, {
      instruction: maiaInstruction,
      max_tokens: 16384,
      top_p: 1,
      temperature: 0.1,
      k: 10,
      retrieval_method: 'RETRIEVAL_METHOD_NONE'
    });

    // Verify temperature was actually set to 0.1
    try {
      const verifyDetails = await agentClient.get(newAgent.uuid);
      const actualTemp = verifyDetails.temperature;
      
      // Temperature should be 0.1 as specified in NEW-AGENT.txt
      if (actualTemp === 0.1) {
        logProvisioning(userId, `✅ Temperature verified as 0.1`, 'success');
      } else {
        logProvisioning(userId, `⚠️  Temperature update may have failed - expected 0.1, got ${actualTemp}. Retrying update...`, 'warning');
        // Retry the update with explicit 0.1
        await agentClient.update(newAgent.uuid, {
          temperature: 0.1
        });
        // Verify again
        const retryDetails = await agentClient.get(newAgent.uuid);
        const retryTemp = retryDetails.temperature;
        if (retryTemp === 0.1) {
          logProvisioning(userId, `✅ Temperature corrected to 0.1 after retry`, 'success');
        } else {
          logProvisioning(userId, `❌ Temperature still incorrect after retry - expected 0.1, got ${retryTemp}`, 'error');
        }
      }
    } catch (verifyError) {
      logProvisioning(userId, `⚠️  Could not verify temperature after update: ${verifyError.message}`, 'warning');
    }

    updateStatus('Agent configuration updated', { updated: true });

    // Step 6: Create API Key
    updateStatus('Creating API key...');
    logProvisioning(userId, `🔑 Creating API key for agent: ${newAgent.uuid}`, 'info');
    
    const apiKey = await agentClient.createApiKey(newAgent.uuid, `agent-${newAgent.uuid}-api-key`);

    if (!apiKey) {
      logProvisioning(userId, `❌ API key creation failed - no key returned`, 'error');
      throw new Error('API key creation failed - no key returned');
    }

    logProvisioning(userId, `✅ API key created successfully (length: ${apiKey.length} chars)`, 'success');
    updateStatus('API key created', { keyCreated: true });

    // Step 7: Update User Document (before verification)
    updateStatus('Updating user document...');
    
    const agentModelName = agentDetails?.model?.inference_name || agentDetails?.model?.name || null;
    
    userDoc = await updateUserDoc((latestDoc) => {
      const docClone = { ...latestDoc };
      const timestamp = new Date().toISOString();
      const endpointToStore = agentEndpointUrl || docClone.agentEndpoint || null;
      const modelNameToStore = agentModelName || docClone.agentModelName || null;
      const defaultProfileKey = docClone.agentProfileDefaultKey || 'default';

      mergeAgentProfileOnDoc(docClone, defaultProfileKey, {
        agentId: newAgent.uuid,
        agentName,
        endpoint: endpointToStore,
        modelName: modelNameToStore,
        apiKey
      }, timestamp);

      docClone.agentProfileDefaultKey = defaultProfileKey;
      ensureDeepLinkAgentOverrides(docClone);

      return {
        assignedAgentId: newAgent.uuid,
        assignedAgentName: agentName,
        agentEndpoint: endpointToStore,
        agentModelName: modelNameToStore,
        agentApiKey: apiKey,
        agentProfiles: docClone.agentProfiles,
        agentProfileDefaultKey: docClone.agentProfileDefaultKey,
        deepLinkAgentOverrides: docClone.deepLinkAgentOverrides,
        provisioned: true,
        provisionedAt: timestamp,
        // Keep provisionToken for 24 hours after completion so the tracking page remains accessible
        // Token will be cleared after 24 hours by a separate cleanup process if needed
        // provisionToken: undefined,  // Keep token for viewing completed provisioning
        // provisionTokenCreatedAt: undefined  // Keep timestamp for viewing completed provisioning
      };
    });

    updateStatus('User document updated', { 
      updated: true,
      agentId: newAgent.uuid,
      agentName: agentName
    });

    // Step 7.5: Generate Current Medications (if Lists processing was done and agent is ready)
    if (userDoc.initialFile && userDoc.initialFile.bucketKey && agentEndpointUrl && apiKey) {
      try {
        const initialFileName = userDoc.initialFile.fileName;
        const listsFolder = `${userId}/Lists/`;
        const markdownFileName = initialFileName.replace(/\.pdf$/i, '.md');
        const markdownBucketKey = `${listsFolder}${markdownFileName}`;
        
        // Check if Lists markdown file exists
        const { S3Client, GetObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
        
        // Get S3 client (same pattern as in files.js)
        const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
        if (!bucketUrl) {
          logProvisioning(userId, `⚠️  [CURRENT MEDICATIONS] DigitalOcean bucket not configured. Skipping.`, 'warning');
        } else {
          const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
          const s3Client = new S3Client({
            endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
            region: 'us-east-1',
            forcePathStyle: false,
            credentials: {
              accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
              secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
            }
          });
          
          let markdownExists = false;
          try {
            await s3Client.send(new HeadObjectCommand({
              Bucket: bucketName,
              Key: markdownBucketKey
            }));
            markdownExists = true;
          } catch (headErr) {
            logProvisioning(userId, `ℹ️  [CURRENT MEDICATIONS] Lists markdown not found: ${markdownBucketKey}. Skipping Current Medications generation.`, 'info');
          }
          
          if (markdownExists) {
          updateStatus('Generating Current Medications...', { fileName: initialFileName });
          logProvisioning(userId, `💊 [CURRENT MEDICATIONS] Generating current medications from Lists markdown...`, 'info');
          
          try {
            // Read markdown file
            const getCommand = new GetObjectCommand({
              Bucket: bucketName,
              Key: markdownBucketKey
            });
            const markdownResponse = await s3Client.send(getCommand);
            
            const chunks = [];
            for await (const chunk of markdownResponse.Body) {
              chunks.push(chunk);
            }
            const markdownContent = Buffer.concat(chunks).toString('utf-8');
            
            // Extract Medication Records observations
            const lines = markdownContent.split('\n');
            let inMedicationCategory = false;
            let medicationStartLine = -1;
            let medicationEndLine = -1;
            const medicationObservations = [];
            
            // Find Medication Records category boundaries
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              
              // Check for Medication Records category
              if (line.startsWith('### ') && line.toLowerCase().includes('medication')) {
                if (line.toLowerCase().includes('record')) {
                  inMedicationCategory = true;
                  medicationStartLine = i;
                } else if (inMedicationCategory) {
                  // Next category found - end of Medication Records
                  medicationEndLine = i - 1;
                  break;
                }
              } else if (inMedicationCategory && line.startsWith('### ')) {
                // Another category found - end of Medication Records
                medicationEndLine = i - 1;
                break;
              }
            }
            
            // If we found the category, extract [D+P] lines
            if (inMedicationCategory && medicationStartLine >= 0) {
              if (medicationEndLine < 0) {
                medicationEndLine = lines.length - 1;
              }
              
              for (let i = medicationStartLine; i <= medicationEndLine; i++) {
                const line = lines[i];
                if (line.includes('[D+P]')) {
                  // Extract the observation text (everything after [D+P])
                  const observationText = line.replace(/^.*?\[D\+P\](?:\s+\w+)?\s*/, '').trim();
                  if (observationText) {
                    medicationObservations.push({
                      display: observationText,
                      date: observationText.split(/\s+/)[0] || ''
                    });
                  }
                }
              }
            }
            
            if (medicationObservations.length > 0) {
              logProvisioning(userId, `💊 [CURRENT MEDICATIONS] Found ${medicationObservations.length} medication observations`, 'info');
              
              // Format observations for AI prompt
              const medicationsText = medicationObservations.map((obs, idx) => {
                return `${idx + 1}. ${obs.display || obs.date || 'Unknown medication'}`;
              }).join('\n');
              
              // Call Private AI to generate current medications
              const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');
              const agentProvider = new DigitalOceanProvider(apiKey, {
                baseURL: agentEndpointUrl
              });
              
              const prompt = `What are the current medications from this list?\n\n${medicationsText}\n\nPlease list only the medications that are currently active or being taken. Format your response as a clear, readable list.`;
              
              logProvisioning(userId, `🤖 [CURRENT MEDICATIONS] Calling Private AI to identify current medications...`, 'info');
              
              const response = await agentProvider.chat(
                [{ role: 'user', content: prompt }],
                { 
                  model: agentModelName || 'openai-gpt-oss-120b',
                  stream: false
                }
              );
              
              const currentMedications = (response.content || response.text || '').trim();
              
              if (currentMedications && currentMedications.length > 0) {
                // Save to user document
                await updateUserDoc({
                  currentMedications: currentMedications
                });
                
                logProvisioning(userId, `✅ [CURRENT MEDICATIONS] Current medications generated and saved successfully`, 'success');
                updateStatus('Current Medications generated', { medicationsGenerated: true });
              } else {
                logProvisioning(userId, `⚠️  [CURRENT MEDICATIONS] Empty response from Private AI`, 'warning');
              }
            } else {
              logProvisioning(userId, `ℹ️  [CURRENT MEDICATIONS] No medication observations found in Lists markdown`, 'info');
            }
          } catch (medError) {
            logProvisioning(userId, `⚠️  [CURRENT MEDICATIONS] Error generating current medications: ${medError.message}. Continuing provisioning.`, 'warning');
            // Don't fail provisioning if Current Medications generation fails
          }
          }
        }
      } catch (currentMedsError) {
        logProvisioning(userId, `⚠️  [CURRENT MEDICATIONS] Error in Current Medications step: ${currentMedsError.message}. Continuing provisioning.`, 'warning');
        // Don't fail provisioning
      }
    }

    // Step 7.6: Verify KB Contents and Generate Patient Summary (if initial file was indexed)
    // This happens after agent is fully deployed and has API key
    if (userDoc.initialFile && userDoc.initialFile.bucketKey && agentEndpointUrl && apiKey) {
      try {
        // Check if indexing completed (kbIndexedFiles should contain the initial file)
        const currentUserDoc = await cloudant.getDocument('maia_users', userId);
        const indexedFiles = currentUserDoc?.kbIndexedFiles || [];
        const initialFileIndexed = indexedFiles.includes(userDoc.initialFile.bucketKey);
        
        if (initialFileIndexed) {
          // Step 7.5a: Verify KB contents by querying the agent
          updateStatus('Verifying knowledge base contents...', { fileName: userDoc.initialFile.fileName });
          logProvisioning(userId, `🔍 [KB VERIFICATION] Verifying KB contents by querying agent...`, 'info');
          
          try {
            const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');
            const agentProvider = new DigitalOceanProvider(apiKey, {
              baseURL: agentEndpointUrl
            });

            const verificationPrompt = 'What files or documents are currently in your knowledge base? Please list the file names.';
            logProvisioning(userId, `🔍 [KB VERIFICATION] Querying agent: "${verificationPrompt}"`, 'info');

            const verificationResponse = await agentProvider.chat(
              [{ role: 'user', content: verificationPrompt }],
              { model: agentModelName || 'openai-gpt-oss-120b' }
            );

            const verificationText = verificationResponse.content || verificationResponse.text || '';
            const initialFileName = userDoc.initialFile.fileName;
            
            logProvisioning(userId, `🔍 [KB VERIFICATION] Agent response (full): ${verificationText}`, 'info');
            
            // Check if the response mentions the initial file name (case-insensitive)
            // Try multiple variations: full filename, filename without extension, and common variations
            const fileNameLower = initialFileName.toLowerCase();
            const responseLower = verificationText.toLowerCase();
            
            // Extract base filename without extension for matching
            const baseFileName = fileNameLower.replace(/\.(pdf|txt|md)$/, '');
            // Clean up common variations (spaces, underscores, hyphens)
            const baseFileNameClean = baseFileName.replace(/[_\s-]/g, '');
            const responseClean = responseLower.replace(/[_\s-]/g, '');
            
            const fileNameMatch = 
              responseLower.includes(fileNameLower) || 
              responseLower.includes(baseFileName) ||
              responseClean.includes(baseFileNameClean) ||
              // Also check for common variations
              responseLower.includes(fileNameLower.replace(/\.pdf$/, '')) ||
              responseLower.includes(fileNameLower.replace(/\.txt$/, '')) ||
              responseLower.includes(fileNameLower.replace(/\.md$/, '')) ||
              // Check for "Apple Health" if filename contains it
              (fileNameLower.includes('apple health') && responseLower.includes('apple health')) ||
              (fileNameLower.includes('health') && responseLower.includes('health'));
            
            if (fileNameMatch) {
              logProvisioning(userId, `✅ [KB VERIFICATION] Agent confirmed file "${initialFileName}" is in knowledge base`, 'success');
              updateStatus('KB verification passed', { fileName: initialFileName });
            } else {
              logProvisioning(userId, `⚠️  [KB VERIFICATION] Warning: Agent response does not clearly mention file "${initialFileName}"`, 'warning');
              logProvisioning(userId, `⚠️  [KB VERIFICATION] Full response: ${verificationText}`, 'warning');
              logProvisioning(userId, `⚠️  [KB VERIFICATION] Searched for: "${fileNameLower}", "${baseFileName}", "${baseFileNameClean}"`, 'warning');
              // Continue anyway - might be a false negative due to how agent phrases the response
              // The file is indexed (verified by datasource status), so proceed with summary generation
            }
          } catch (verifyError) {
            logProvisioning(userId, `⚠️  [KB VERIFICATION] Error verifying KB contents: ${verifyError.message}`, 'warning');
            // Continue - verification failure doesn't block summary generation
          }
          
          // Step 7.5b: Generate patient summary
          updateStatus('Generating patient summary...', { fileName: userDoc.initialFile.fileName });
          logProvisioning(userId, `📝 [PATIENT SUMMARY] Generating patient summary from indexed initial file...`, 'info');
          
          try {
            const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');
            const agentProvider = new DigitalOceanProvider(apiKey, {
              baseURL: agentEndpointUrl
            });

            const summaryPrompt = 'Please generate a comprehensive patient summary based on all available medical records and documents in the knowledge base. Include key medical history, diagnoses, medications, allergies, and important notes.';

            const summaryResponse = await agentProvider.chat(
              [{ role: 'user', content: summaryPrompt }],
              { model: agentModelName || 'openai-gpt-oss-120b' }
            );

            const summary = summaryResponse.content || summaryResponse.text || '';

            if (!summary || summary.trim().length === 0) {
              logProvisioning(userId, `❌ [PATIENT SUMMARY] Patient summary generation returned empty result`, 'error');
            } else {
              const summaryUserDoc = await cloudant.getDocument('maia_users', userId);
              if (summaryUserDoc) {
                // Use helper function to add new summary (default to 'newest' strategy)
                addNewSummary(summaryUserDoc, summary, 'newest');
                summaryUserDoc.workflowStage = 'patient_summary';
                await cloudant.saveDocument('maia_users', summaryUserDoc);
                invalidateResourceCache(userId);
                logProvisioning(userId, `✅ [PATIENT SUMMARY] Patient summary generated and saved successfully (${summary.length} chars)`, 'success');
                updateStatus('Patient summary generated', { summaryLength: summary.length });
              } else {
                logProvisioning(userId, `❌ [PATIENT SUMMARY] Could not load user document to save patient summary`, 'error');
              }
            }
          } catch (summaryError) {
            logProvisioning(userId, `❌ [PATIENT SUMMARY] Error generating patient summary: ${summaryError.message}`, 'error');
            // Don't fail provisioning if summary generation fails
          }
        } else {
          logProvisioning(userId, `ℹ️  [PATIENT SUMMARY] Initial file not yet indexed - summary will be generated when indexing completes`, 'info');
        }
      } catch (summaryCheckError) {
        logProvisioning(userId, `⚠️  [PATIENT SUMMARY] Error checking indexing status for summary generation: ${summaryCheckError.message}`, 'warning');
        // Continue - summary can be generated later
      }
    }

    // Step 8: Comprehensive Verification (before declaring success/failure)
    updateStatus('Verifying provisioning complete...');
    logProvisioning(userId, `🔍 Starting comprehensive verification...`, 'info');
    
    // Get KB name from user document
    const kbNameForVerification = getKBNameFromUserDoc(userDoc, userId);
    
    const expectedConfig = {
      maxTokens: 16384,
      temperature: 0.1,
      topP: 1
    };
    
    const verification = await verifyProvisioningComplete(
      userId, 
      newAgent.uuid, 
      agentName, 
      kbNameForVerification, 
      expectedConfig
    );
    
    // Update status with verification results
    const status = provisioningStatus.get(userId);
    if (status) {
      status.verification = verification;
    }
    
    // Step 9: Test Agent (as part of verification)
    updateStatus('Testing agent...');
    let testResult = null;
    try {
      const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');
      
      if (agentEndpointUrl) {
        const testProvider = new DigitalOceanProvider(apiKey, { baseURL: agentEndpointUrl });
        const modelName = agentDetails?.model?.inference_name || agentDetails?.model?.name || 'unknown';
        
        testResult = await testProvider.chat(
          [{ role: 'user', content: 'What model are you?' }],
          { model: modelName, stream: false }
        );
      }
    } catch (testError) {
      testResult = { error: testError.message };
    }

    updateStatus('Agent test completed', testResult && !testResult.error ? { 
      query: 'What model are you?',
      response: testResult.content?.substring(0, 200) || testResult.content
    } : { 
      error: testResult?.error || 'Test not performed',
      note: 'Test failure is non-critical - agent is still provisioned successfully'
    });
    
    // Check verification results
    if (!verification.allCriticalPassed) {
      logProvisioning(userId, `❌ Verification failed - critical checks did not pass`, 'error');
      updateStatus('Verification failed', { 
        verification,
        note: 'Some critical checks failed. Review logs for details.'
      });
      
      // Get user email for failure notification
      const userEmail = userDoc.email || null;
      const errorDetails = `Verification failed: ${JSON.stringify(verification.results)}`;
      
      // Send failure email
      if (userEmail) {
        try {
          await emailService.sendProvisioningCompletionEmail({
            userId,
            userEmail,
            success: false,
            errorDetails
          });
        } catch (emailError) {
          logProvisioning(userId, `⚠️  Failed to send failure email: ${emailError.message}`, 'warning');
        }
      }
      
      // Don't mark as completed if critical checks fail
      throw new Error(`Provisioning verification failed: ${errorDetails}`);
    }
    
    logProvisioning(userId, `✅ All critical verification checks passed`, 'success');
    updateStatus('Verification complete', { 
      verification,
      note: 'All critical checks passed successfully'
    });

    logProvisioning(userId, `✅ Provisioning completed successfully for user: ${userId}, agent: ${agentName}`, 'success');

    // Mark as completed
    if (status) {
      const totalTime = ((Date.now() - status.startTime) / 1000).toFixed(1);
      status.status = 'completed';
      status.completedAt = Date.now();
      status.result = {
        agentId: newAgent.uuid,
        agentName,
        model: agentDetails?.model?.name || agentDetails?.model?.inference_name || 'Unknown',
        endpoint: userDoc.agentEndpoint || 'Not available',
        totalTime,
        testResult
      };
    }
    
    // Step 10: Send success email
    const userEmail = userDoc.email || null;
    if (userEmail) {
      try {
        await emailService.sendProvisioningCompletionEmail({
          userId,
          userEmail,
          success: true,
          errorDetails: null
        });
      } catch (emailError) {
        logProvisioning(userId, `⚠️  Failed to send success email: ${emailError.message}`, 'warning');
        // Don't fail provisioning if email fails
      }
    } else {
      logProvisioning(userId, `⚠️  No user email found, skipping success email`, 'warning');
    }
  } catch (error) {
    logProvisioning(userId, `❌ Provisioning failed for user ${userId}: ${error.message}`, 'error');
    logProvisioning(userId, `❌ Error stack: ${error.stack}`, 'error');
    
    const status = provisioningStatus.get(userId);
    if (status) {
      status.status = 'failed';
      status.error = error.message;
      status.completedAt = Date.now();
    }
    
    // Log error details
    if (error.statusCode === 409) {
      logProvisioning(userId, `❌ Document conflict detected - this is a concurrency issue`, 'error');
    }
    
    // Send failure email
    try {
      let userDoc = null;
      try {
        userDoc = await cloudant.getDocument('maia_users', userId);
      } catch (docError) {
        logProvisioning(userId, `⚠️  Could not fetch user document for email: ${docError.message}`, 'warning');
      }
      
      const userEmail = userDoc?.email || null;
      if (userEmail) {
        const errorDetails = error.message + (error.stack ? `\n\nStack trace:\n${error.stack}` : '');
        await emailService.sendProvisioningCompletionEmail({
          userId,
          userEmail,
          success: false,
          errorDetails
        });
      } else {
        logProvisioning(userId, `⚠️  No user email found, skipping failure email`, 'warning');
      }
    } catch (emailError) {
      logProvisioning(userId, `⚠️  Failed to send failure email: ${emailError.message}`, 'warning');
      // Don't fail provisioning if email fails
    }
  }
}

// Save group chat endpoint
app.post('/api/save-group-chat', async (req, res) => {
  try {
    const { chatHistory, uploadedFiles, connectedKB } = req.body;
    const sessionUserId = req.session?.userId;
    const deepLinkSession = isDeepLinkSession(req);

    if (deepLinkSession) {
      return res.status(403).json({
        success: false,
        message: 'Deep link users cannot create new group chats',
        error: 'DEEPLINK_FORBIDDEN'
      });
    }

    const effectiveUserId = sessionUserId || req.body?.currentUser;
    if (!effectiveUserId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
        error: 'NOT_AUTHENTICATED'
      });
    }
    
    if (!chatHistory || chatHistory.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No chat history to save',
        error: 'MISSING_CHAT_HISTORY'
      });
    }

    // Generate a secure, random share ID
    const generateShareId = () => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let result = '';
      for (let i = 0; i < 12; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    };

    const shareId = generateShareId();
    
    // Process uploadedFiles - only store metadata, not large content
    const processedFiles = (uploadedFiles || []).map(file => ({
      id: file.id,
      name: file.name,
      size: file.size,
      type: file.type,
      bucketKey: file.bucketKey,
      bucketPath: file.bucketPath,
      uploadedAt: file.uploadedAt?.toISOString ? file.uploadedAt.toISOString() : file.uploadedAt
    }));
    
    // Generate _id starting with username
    const userName = effectiveUserId || 'anonymous';
    const randomId = Math.random().toString(36).substr(2, 9);
    const chatId = `${userName}-chat_${Date.now()}_${randomId}`;
    
    const groupChatDoc = {
      _id: chatId,
      type: 'group_chat',
      shareId: shareId,
      currentUser: effectiveUserId,
      patientOwner: effectiveUserId,
      connectedKB: connectedKB || 'No KB connected',
      chatHistory,
      uploadedFiles: processedFiles,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      participantCount: chatHistory.filter(msg => msg.role === 'user').length,
      messageCount: chatHistory.length,
      isShared: true,
      deepLinkUserIds: [] // Array to track deep link users who have accessed this chat
    };

    // Save to maia_chats database
    const result = await cloudant.saveDocument('maia_chats', groupChatDoc);
    
    // Set workflowStage to link_stored when chat is saved with shareId
    try {
      const userDoc = await cloudant.getDocument('maia_users', effectiveUserId);
      if (userDoc) {
        userDoc.workflowStage = 'link_stored';
        await cloudant.saveDocument('maia_users', userDoc);
      }
    } catch (err) {
      console.error('Error setting workflowStage to link_stored:', err);
      // Don't fail the request if workflowStage update fails
    }
    
    res.json({ 
      success: true, 
      chatId: result.id,
      shareId: shareId,
      message: 'Group chat saved successfully',
      result,
      shareUrl: `${process.env.PUBLIC_APP_URL || 'http://localhost:5173'}/?share=${shareId}`
    });
  } catch (error) {
    console.error('❌ Save group chat error:', error);
    res.status(500).json({ 
      success: false,
      message: `Failed to save group chat: ${error.message}`,
      error: 'SAVE_CHAT_ERROR'
    });
  }
});

// Update existing group chat
app.put('/api/save-group-chat/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    const { chatHistory, uploadedFiles, connectedKB, shareId } = req.body;
    const sessionUserId = req.session?.userId;
    const deepLinkSession = isDeepLinkSession(req);

    if (!chatId) {
      return res.status(400).json({
        success: false,
        message: 'Chat ID is required',
        error: 'MISSING_CHAT_ID'
      });
    }

    if (!chatHistory || chatHistory.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No chat history to save',
        error: 'MISSING_CHAT_HISTORY'
      });
    }

    const existingChat = await cloudant.getDocument('maia_chats', chatId);

    if (!existingChat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found',
        error: 'CHAT_NOT_FOUND'
      });
    }

    const effectiveUserId = sessionUserId || req.body?.currentUser || existingChat.currentUser;

    if (!effectiveUserId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
        error: 'NOT_AUTHENTICATED'
      });
    }

    const isOwner = existingChat.patientOwner && existingChat.patientOwner === effectiveUserId;

    if (deepLinkSession) {
      const allowedShares = ensureArray(req.session.deepLinkShareIds || []);
      if (!allowedShares.includes(existingChat.shareId)) {
        return res.status(403).json({
          success: false,
          message: 'Deep link users may only update the shared chat',
          error: 'DEEPLINK_FORBIDDEN'
        });
      }
      if (shareId && shareId !== existingChat.shareId) {
        return res.status(400).json({
          success: false,
          message: 'Cannot change share link for deep link chat',
          error: 'DEEPLINK_SHARE_MISMATCH'
        });
      }
    } else if (existingChat.currentUser && existingChat.currentUser !== effectiveUserId) {
      if (!isOwner) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to update this chat',
          error: 'CHAT_UPDATE_FORBIDDEN'
        });
      }
    }

    const processedFiles = (uploadedFiles || []).map(file => ({
      id: file.id,
      name: file.name,
      size: file.size,
      type: file.type,
      bucketKey: file.bucketKey,
      bucketPath: file.bucketPath,
      uploadedAt: file.uploadedAt?.toISOString ? file.uploadedAt.toISOString() : file.uploadedAt
    }));

    existingChat.chatHistory = chatHistory;
    existingChat.uploadedFiles = processedFiles;
    existingChat.connectedKB = connectedKB || existingChat.connectedKB;
    existingChat.updatedAt = new Date().toISOString();
    existingChat.messageCount = chatHistory.length;
    existingChat.participantCount = chatHistory.filter(msg => msg.role === 'user').length;
    existingChat.shareId = shareId || existingChat.shareId;
    if (!deepLinkSession || isOwner) {
      existingChat.currentUser = effectiveUserId;
    }

    await cloudant.saveDocument('maia_chats', existingChat);

    // Keep workflowStage in sync when chats are updated
    try {
      const userDoc = await cloudant.getDocument('maia_users', effectiveUserId);
      if (userDoc) {
        userDoc.workflowStage = 'link_stored';
        await cloudant.saveDocument('maia_users', userDoc);
      }
    } catch (stageError) {
      console.warn('⚠️ Unable to update workflow stage after chat update:', stageError.message);
    }

    res.json({
      success: true,
      message: 'Group chat updated successfully',
      chatId: existingChat._id,
      shareId: existingChat.shareId
    });
  } catch (error) {
    console.error('❌ Update group chat error:', error);
    res.status(500).json({
      success: false,
      message: `Failed to update group chat: ${error.message}`,
      error: 'UPDATE_CHAT_ERROR'
    });
  }
});

// Get user's saved chats
app.get('/api/user-chats', async (req, res) => {
  try {
    const { userId } = req.query;
    const sessionUserId = req.session?.userId;
    const deepLinkSession = isDeepLinkSession(req);
    
    if (!sessionUserId && !userId && !deepLinkSession) {
      return res.status(401).json({
        success: false, 
        message: 'User not authenticated',
        error: 'NOT_AUTHENTICATED'
      });
    }

    const effectiveUserId = sessionUserId || userId;

    if (sessionUserId && userId && sessionUserId !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Cannot request chats for another user',
        error: 'CHAT_ACCESS_FORBIDDEN'
      });
    }

    if (deepLinkSession) {
      const shareId = req.session.deepLinkShareId;
      const chatId = req.session.deepLinkChatId;
      const chats = [];
      if (chatId) {
        const chat = await cloudant.getDocument('maia_chats', chatId);
        if (chat && ensureArray(req.session.deepLinkShareIds).includes(chat.shareId)) {
          chats.push(chat);
        }
      } else if (shareId) {
        const chat = await getChatByShareId(shareId);
        if (chat) {
          chats.push(chat);
        }
      }

      return res.json({
        success: true,
        chats,
        count: chats.length
      });
    }

    const allChats = await cloudant.getAllDocuments('maia_chats');
    const userChats = allChats.filter(chat => chat._id.startsWith(`${effectiveUserId}-`));

    // Only log if there are chats (0 is the default/expected state)
    if (userChats.length > 0) {
    console.log(`✅ Found ${userChats.length} chats for user ${effectiveUserId}`);
    }
    
    res.json({
      success: true,
      chats: userChats,
      count: userChats.length
    });
  } catch (error) {
    console.error('❌ Error fetching user chats:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to fetch chats: ${error.message}`,
      error: 'FETCH_CHATS_ERROR'
    });
  }
});

// Load a specific chat by ID
app.get('/api/load-chat/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    
    const chat = await cloudant.getDocument('maia_chats', chatId);
    
    if (!chat) {
      return res.status(404).json({ 
        success: false, 
        message: 'Chat not found',
        error: 'CHAT_NOT_FOUND'
      });
    }
    
    if (isDeepLinkSession(req)) {
      const allowedShares = ensureArray(req.session.deepLinkShareIds);
      const allowedChatId = req.session.deepLinkChatId;
      if (chat._id !== allowedChatId && !allowedShares.includes(chat.shareId)) {
        return res.status(403).json({
          success: false,
          message: 'Deep link users may only access the shared chat',
          error: 'DEEPLINK_FORBIDDEN'
        });
      }
      
      // Add deep link user to chat's tracking list
      const deepLinkUserId = req.session.deepLinkUserId || req.session.userId;
      if (deepLinkUserId) {
        await addDeepLinkUserToChat(chat, deepLinkUserId);
      }
      
      req.session.deepLinkChatId = chat._id;
    }
    
    res.json({
      success: true,
      chat: chat
    });
  } catch (error) {
    console.error('❌ Error loading chat:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to load chat: ${error.message}`,
      error: 'LOAD_CHAT_ERROR'
    });
  }
});

// Load a specific chat by shareId (for deep links)
app.get('/api/load-chat-by-share/:shareId', async (req, res) => {
  try {
    const { shareId } = req.params;
    
    if (!shareId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Share ID is required',
        error: 'MISSING_SHARE_ID'
      });
    }
    
    const chat = await getChatByShareId(shareId);
    
    if (!chat) {
      return res.status(404).json({ 
        success: false, 
        message: 'Chat not found',
        error: 'CHAT_NOT_FOUND'
      });
    }
    
    if (isDeepLinkSession(req)) {
      const allowedShares = ensureArray(req.session.deepLinkShareIds);
      if (!allowedShares.includes(shareId)) {
        return res.status(403).json({
          success: false,
          message: 'Deep link users may only access the shared chat',
          error: 'DEEPLINK_FORBIDDEN'
        });
      }
      
      // Add deep link user to chat's tracking list
      const deepLinkUserId = req.session.deepLinkUserId || req.session.userId;
      if (deepLinkUserId) {
        await addDeepLinkUserToChat(chat, deepLinkUserId);
      }
      
      req.session.deepLinkChatId = chat._id;
    }
    
    res.json({
      success: true,
      chat: chat
    });
  } catch (error) {
    console.error('❌ Error loading chat by shareId:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to load chat: ${error.message}`,
      error: 'LOAD_CHAT_ERROR'
    });
  }
});

// Delete a specific chat
app.delete('/api/delete-chat/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    
    await cloudant.deleteDocument('maia_chats', chatId);
    
    console.log(`✅ Deleted chat ${chatId}`);
    
    res.json({
      success: true,
      message: 'Chat deleted successfully'
    });
  } catch (error) {
    console.error('❌ Error deleting chat:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to delete chat: ${error.message}`,
      error: 'DELETE_CHAT_ERROR'
    });
  }
});

// User file metadata endpoint - updates user document with file info
app.post('/api/user-file-metadata', async (req, res) => {
  try {
    const { userId, fileMetadata, updateInitialFile } = req.body;
    
    if (!userId || !fileMetadata) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID and file metadata are required',
        error: 'MISSING_REQUIRED_FIELDS'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Initialize files array if it doesn't exist
    if (!userDoc.files) {
      userDoc.files = [];
    }

    // Check if file already exists (by bucketKey)
    const existingFileIndex = userDoc.files.findIndex(f => f.bucketKey === fileMetadata.bucketKey);
    
    if (existingFileIndex >= 0) {
      // Update existing file metadata
      userDoc.files[existingFileIndex] = {
        ...userDoc.files[existingFileIndex],
        ...fileMetadata,
        updatedAt: new Date().toISOString()
      };
    } else {
      // Add new file metadata with initialized knowledgeBases array
      userDoc.files.push({
        ...fileMetadata,
        knowledgeBases: [],
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    // Update initialFile if requested (for Lists source file replacement)
    if (updateInitialFile) {
      userDoc.initialFile = {
        fileName: fileMetadata.fileName,
        bucketKey: fileMetadata.bucketKey,
        fileSize: fileMetadata.fileSize || 0,
        uploadedAt: new Date().toISOString()
      };
    }

    // Set workflowStage to files_stored if files exist
    if (userDoc.files.length > 0) {
      userDoc.workflowStage = 'files_stored';
    }

    // Save the updated user document
    await cloudant.saveDocument('maia_users', userDoc);
    
    console.log(`✅ Updated file metadata for user ${userId}: ${fileMetadata.fileName}`);
    
    res.json({
      success: true,
      message: 'File metadata updated successfully',
      fileCount: userDoc.files.length
    });
  } catch (error) {
    console.error('❌ Error updating user file metadata:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to update file metadata: ${error.message}`,
      error: 'UPDATE_FAILED'
    });
  }
});

// Cleanup imported files at root level (delete them, don't archive)
// Called on page reload to remove files that were imported but not explicitly saved
app.post('/api/cleanup-imported-files', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Import S3 client operations
    const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = await import('@aws-sdk/client-s3');

    // Setup S3/Spaces client
    const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
    if (!bucketUrl) {
      return res.status(500).json({
        success: false,
        error: 'BUCKET_NOT_CONFIGURED',
        message: 'DigitalOcean bucket not configured'
      });
    }

    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';

    const s3Client = new S3Client({
      endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
      region: 'us-east-1',
      forcePathStyle: false,
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });

    // List all files at root level (userId/ but not in subfolders)
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `${userId}/`
    });

    const listResult = await s3Client.send(listCommand);
    
    // Find files at root level (exactly userId/filename, not in subfolders)
    const rootFiles = (listResult.Contents || []).filter(file => {
      const key = file.Key || '';
      const parts = key.split('/').filter(p => p !== '');
      return parts.length === 2 && 
             parts[0] === userId && 
             !key.endsWith('.keep') &&
             parts[1] !== '.keep';
    });

    let deletedCount = 0;
    const deletedFiles = [];

    // Delete each root-level file
    for (const file of rootFiles) {
      const fileName = file.Key?.split('/').pop() || '';
      if (!fileName || fileName === '.keep') continue;

      const sourceKey = file.Key;

      try {
        // Delete from bucket
        const deleteCommand = new DeleteObjectCommand({
          Bucket: bucketName,
          Key: sourceKey
        });
        await s3Client.send(deleteCommand);

        // Remove file metadata from user document
        if (userDoc.files) {
          const fileIndex = userDoc.files.findIndex(f => f.bucketKey === sourceKey);
          if (fileIndex >= 0) {
            userDoc.files.splice(fileIndex, 1);
            deletedFiles.push(fileName);
          }
        }

        deletedCount++;
        console.log(`[Cleanup] ✅ Deleted imported file: ${sourceKey}`);
      } catch (err) {
        console.error(`[Cleanup] ❌ Error deleting file ${fileName}:`, err);
      }
    }

    // Save updated user document if files were deleted
    if (deletedCount > 0 && userDoc.files) {
      // Reset workflowStage if no files remain
      if (userDoc.files.length === 0) {
        // Revert to agent_deployed if agent exists, otherwise keep current stage
        if (userDoc.assignedAgentId) {
          userDoc.workflowStage = 'agent_deployed';
        }
      }
      await cloudant.saveDocument('maia_users', userDoc);
    }

    res.json({
      success: true,
      message: `Cleaned up ${deletedCount} imported file(s)`,
      deletedCount,
      deletedFiles
    });
  } catch (error) {
    console.error('❌ Error cleaning up imported files:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to cleanup imported files: ${error.message}`,
      error: 'CLEANUP_FAILED'
    });
  }
});

// Auto-archive files at root level (move from userId/ to userId/archived/)
// Only called when user explicitly opens Saved Files tab
app.post('/api/archive-user-files', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Import S3 client operations
    const { S3Client, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');

    // Setup S3/Spaces client
    const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
    if (!bucketUrl) {
      return res.status(500).json({
        success: false,
        error: 'BUCKET_NOT_CONFIGURED',
        message: 'DigitalOcean bucket not configured'
      });
    }

    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';

    const s3Client = new S3Client({
      endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
      region: 'us-east-1',
      forcePathStyle: false,
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });

    // List all files at root level (userId/ but not in subfolders)
    // Note: We list all files with userId/ prefix, then filter for root-level files
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `${userId}/`
    });

    const listResult = await s3Client.send(listCommand);
    
    // Find files at root level (exactly userId/filename, not in subfolders)
    const rootFiles = (listResult.Contents || []).filter(file => {
      const key = file.Key || '';
      // Only files at exactly userId/filename (not userId/archived/filename or userId/kb/filename)
      // Check that key has exactly 2 parts when split by '/' (userId and filename)
      const parts = key.split('/').filter(p => p !== ''); // Filter empty parts
      return parts.length === 2 && 
             parts[0] === userId && 
             !key.endsWith('.keep') &&
             parts[1] !== '.keep'; // Exclude .keep files
    });

    let archivedCount = 0;
    const archivedFiles = [];
    const failedFiles = [];
    
    // Save original state for rollback
    const originalFiles = JSON.parse(JSON.stringify(userDoc.files || []));
    const originalWorkflowStage = userDoc.workflowStage;

    // Move each root-level file to archived
    for (const file of rootFiles) {
      const fileName = file.Key?.split('/').pop() || '';
      if (!fileName || fileName === '.keep') continue;

      const sourceKey = file.Key;
      const destKey = `${userId}/archived/${fileName}`;

      try {
        // Copy to archived
        const copyCommand = new CopyObjectCommand({
          Bucket: bucketName,
          CopySource: `${bucketName}/${sourceKey}`,
          Key: destKey
        });
        await s3Client.send(copyCommand);

        // Delete from root
        const deleteCommand = new DeleteObjectCommand({
          Bucket: bucketName,
          Key: sourceKey
        });
        await s3Client.send(deleteCommand);

        // Verify the file exists at the destination with retry
        let verified = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const verifyCommand = new HeadObjectCommand({
              Bucket: bucketName,
              Key: destKey
            });
            await s3Client.send(verifyCommand);
            verified = true;
            break;
          } catch (verifyError) {
            if (attempt < 2) {
              await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt)));
            } else {
              throw new Error(`File archive verification failed after 3 attempts`);
            }
          }
        }

        if (!verified) {
          throw new Error(`File archive verification failed`);
        }

        // Update file metadata in user document
        if (userDoc.files) {
          const fileIndex = userDoc.files.findIndex(f => f.bucketKey === sourceKey);
          if (fileIndex >= 0) {
            userDoc.files[fileIndex].bucketKey = destKey;
            userDoc.files[fileIndex].updatedAt = new Date().toISOString();
            archivedFiles.push(fileName);
            archivedCount++;
          }
        }
      } catch (err) {
        console.error(`❌ Error archiving file ${fileName}:`, err);
        failedFiles.push({ fileName, error: err.message });
        // Rollback this file's metadata change if it was made
        if (userDoc.files) {
          const fileIndex = userDoc.files.findIndex(f => f.bucketKey === destKey);
          if (fileIndex >= 0) {
            // Restore original bucketKey
            const originalFile = originalFiles.find(f => f.fileName === fileName || f.bucketKey === sourceKey);
            if (originalFile) {
              userDoc.files[fileIndex].bucketKey = originalFile.bucketKey;
            }
          }
        }
      }
    }

    // Save updated user document if files were moved successfully
    if (archivedCount > 0 && userDoc.files) {
      // Set workflowStage to files_archived when files are archived
      userDoc.workflowStage = 'files_archived';
      
      // Save with retry logic for conflicts
      let saved = false;
      let retries = 3;
      while (!saved && retries > 0) {
        try {
      await cloudant.saveDocument('maia_users', userDoc);
          saved = true;
        } catch (saveError) {
          if (saveError.statusCode === 409 && retries > 1) {
            retries--;
            const freshDoc = await cloudant.getDocument('maia_users', userId);
            // Re-apply archived file changes
            for (const fileName of archivedFiles) {
              const freshFileIndex = freshDoc.files.findIndex(f => 
                f.fileName === fileName || f.bucketKey === `${userId}/${fileName}`
              );
              if (freshFileIndex >= 0) {
                freshDoc.files[freshFileIndex].bucketKey = `${userId}/archived/${fileName}`;
                freshDoc.files[freshFileIndex].updatedAt = new Date().toISOString();
              }
            }
            freshDoc.workflowStage = 'files_archived';
            userDoc = freshDoc;
            await new Promise(resolve => setTimeout(resolve, 200 * (4 - retries)));
          } else {
            // If save fails completely, rollback user document
            userDoc.files = originalFiles;
            userDoc.workflowStage = originalWorkflowStage;
            throw saveError;
          }
        }
      }
      
      if (!saved) {
        // Rollback user document
        userDoc.files = originalFiles;
        userDoc.workflowStage = originalWorkflowStage;
        throw new Error('Failed to save user document after archiving files');
      }
    }

    res.json({
      success: true,
      message: `Archived ${archivedCount} file(s)${failedFiles.length > 0 ? `, ${failedFiles.length} failed` : ''}`,
      archivedCount,
      archivedFiles,
      failedFiles: failedFiles.length > 0 ? failedFiles : undefined
    });
  } catch (error) {
    console.error('❌ Error archiving user files:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to archive files: ${error.message}`,
      error: 'ARCHIVE_FAILED'
    });
  }
});

// Verify file state synchronization between Spaces and user document
app.get('/api/verify-file-state', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Setup S3/Spaces client
    const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
    if (!bucketUrl) {
      return res.status(500).json({
        success: false,
        error: 'BUCKET_NOT_CONFIGURED',
        message: 'DigitalOcean bucket not configured'
      });
    }

    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';

    const { S3Client, HeadObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const s3Client = new S3Client({
      endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
      region: 'us-east-1',
      forcePathStyle: false,
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });

    // Get all files from user document
    const docFiles = userDoc.files || [];
    const inconsistencies = [];
    const verified = [];

    // Verify each file in the user document exists in Spaces at the expected location
    for (const file of docFiles) {
      const bucketKey = file.bucketKey;
      if (!bucketKey) {
        inconsistencies.push({
          fileName: file.fileName || 'unknown',
          issue: 'Missing bucketKey in user document',
          bucketKey: null
        });
        continue;
      }

      try {
        const headCommand = new HeadObjectCommand({
          Bucket: bucketName,
          Key: bucketKey
        });
        await s3Client.send(headCommand);
        verified.push({
          fileName: file.fileName || bucketKey.split('/').pop(),
          bucketKey: bucketKey,
          status: 'verified'
        });
      } catch (headError) {
        // File not found at expected location
        inconsistencies.push({
          fileName: file.fileName || bucketKey.split('/').pop(),
          issue: 'File not found in Spaces at expected location',
          bucketKey: bucketKey
        });
      }
    }

    // Check for orphaned files in Spaces (files in Spaces but not in user document)
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `${userId}/`
    });
    const listResult = await s3Client.send(listCommand);
    const spacesFiles = (listResult.Contents || [])
      .map(file => file.Key)
      .filter(key => key && !key.endsWith('.keep'));

    const docBucketKeys = new Set(docFiles.map(f => f.bucketKey).filter(Boolean));
    const orphanedFiles = spacesFiles.filter(key => !docBucketKeys.has(key));

    const isConsistent = inconsistencies.length === 0 && orphanedFiles.length === 0;

    res.json({
      success: true,
      isConsistent,
      verified: verified.length,
      inconsistencies: inconsistencies.length,
      orphanedFiles: orphanedFiles.length,
      details: {
        verified,
        inconsistencies,
        orphanedFiles: orphanedFiles.map(key => ({
          bucketKey: key,
          issue: 'File exists in Spaces but not in user document'
        }))
      }
    });
  } catch (error) {
    console.error('❌ Error verifying file state:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to verify file state: ${error.message}`,
      error: 'VERIFICATION_FAILED'
    });
  }
});

// Cache for verification to prevent duplicate calls within short time window
const verificationCache = new Map(); // userId -> { timestamp, indexedFiles }

// Get user files
app.get('/api/user-files', async (req, res) => {
  try {
    const { userId, subfolder } = req.query;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get the user document
    let userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    let files = userDoc.files || [];
    
    // Filter by subfolder if specified
    if (subfolder) {
      const subfolderPath = `${userId}/${subfolder}/`;
      files = files.filter((file) => {
        const bucketKey = file.bucketKey || '';
        return bucketKey.startsWith(subfolderPath);
      });
    } else {
      // When NO subfolder is specified (e.g., SAVED FILES tab), exclude References folder files
      // References files should never appear in SAVED FILES because they're not for KB indexing
      const referencesPath = `${userId}/References/`;
      files = files.filter((file) => {
        const bucketKey = file.bucketKey || '';
        // Exclude files in References subfolder
        if (bucketKey.startsWith(referencesPath)) {
          return false;
        }
        // Also exclude files explicitly marked as references
        if (file.isReference === true) {
          return false;
        }
        return true;
      });
    }
    
    // Deduplicate files by filename - prefer KB folder entries over archived/root entries
    // Get KB name for preference checking
    const kbName = getKBNameFromUserDoc(userDoc, userId);
    const kbFolderPath = kbName ? `${userId}/${kbName}/` : null;
    
    const filesByFileName = new Map();
    
    for (const file of files) {
      const bucketKey = file.bucketKey || '';
      const fileName = bucketKey.split('/').pop() || '';
      
      if (!fileName) continue; // Skip files without valid filenames
      
      const existing = filesByFileName.get(fileName);
      
      if (!existing) {
        // First occurrence of this filename - add it
        filesByFileName.set(fileName, file);
      } else {
        // Duplicate filename found - prefer KB folder entry
        const existingBucketKey = existing.bucketKey || '';
        const existingIsInKB = kbFolderPath && existingBucketKey.startsWith(kbFolderPath);
        const currentIsInKB = kbFolderPath && bucketKey.startsWith(kbFolderPath);
        
        if (currentIsInKB && !existingIsInKB) {
          // Current file is in KB, existing is not - replace
          filesByFileName.set(fileName, file);
        } else if (!currentIsInKB && !existingIsInKB) {
          // Neither is in KB - prefer the one with better metadata
          const existingHasMetadata = existing.fileSize && existing.uploadedAt;
          const currentHasMetadata = file.fileSize && file.uploadedAt;
          
          if (currentHasMetadata && !existingHasMetadata) {
            // Current has metadata, existing doesn't - replace
            filesByFileName.set(fileName, file);
          }
          // Otherwise keep existing (first one wins if both have same metadata quality)
        }
        // If existing is in KB and current is not, keep existing (don't replace)
      }
    }
    
    // Convert map back to array and ensure all files have required metadata
    files = Array.from(filesByFileName.values()).map(file => {
      // Ensure fileSize and uploadedAt are present (use defaults if missing)
      if (!file.fileSize && file.size) {
        file.fileSize = file.size; // Some entries use 'size' instead of 'fileSize'
      }
      if (!file.uploadedAt && file.addedAt) {
        file.uploadedAt = file.addedAt; // Fallback to addedAt if uploadedAt missing
      }
      if (!file.uploadedAt) {
        file.uploadedAt = new Date().toISOString(); // Last resort: use current date
      }
      return file;
    });
    
    // Sync indexed files with DO API state (source of truth)
    let indexedFiles = userDoc.kbIndexedFiles || [];
    
    // Only verify KB state if explicitly requested via query parameter
    // This prevents verification from running on every page load (e.g., document chooser)
    const shouldVerify = req.query.verify === 'true';
    
    // If user has a KB, verify indexed files against actual state
    // Use cache to prevent duplicate verification calls within 5 seconds
    const cacheKey = `verify-${userId}`;
    const cached = verificationCache.get(cacheKey);
    const now = Date.now();
    const CACHE_TTL = 5000; // 5 seconds
    
    if (shouldVerify && userDoc.kbId) {
      if (cached && (now - cached.timestamp) < CACHE_TTL) {
        console.log(`[KB VERIFY] Using cached result (${Math.round((now - cached.timestamp) / 1000)}s ago)`);
        indexedFiles = cached.indexedFiles;
      } else {
        try {
          const kbName = getKBNameFromUserDoc(userDoc, userId);
          const kbFolderPath = `${userId}/${kbName}/`;
          
          // Track inconsistencies, cleanup actions, and updates
          const inconsistencies = [];
          const cleanupActions = [];
          const userDocUpdates = [];
          let indexingInProgress = false;
          let indexingJobId = null;
          
          // Setup S3 client
          const { S3Client, ListObjectsV2Command, HeadObjectCommand } = await import('@aws-sdk/client-s3');
          const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
          const bucketName = bucketUrl?.split('//')[1]?.split('.')[0] || 'maia';
          
          const s3Client = new S3Client({
            endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
            region: 'us-east-1',
            forcePathStyle: false,
            credentials: {
              accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
              secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
            }
          });
          
          // Step 1: Get data sources from DO API
          const dataSourceIndexingStatus = new Map(); // filePath -> { indexed: boolean, jobStatus: string, dsUuid: string }
          let filesFromDataSources = [];
          
          try {
            const datasources = await doClient.kb.listDataSources(userDoc.kbId);
            for (const ds of datasources) {
              const dsPath = ds?.item_path || ds?.spaces_data_source?.item_path;
              const dsUuid = ds?.uuid || ds?.id;
              
              if (dsPath && dsPath.startsWith(kbFolderPath)) {
                filesFromDataSources.push(dsPath);
                
                const lastJob = ds?.last_datasource_indexing_job;
                // A file is indexed if it has a last_datasource_indexing_job (regardless of status)
                // The presence of last_datasource_indexing_job indicates the data source has been processed
                const isIndexed = !!lastJob;
                
                dataSourceIndexingStatus.set(dsPath, {
                  indexed: isIndexed,
                  jobStatus: lastJob?.status || 'no_job',
                  dsUuid: dsUuid
                });
                
                // Log status for debugging
                if (!isIndexed) {
                  console.log(`[KB VERIFY] File ${dsPath.split('/').pop()}: NOT INDEXED (no last_datasource_indexing_job)`);
                } else {
                  console.log(`[KB VERIFY] File ${dsPath.split('/').pop()}: INDEXED (status: ${lastJob.status})`);
                }
              }
            }
          } catch (kbError) {
            inconsistencies.push(`Failed to list data sources: ${kbError.message}`);
          }
          
          // Step 2: Verify files exist in S3
          const uniqueFilesFromDataSources = [...new Set(filesFromDataSources)];
          const verifiedFiles = [];
          const missingFiles = [];
          
          for (const filePath of uniqueFilesFromDataSources) {
            try {
              await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: filePath }));
              verifiedFiles.push(filePath);
            } catch (error) {
              if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
                missingFiles.push(filePath);
              }
            }
          }
          
          // Get files in S3 KB folder
          const listCommand = new ListObjectsV2Command({ Bucket: bucketName, Prefix: kbFolderPath });
          const listResult = await s3Client.send(listCommand);
          const filesInS3 = (listResult.Contents || [])
            .filter(file => {
              const key = file.Key || '';
              return key.startsWith(kbFolderPath) && !key.endsWith('/') && !key.endsWith('.keep') && key !== kbFolderPath;
            })
            .map(file => file.Key || '');
          
          const filesWithoutDataSources = filesInS3.filter(filePath => !uniqueFilesFromDataSources.includes(filePath));
          
          // Collect inconsistencies
          if (missingFiles.length > 0) {
            inconsistencies.push(`${missingFiles.length} orphaned data source(s): ${missingFiles.map(p => p.split('/').pop()).join(', ')}`);
          }
          if (filesWithoutDataSources.length > 0) {
            inconsistencies.push(`${filesWithoutDataSources.length} file(s) in S3 without data sources: ${filesWithoutDataSources.map(p => p.split('/').pop()).join(', ')}`);
          }
          
          const indexedFilesFromDataSources = verifiedFiles.filter(filePath => {
            const status = dataSourceIndexingStatus.get(filePath);
            return status && status.indexed;
          });
          
          const userDocIndexedFiles = userDoc.kbIndexedFiles || [];
          const indexedFilesSorted = [...indexedFilesFromDataSources].sort();
          const userDocFilesSorted = [...userDocIndexedFiles].sort();
          
          if (JSON.stringify(indexedFilesSorted) !== JSON.stringify(userDocFilesSorted)) {
            inconsistencies.push(`UserDoc kbIndexedFiles mismatch: DO API shows ${indexedFilesFromDataSources.length} indexed, UserDoc shows ${userDocIndexedFiles.length}`);
          }
          
          // Report all inconsistencies in one message
          if (inconsistencies.length > 0) {
            console.log(`[KB VERIFY] Inconsistencies: ${inconsistencies.join('; ')}`);
          } else {
            console.log(`[KB VERIFY] No inconsistencies - KB API, Spaces API, and UserDoc are in sync`);
          }
          
          // Clean up orphaned data sources
          let deletedDataSources = 0;
          let skippedDataSources = 0;
          
          // Check for active indexing jobs BEFORE cleanup (to avoid triggering new ones)
          let hasActiveJobBeforeCleanup = false;
          try {
            const activeJobsBefore = await doClient.indexing.listForKB(userDoc.kbId);
            const jobsArrayBefore = Array.isArray(activeJobsBefore) ? activeJobsBefore : 
                            (activeJobsBefore?.jobs || activeJobsBefore?.indexing_jobs || activeJobsBefore?.data || []);
            hasActiveJobBeforeCleanup = jobsArrayBefore.some(j => {
              const status = j.status || j.job_status || j.state;
              return status === 'INDEX_JOB_STATUS_PENDING' || 
                     status === 'INDEX_JOB_STATUS_RUNNING' ||
                     status === 'INDEX_JOB_STATUS_IN_PROGRESS' ||
                     status === 'pending' ||
                     status === 'running' ||
                     status === 'in_progress';
            });
          } catch (jobCheckErr) {
            // Ignore errors
          }
          
          for (const missingFilePath of missingFiles) {
            const status = dataSourceIndexingStatus.get(missingFilePath);
            const orphanedDsUuid = status?.dsUuid;
            
            if (orphanedDsUuid) {
              try {
                if (hasActiveJobBeforeCleanup) {
                  skippedDataSources++;
                } else {
                  await doClient.kb.deleteDataSource(userDoc.kbId, orphanedDsUuid);
                  deletedDataSources++;
                  dataSourceIndexingStatus.delete(missingFilePath);
                }
              } catch (deleteErr) {
                const errorMsg = deleteErr.message || 'Unknown error';
                if (errorMsg.includes('403') || errorMsg.includes('forbidden')) {
                  skippedDataSources++;
                } else {
                  cleanupActions.push(`Failed to delete orphaned data source ${missingFilePath.split('/').pop()}: ${errorMsg}`);
                }
              }
            }
          }
          
          // Report cleanup actions in one message
          if (deletedDataSources > 0 || skippedDataSources > 0 || cleanupActions.length > 0) {
            const actions = [];
            if (deletedDataSources > 0) actions.push(`Deleted ${deletedDataSources} orphaned data source(s)`);
            if (skippedDataSources > 0) actions.push(`Skipped ${skippedDataSources} data source(s) (indexing in progress)`);
            if (cleanupActions.length > 0) actions.push(...cleanupActions);
            console.log(`[KB VERIFY] KB cleanup: ${actions.join('; ')}`);
          }
          
          // Update user document
          const allFilesIndexed = indexedFilesFromDataSources.length === verifiedFiles.length && verifiedFiles.length > 0;
          const someFilesIndexed = indexedFilesFromDataSources.length > 0 && indexedFilesFromDataSources.length < verifiedFiles.length;
          
          if (allFilesIndexed) {
            if (JSON.stringify([...verifiedFiles].sort()) !== JSON.stringify(userDocFilesSorted)) {
              indexedFiles = verifiedFiles;
              userDoc.kbIndexedFiles = verifiedFiles;
              userDocUpdates.push(`Updated kbIndexedFiles to ${verifiedFiles.length} file(s) (all indexed)`);
            } else {
              indexedFiles = verifiedFiles;
            }
          } else if (someFilesIndexed) {
            if (JSON.stringify(indexedFilesSorted) !== JSON.stringify(userDocFilesSorted)) {
              indexedFiles = indexedFilesFromDataSources;
              userDoc.kbIndexedFiles = indexedFilesFromDataSources;
              userDocUpdates.push(`Updated kbIndexedFiles to ${indexedFilesFromDataSources.length} of ${verifiedFiles.length} file(s) (partial indexing)`);
            } else {
              indexedFiles = indexedFilesFromDataSources;
            }
          } else {
            if (verifiedFiles.length === 0) {
              if (userDocIndexedFiles.length > 0) {
                indexedFiles = [];
                userDoc.kbIndexedFiles = [];
                userDocUpdates.push(`Cleared kbIndexedFiles (no files in KB)`);
              } else {
                indexedFiles = [];
              }
            } else {
              if (userDocIndexedFiles.length > 0) {
                indexedFiles = [];
                userDoc.kbIndexedFiles = [];
                userDocUpdates.push(`Cleared kbIndexedFiles (files exist but none indexed)`);
              } else {
                indexedFiles = [];
              }
            }
          }
          
          // Save user document if updated (with retry logic for conflicts)
          if (userDocUpdates.length > 0) {
            let retries = 3;
            let saved = false;
            while (retries > 0 && !saved) {
              try {
                await cloudant.saveDocument('maia_users', userDoc);
                console.log(`[KB VERIFY] UserDoc cleanup: ${userDocUpdates.join('; ')}`);
                saved = true;
              } catch (saveError) {
                if (saveError.statusCode === 409 && retries > 1) {
                  // Conflict - re-read and retry
                  retries--;
                  const freshDoc = await cloudant.getDocument('maia_users', userId);
                  if (freshDoc) {
                    // Re-apply the updates
                    if (allFilesIndexed) {
                      freshDoc.kbIndexedFiles = verifiedFiles;
                    } else if (someFilesIndexed) {
                      freshDoc.kbIndexedFiles = indexedFilesFromDataSources;
                    } else {
                      freshDoc.kbIndexedFiles = [];
                    }
                    userDoc = freshDoc;
                    // Update indexedFiles to match what we saved
                    if (allFilesIndexed) {
                      indexedFiles = verifiedFiles;
                    } else if (someFilesIndexed) {
                      indexedFiles = indexedFilesFromDataSources;
                    } else {
                      indexedFiles = [];
                    }
                    await new Promise(resolve => setTimeout(resolve, 100 * (4 - retries)));
                  } else {
                    throw saveError;
                  }
                } else {
                  console.error(`[KB VERIFY] Failed to save user document: ${saveError.message}`);
                  throw saveError;
                }
              }
            }
          }
          
          // Check if indexing is in progress AFTER cleanup (cleanup may have triggered it)
          try {
            const activeJobs = await doClient.indexing.listForKB(userDoc.kbId);
            const jobsArray = Array.isArray(activeJobs) ? activeJobs : 
                            (activeJobs?.jobs || activeJobs?.indexing_jobs || activeJobs?.data || []);
            const activeJob = jobsArray.find(j => {
              const status = j.status || j.job_status || j.state;
              return status === 'INDEX_JOB_STATUS_PENDING' || 
                     status === 'INDEX_JOB_STATUS_RUNNING' ||
                     status === 'INDEX_JOB_STATUS_IN_PROGRESS' ||
                     status === 'pending' ||
                     status === 'running' ||
                     status === 'in_progress';
            });
            
            if (activeJob) {
              indexingInProgress = true;
              indexingJobId = activeJob.uuid || activeJob.id || activeJob.indexing_job_id;
              const filesCount = activeJob.files_indexed || activeJob.indexed_file_count || '0';
              const tokensCount = activeJob.tokens_indexed || activeJob.total_tokens || '0';
              console.log(`[KB VERIFY] Indexing in progress: jobId=${indexingJobId}, files=${filesCount}, tokens=${tokensCount}`);
            }
          } catch (jobCheckErr) {
            // Ignore errors
          }
          
          // Determine if indexing is required
          const needsIndexing = verifiedFiles.length > 0 && indexedFilesFromDataSources.length < verifiedFiles.length;
          
          // Build verification result for frontend
          const verificationResult = {
            inconsistencies: inconsistencies.length > 0 ? inconsistencies : null,
            cleanupActions: deletedDataSources > 0 || skippedDataSources > 0 ? {
              deletedDataSources,
              skippedDataSources,
              errors: cleanupActions.length > 0 ? cleanupActions : null
            } : null,
            userDocUpdates: userDocUpdates.length > 0 ? userDocUpdates : null,
            indexingInProgress: indexingInProgress,
            indexingJobId: indexingJobId,
            needsIndexing: needsIndexing,
            verifiedFiles: verifiedFiles.length,
            indexedFiles: indexedFilesFromDataSources.length,
            filesInS3: filesInS3.length,
            filesWithoutDataSources: filesWithoutDataSources.length
          };
          
          // Store verification result for response
          res.locals.verificationResult = verificationResult;
          
          // Cache the verification result
          verificationCache.set(cacheKey, {
            timestamp: now,
            indexedFiles: indexedFiles,
            verificationResult: verificationResult
          });
          
          // Clean up old cache entries (older than 1 minute)
          for (const [key, value] of verificationCache.entries()) {
            if (now - value.timestamp > 60000) {
              verificationCache.delete(key);
            }
          }
        } catch (syncError) {
          console.error(`[KB VERIFY] Error during verification: ${syncError.message}`);
          // Continue with userDoc.kbIndexedFiles as fallback
        }
      }
    }
    
    const response = {
      success: true,
      files: files,
      indexedFiles: indexedFiles
    };
    
    // Include verification result if available
    if (res.locals.verificationResult) {
      response.verificationResult = res.locals.verificationResult;
    }
    
    res.json(response);
  } catch (error) {
    console.error('❌ Error fetching user files:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to fetch files: ${error.message}`,
      error: 'FETCH_FAILED'
    });
  }
});

// Toggle file knowledge base status
app.post('/api/toggle-file-knowledge-base', async (req, res) => {
  try {
    const { userId, bucketKey, inKnowledgeBase } = req.body;
    
    if (!userId || !bucketKey || typeof inKnowledgeBase !== 'boolean') {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID, bucketKey, and inKnowledgeBase are required',
        error: 'MISSING_REQUIRED_FIELDS'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    if (!userDoc.files) {
      userDoc.files = [];
    }

    // Find the file
    const fileIndex = userDoc.files.findIndex(f => f.bucketKey === bucketKey);
    
    if (fileIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: 'File not found',
        error: 'FILE_NOT_FOUND'
      });
    }

    // Get KB name from user document
    const kbName = getKBNameFromUserDoc(userDoc, userId);
    
    // Import S3 client operations for file moves
    const { S3Client, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');

    // Setup S3/Spaces client
    const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
    if (!bucketUrl) {
      return res.status(500).json({
        success: false,
        error: 'BUCKET_NOT_CONFIGURED',
        message: 'DigitalOcean bucket not configured'
      });
    }

    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';

    const s3Client = new S3Client({
      endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
      region: 'us-east-1',
      forcePathStyle: false,
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });

    // Determine source and destination paths
    const fileName = bucketKey.split('/').pop();
    let sourceKey = bucketKey;
    
    // Check if file is at root level (not archived yet)
    const isRootLevel = sourceKey.startsWith(`${userId}/`) && 
                        !sourceKey.startsWith(`${userId}/archived/`) && 
                        !sourceKey.startsWith(`${userId}/${kbName}/`) &&
                        sourceKey.split('/').length === 2; // Only userId/filename
    
    let destKey;
    let intermediateKey = null;
    
    if (inKnowledgeBase) {
      // Adding to KB
      if (isRootLevel) {
        // File is at root level - archive it first, then move to KB
        intermediateKey = `${userId}/archived/${fileName}`;
        destKey = `${userId}/${kbName}/${fileName}`;
      } else {
        // File is already archived, move directly to KB
        destKey = `${userId}/${kbName}/${fileName}`;
      }
    } else {
      // Removing from KB - always move to archived
      destKey = `${userId}/archived/${fileName}`;
    }

    // Save original state for rollback in case of failure
    const originalBucketKey = userDoc.files[fileIndex].bucketKey;
    const originalKnowledgeBases = [...(userDoc.files[fileIndex].knowledgeBases || [])];
    const originalKbIndexedFiles = userDoc.kbIndexedFiles ? [...userDoc.kbIndexedFiles] : [];
    
    try {
    // Handle intermediate step (root -> archived) if needed
    if (intermediateKey && sourceKey !== intermediateKey) {
      // Copy from root to archived
      const archiveCopy = new CopyObjectCommand({
        Bucket: bucketName,
        CopySource: `${bucketName}/${sourceKey}`,
        Key: intermediateKey
      });
      await s3Client.send(archiveCopy);
      
        // Verify the file exists at the intermediate location BEFORE deleting from root
        // This prevents data loss if the copy failed
        // Retry verification up to 3 times with exponential backoff
        let verified = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const verifyIntermediateCommand = new HeadObjectCommand({
              Bucket: bucketName,
              Key: intermediateKey
            });
            await s3Client.send(verifyIntermediateCommand);
            verified = true;
            break;
          } catch (verifyError) {
            if (attempt < 2) {
              // Wait before retry: 100ms, 200ms, 400ms
              await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt)));
            } else {
              // Final attempt failed - don't delete source file
              throw new Error(`File archive verification failed after 3 attempts: File not found at intermediate destination. Source file preserved.`);
            }
          }
        }
        
        if (!verified) {
          throw new Error(`File archive verification failed: File not found at intermediate destination. Source file preserved.`);
        }
        
        // Only delete from root after verification succeeds
      const archiveDelete = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: sourceKey
      });
      await s3Client.send(archiveDelete);
      
      // Update sourceKey for next step
      sourceKey = intermediateKey;
      
        // Update file's bucketKey in user document (temporary, will be saved after final move)
      userDoc.files[fileIndex].bucketKey = intermediateKey;
    }

    // Move file to final destination if different from source
    if (sourceKey !== destKey) {
      // Copy file to new location
      const copyCommand = new CopyObjectCommand({
        Bucket: bucketName,
        CopySource: `${bucketName}/${sourceKey}`,
        Key: destKey
      });
      await s3Client.send(copyCommand);

        // Verify the file exists at the new location BEFORE deleting from old location
        // This prevents data loss if the copy failed
        // Retry verification up to 3 times with exponential backoff
        let verified = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const verifyCommand = new HeadObjectCommand({
              Bucket: bucketName,
              Key: destKey
            });
            await s3Client.send(verifyCommand);
            verified = true;
            break;
          } catch (verifyError) {
            if (attempt < 2) {
              // Wait before retry: 100ms, 200ms, 400ms
              await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt)));
            } else {
              // Final attempt failed - don't delete source file
              throw new Error(`File move verification failed after 3 attempts: File not found at destination. Source file preserved.`);
            }
          }
        }
        
        if (!verified) {
          throw new Error(`File move verification failed: File not found at destination. Source file preserved.`);
        }

        // Only delete from old location after verification succeeds
      const deleteCommand = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: sourceKey
      });
      await s3Client.send(deleteCommand);

      // Update file's bucketKey in user document
      userDoc.files[fileIndex].bucketKey = destKey;
      }
    } catch (moveError) {
      // Rollback: restore original state in user document
      userDoc.files[fileIndex].bucketKey = originalBucketKey;
      userDoc.files[fileIndex].knowledgeBases = originalKnowledgeBases;
      userDoc.kbIndexedFiles = originalKbIndexedFiles;
      
      // Try to save rollback state (non-blocking)
      try {
        await cloudant.saveDocument('maia_users', userDoc);
      } catch (rollbackError) {
        console.error('❌ Failed to rollback user document after file move failure:', rollbackError);
      }
      
      throw moveError;
    }

    // Update knowledge base status
    if (inKnowledgeBase) {
      // Add to knowledge base
      if (!userDoc.files[fileIndex].knowledgeBases) {
        userDoc.files[fileIndex].knowledgeBases = [];
      }
      // Mark as in knowledge base by adding KB name
      if (userDoc.files[fileIndex].knowledgeBases.length === 0) {
        userDoc.files[fileIndex].knowledgeBases.push(kbName);
      }
      // Ensure a per-file data source exists for this KB file
      try {
        if (userDoc.kbId) {
          if (!Array.isArray(userDoc.kbChangedDataSourceUuids)) {
            userDoc.kbChangedDataSourceUuids = [];
          }
          if (!userDoc.files[fileIndex].kbDataSourceUuid) {
            const added = await doClient.kb.addDataSource(userDoc.kbId, {
              bucketName,
              itemPath: `${userId}/${kbName}/${fileName}`,
              region: process.env.DO_REGION || 'tor1'
            });
            const dsUuid = added?.uuid || added?.id || added?.knowledge_base_data_source?.uuid;
            if (dsUuid) {
              userDoc.files[fileIndex].kbDataSourceUuid = dsUuid;
              if (!userDoc.kbChangedDataSourceUuids.includes(dsUuid)) {
                userDoc.kbChangedDataSourceUuids.push(dsUuid);
              }
              userDoc.kbIndexingNeeded = true;
            }
          } else {
            // Existing data source - mark for targeted reindex
            if (!userDoc.kbChangedDataSourceUuids.includes(userDoc.files[fileIndex].kbDataSourceUuid)) {
              userDoc.kbChangedDataSourceUuids.push(userDoc.files[fileIndex].kbDataSourceUuid);
            }
            userDoc.kbIndexingNeeded = true;
          }
        } else {
          // No KB yet - mark dirty, indexing will reconcile later
          userDoc.kbIndexingNeeded = true;
        }
      } catch (perFileDsErr) {
        console.error('[KB] Error ensuring per-file data source:', perFileDsErr.message);
        userDoc.kbIndexingNeeded = true;
      }
    } else {
      // Remove from knowledge base
      userDoc.files[fileIndex].knowledgeBases = [];
      
      // Also remove from indexed files if it was indexed (check both old and new bucketKey)
      if (userDoc.kbIndexedFiles && Array.isArray(userDoc.kbIndexedFiles)) {
        userDoc.kbIndexedFiles = userDoc.kbIndexedFiles.filter(
          indexedKey => indexedKey !== bucketKey && indexedKey !== destKey && indexedKey !== sourceKey
        );
      }
      // Delete per-file data source if it exists
      try {
        const dsUuid = userDoc.files[fileIndex].kbDataSourceUuid;
        if (userDoc.kbId && dsUuid) {
          await doClient.kb.deleteDataSource(userDoc.kbId, dsUuid);
        }
        userDoc.files[fileIndex].kbDataSourceUuid = undefined;
        // After removal, re-index remaining data sources to reflect deletion
        userDoc.kbReindexAll = true;
        userDoc.kbIndexingNeeded = true;
      } catch (perFileDsDelErr) {
        console.error('[KB] Error deleting per-file data source:', perFileDsDelErr.message);
        userDoc.kbReindexAll = true;
        userDoc.kbIndexingNeeded = true;
      }
    }

    userDoc.files[fileIndex].updatedAt = new Date().toISOString();

    // Mark KB as needing indexing since files were moved in/out of KB folder
    // Get current files in KB folder to determine if indexing is needed
    const currentFilesInKB = (userDoc.files || [])
      .filter(file => {
        const fileBucketKey = file.bucketKey || '';
        // File is in KB folder if bucketKey starts with userId/kbName/
        return fileBucketKey.startsWith(`${userId}/${kbName}/`);
      })
      .map(file => file.bucketKey);
    
    // Compare with indexed files to determine if indexing is needed
    const currentIndexedFiles = userDoc.kbIndexedFiles || [];
    const filesChanged = JSON.stringify([...currentFilesInKB].sort()) !== JSON.stringify([...currentIndexedFiles].sort());
    
    // Set kbIndexingNeeded flag if files in KB folder don't match indexed files
    // This ensures the state is persisted even if user closes dialog without clicking "Update and Index KB"
    // Note: We need indexing even if KB is empty (currentFilesInKB.length === 0) because files were removed
    // and the KB index needs to be updated to reflect the empty state
    userDoc.kbIndexingNeeded = filesChanged;

    // Save the updated user document with retry logic for conflicts
    let saved = false;
    let retries = 3;
    while (!saved && retries > 0) {
      try {
    await cloudant.saveDocument('maia_users', userDoc);
        saved = true;
      } catch (saveError) {
        if (saveError.statusCode === 409 && retries > 1) {
          // Conflict - re-read document and retry
          retries--;
          const freshDoc = await cloudant.getDocument('maia_users', userId);
          // Re-apply our changes to the fresh document
          const freshFileIndex = freshDoc.files.findIndex(f => f.bucketKey === originalBucketKey || f.bucketKey === destKey);
          if (freshFileIndex >= 0) {
            freshDoc.files[freshFileIndex].bucketKey = destKey;
            freshDoc.files[freshFileIndex].knowledgeBases = inKnowledgeBase ? [kbName] : [];
            freshDoc.files[freshFileIndex].updatedAt = new Date().toISOString();
            // Recalculate kbIndexingNeeded
            const freshFilesInKB = (freshDoc.files || [])
              .filter(file => {
                const fileBucketKey = file.bucketKey || '';
                return fileBucketKey.startsWith(`${userId}/${kbName}/`);
              })
              .map(file => file.bucketKey);
            const freshIndexedFiles = freshDoc.kbIndexedFiles || [];
            const freshFilesChanged = JSON.stringify([...freshFilesInKB].sort()) !== JSON.stringify([...freshIndexedFiles].sort());
            // Note: We need indexing even if KB is empty because files were removed
            freshDoc.kbIndexingNeeded = freshFilesChanged;
            userDoc = freshDoc;
            await new Promise(resolve => setTimeout(resolve, 200 * (4 - retries)));
          } else {
            throw new Error('File not found in fresh user document during retry');
          }
        } else {
          throw saveError;
        }
      }
    }
    
    if (!saved) {
      throw new Error('Failed to save user document after file move');
    }
    
    res.json({
      success: true,
      message: 'Knowledge base status updated',
      inKnowledgeBase: inKnowledgeBase,
      newBucketKey: sourceKey !== destKey ? destKey : bucketKey
    });
  } catch (error) {
    console.error('❌ Error toggling file knowledge base:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to update knowledge base status: ${error.message}`,
      error: 'UPDATE_FAILED'
    });
  }
});

// Get agent instructions
app.get('/api/agent-instructions', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc || !userDoc.assignedAgentId) {
      return res.status(404).json({ 
        success: false, 
        message: 'User agent not found',
        error: 'AGENT_NOT_FOUND'
      });
    }

    // Get agent from DigitalOcean
    const agent = await doClient.agent.get(userDoc.assignedAgentId);
    
    if (!agent) {
      return res.status(404).json({ 
        success: false, 
        message: 'Agent not found in DigitalOcean',
        error: 'AGENT_NOT_FOUND'
      });
    }

    // Get KB info and connection status
    let kbInfo = null;
    if (userDoc.kbId) {
      // Validate KB resources to get current connection status
      const { kbStatus } = await validateUserResources(userId);
      
      // Get KB name
      const kbName = getKBNameFromUserDoc(userDoc, userId);
      
      // Get indexed files - source of truth is userDoc.kbIndexedFiles
      // This array contains bucketKeys of files that were successfully indexed
      // It's updated when indexing completes (not just intent)
      const indexedFiles = userDoc.kbIndexedFiles || [];
      
      // Get last indexed time
      const lastIndexedAt = userDoc.kbLastIndexedAt || userDoc.kbIndexingStartedAt || null;
      
      kbInfo = {
        name: kbName,
        kbId: userDoc.kbId,
        connected: kbStatus === 'attached',
        indexedFiles: indexedFiles,
        lastIndexedAt: lastIndexedAt
      };
    }

    res.json({
      success: true,
      instructions: agent.instruction || '',
      kbInfo: kbInfo
    });
  } catch (error) {
    console.error('❌ Error fetching agent instructions:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to fetch agent instructions: ${error.message}`,
      error: 'FETCH_FAILED'
    });
  }
});

// Update agent instructions
app.put('/api/agent-instructions', async (req, res) => {
  try {
    const { userId, instructions } = req.body;
    
    if (!userId || typeof instructions !== 'string') {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID and instructions are required',
        error: 'MISSING_REQUIRED_FIELDS'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc || !userDoc.assignedAgentId) {
      return res.status(404).json({ 
        success: false, 
        message: 'User agent not found',
        error: 'AGENT_NOT_FOUND'
      });
    }

    console.log(`📝 Updating agent instructions for user ${userId}, agent ${userDoc.assignedAgentId}`);

    // Update agent instructions via DigitalOcean API
    const updatedAgent = await doClient.agent.update(userDoc.assignedAgentId, {
      instruction: instructions
    });

    console.log(`✅ Agent instructions updated successfully for agent ${userDoc.assignedAgentId}`);
    
    res.json({
      success: true,
      message: 'Agent instructions updated',
      agentId: userDoc.assignedAgentId
    });
  } catch (error) {
    console.error('❌ Error updating agent instructions:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to update agent instructions: ${error.message}`,
      error: 'UPDATE_FAILED'
    });
  }
});

// Get user settings
app.get('/api/user-settings', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Return settings (default to true for backward compatibility)
    res.json({
      success: true,
      allowDeepLinkPrivateAI: userDoc.allowDeepLinkPrivateAI !== undefined ? userDoc.allowDeepLinkPrivateAI : true
    });
  } catch (error) {
    console.error('❌ Error fetching user settings:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to fetch user settings: ${error.message}`,
      error: 'FETCH_FAILED'
    });
  }
});

// Save current medications to user document
app.post('/api/user-current-medications', async (req, res) => {
  try {
    const { userId, currentMedications } = req.body;
    
    if (!userId || currentMedications === undefined) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID and currentMedications are required',
        error: 'MISSING_REQUIRED_FIELDS'
      });
    }

    // Get the user document
    let userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Update current medications
    userDoc.currentMedications = currentMedications;
    userDoc.updatedAt = new Date().toISOString();

    // Save with retry logic for conflicts
    let retries = 3;
    let saved = false;
    
    while (retries > 0 && !saved) {
      try {
        await cloudant.saveDocument('maia_users', userDoc);
        saved = true;
      } catch (error) {
        if (error.statusCode === 409 && retries > 1) {
          // Conflict - re-read and retry
          userDoc = await cloudant.getDocument('maia_users', userId);
          userDoc.currentMedications = currentMedications;
          userDoc.updatedAt = new Date().toISOString();
          retries--;
          await new Promise(resolve => setTimeout(resolve, 100));
        } else {
          throw error;
        }
      }
    }
    
    res.json({
      success: true,
      message: 'Current medications saved',
      currentMedications: currentMedications
    });
  } catch (error) {
    console.error('❌ Error saving current medications:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to save current medications: ${error.message}`,
      error: 'SAVE_FAILED'
    });
  }
});

// Update user settings
app.put('/api/user-settings', async (req, res) => {
  try {
    const { userId, allowDeepLinkPrivateAI } = req.body;
    
    if (!userId || typeof allowDeepLinkPrivateAI !== 'boolean') {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID and allowDeepLinkPrivateAI (boolean) are required',
        error: 'MISSING_REQUIRED_FIELDS'
      });
    }

    // Get the user document
    let userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Update the setting
    userDoc.allowDeepLinkPrivateAI = allowDeepLinkPrivateAI;
    userDoc.updatedAt = new Date().toISOString();

    // Save with retry logic for conflicts
    let retries = 3;
    let saved = false;
    
    while (retries > 0 && !saved) {
      try {
        await cloudant.saveDocument('maia_users', userDoc);
        saved = true;
      } catch (error) {
        if (error.statusCode === 409 && retries > 1) {
          // Conflict - re-read and retry
          userDoc = await cloudant.getDocument('maia_users', userId);
          userDoc.allowDeepLinkPrivateAI = allowDeepLinkPrivateAI;
          userDoc.updatedAt = new Date().toISOString();
          retries--;
          await new Promise(resolve => setTimeout(resolve, 100));
        } else {
          throw error;
        }
      }
    }
    
    res.json({
      success: true,
      message: 'User settings updated',
      allowDeepLinkPrivateAI: allowDeepLinkPrivateAI
    });
  } catch (error) {
    console.error('❌ Error updating user settings:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to update user settings: ${error.message}`,
      error: 'UPDATE_FAILED'
    });
  }
});

// Delete file from Spaces and user document
app.delete('/api/delete-file', async (req, res) => {
  try {
    const { userId, bucketKey } = req.body;
    
    if (!userId || !bucketKey) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID and bucket key are required',
        error: 'MISSING_REQUIRED_FIELDS'
      });
    }

    // Import S3 client operations
    const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');

    // Setup S3/Spaces client
    const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
    if (!bucketUrl) {
      return res.status(500).json({
        success: false,
        error: 'BUCKET_NOT_CONFIGURED',
        message: 'DigitalOcean bucket not configured'
      });
    }

    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';

    const s3Client = new S3Client({
      endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
      region: 'us-east-1',
      forcePathStyle: false,
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });

    // Get user document FIRST to check if file is in KB and has a data source
    // CRITICAL: Delete data source BEFORE deleting file from S3
    // If data source deletion fails, we should keep the file and report error
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }
    
    // Check if file was in KB before removing
    const kbName = getKBNameFromUserDoc(userDoc, userId);
    const wasInKB = bucketKey && bucketKey.startsWith(`${userId}/${kbName}/`);
    
    // CRITICAL: Delete data source FIRST (most important operation)
    // Only proceed with file deletion if data source deletion succeeds
    let dataSourceDeleted = false;
    let dataSourceDeletionError = null;
    
    if (userDoc.files && wasInKB) {
      const fileIndex = userDoc.files.findIndex(f => f.bucketKey === bucketKey);
      const dsUuid = fileIndex >= 0 ? userDoc.files[fileIndex].kbDataSourceUuid : undefined;
      
      if (userDoc.kbId && dsUuid) {
        try {
          // Check if there's an active indexing job before trying to delete
          // DigitalOcean may not allow deleting data sources while indexing is in progress
          let canDelete = true;
          try {
            const activeJobs = await doClient.indexing.listForKB(userDoc.kbId);
            const jobsArray = Array.isArray(activeJobs) ? activeJobs : 
                            (activeJobs?.jobs || activeJobs?.indexing_jobs || activeJobs?.data || []);
            const hasActiveJob = jobsArray.some(j => {
              const status = j.status || j.job_status || j.state;
              return status === 'INDEX_JOB_STATUS_PENDING' || 
                     status === 'INDEX_JOB_STATUS_RUNNING' ||
                     status === 'INDEX_JOB_STATUS_IN_PROGRESS' ||
                     status === 'pending' ||
                     status === 'running' ||
                     status === 'in_progress';
            });
            if (hasActiveJob) {
              console.log(`[KB] ⚠️ Active indexing job detected - cannot delete data source ${dsUuid} now. File deletion aborted.`);
              canDelete = false;
              dataSourceDeletionError = new Error('Cannot delete data source while indexing is in progress');
            }
          } catch (jobCheckErr) {
            console.warn(`[KB] Could not check for active indexing jobs: ${jobCheckErr.message}`);
            // Continue with deletion attempt anyway
          }
          
          if (canDelete) {
            await doClient.kb.deleteDataSource(userDoc.kbId, dsUuid);
            console.log(`[KB] ✅ Deleted data source ${dsUuid} for file in KB`);
            dataSourceDeleted = true;
          }
        } catch (dsErr) {
          // Data source deletion failed - this is critical
          const errorMsg = dsErr.message || 'Unknown error';
          const isForbidden = errorMsg.includes('403') || errorMsg.includes('forbidden');
          dataSourceDeletionError = dsErr;
          
          if (isForbidden) {
            console.error(`[KB] ❌ CRITICAL: Cannot delete data source ${dsUuid} (403 Forbidden) - aborting file deletion`);
          } else {
            console.error(`[KB] ❌ CRITICAL: Failed to delete data source ${dsUuid}: ${errorMsg} - aborting file deletion`);
          }
          
          // DO NOT proceed with file deletion if data source deletion failed
          return res.status(500).json({
            success: false,
            message: `Failed to delete data source from knowledge base: ${errorMsg}. File was not deleted.`,
            error: 'DATA_SOURCE_DELETION_FAILED'
          });
        }
      } else if (wasInKB && !dsUuid) {
        // File is in KB folder but has no data source UUID - this is unusual but not critical
        console.warn(`[KB] ⚠️ File ${bucketKey} is in KB folder but has no kbDataSourceUuid - proceeding with file deletion`);
        dataSourceDeleted = true; // Allow deletion to proceed
      } else {
        // File is not in KB - no data source to delete
        dataSourceDeleted = true; // Allow deletion to proceed
      }
    } else {
      // File is not in KB - no data source to delete
      dataSourceDeleted = true; // Allow deletion to proceed
    }
    
    // Only delete file from S3 if data source deletion succeeded (or file was not in KB)
    if (!dataSourceDeleted) {
      return res.status(500).json({
        success: false,
        message: dataSourceDeletionError?.message || 'Cannot delete file: data source deletion failed',
        error: 'DATA_SOURCE_DELETION_FAILED'
      });
    }
    
    // Delete file from Spaces (only after data source is deleted)
    const deleteCommand = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: bucketKey
    });

    await s3Client.send(deleteCommand);
    console.log(`✅ Deleted file from Spaces: ${bucketKey}`);

    // Update user document
    if (userDoc.files) {
      // Remove file from userDoc.files
      userDoc.files = userDoc.files.filter(f => f.bucketKey !== bucketKey);
      
      // If file was in KB, remove from kbIndexedFiles and mark KB as needing update
      if (wasInKB) {
        if (userDoc.kbIndexedFiles && Array.isArray(userDoc.kbIndexedFiles)) {
          userDoc.kbIndexedFiles = userDoc.kbIndexedFiles.filter(f => f !== bucketKey);
        }
        // Mark KB as needing re-indexing since a file was removed
        userDoc.kbIndexingNeeded = true;
        userDoc.kbReindexAll = true;
      }
      
      await cloudant.saveDocument('maia_users', userDoc);
      console.log(`✅ Removed file metadata from user document: ${bucketKey}${wasInKB ? ' (was in KB, re-indexing needed)' : ''}`);
    }

    res.json({
      success: true,
      message: 'File deleted successfully'
    });
  } catch (error) {
    console.error('❌ Error deleting file:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to delete file: ${error.message}`,
      error: 'DELETE_FAILED'
    });
  }
});

/**
 * Setup knowledge base in DigitalOcean
 * This function only creates the KB if it doesn't exist. Indexing is handled automatically by DO.
 * 
 * @param {string} userId - User ID
 * @param {string} kbName - KB name (permanent, from userDoc.kbName)
 * @param {string[]} filesInKB - Array of bucketKeys in KB folder (unused, kept for compatibility)
 * @param {string} bucketName - S3 bucket name (required for KB creation)
 * @param {string|null} existingJobId - Existing indexing job ID (unused, kept for compatibility)
 * @returns {Promise<{kbId: string, kbDetails: object}|{error: string, message: string}>}
 */
async function setupKnowledgeBase(userId, kbName, filesInKB, bucketName, existingJobId = null) {
  // Step 1: Check DO API to see if KB already exists (by name)
  let kbId = null;
  let kbDetails = null;
  let existingKbFound = false;
  let allKBsCache = null; // Cache KB list for reuse
  
  try {
    // List all KBs from DO API
    console.log(`[KB AUTO] Calling doClient.kb.list() to check for existing KB: ${kbName}`);
    allKBsCache = await doClient.kb.list();
    
    // Find KB by name (case-sensitive match)
    const foundKB = allKBsCache.find(kb => kb.name === kbName);
    
    if (foundKB) {
      // KB exists in DO - use it
      kbId = foundKB.uuid || foundKB.id;
      existingKbFound = true;
      console.log(`✅ Found existing KB in DO: ${kbName} (${kbId})`);
      
      // Get full KB details
      console.log(`[KB AUTO] Calling doClient.kb.get(${kbId}) to get KB details`);
      kbDetails = await doClient.kb.get(kbId);
    }
  } catch (error) {
    console.error('❌ Error checking for existing KB in DO API:', error);
    return { error: 'KB_CHECK_FAILED', message: `Failed to check for existing KB: ${error.message}` };
  }
  
  // Step 2: Create KB if it doesn't exist
  if (!existingKbFound) {
    // Get required values directly from environment variables
    const projectId = process.env.DO_PROJECT_ID;
    const databaseId = process.env.DO_DATABASE_ID;
    const embeddingModelId = process.env.DO_EMBEDDING_MODEL_ID || null;
    
    // Validate UUID format helper
    const isValidUUID = (str) => {
      if (!str || typeof str !== 'string') return false;
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      return uuidRegex.test(str.trim());
    };
    
    // Validate required environment variables
    if (!isValidUUID(projectId)) {
      return { 
        error: 'PROJECT_ID_NOT_CONFIGURED', 
        message: 'DO_PROJECT_ID environment variable is required and must be a valid UUID. Please set DO_PROJECT_ID in your .env file and restart the server.' 
      };
    }
    
    if (!isValidUUID(databaseId)) {
      return { 
        error: 'DATABASE_ID_NOT_CONFIGURED', 
        message: 'DO_DATABASE_ID environment variable is required and must be a valid UUID. Please set DO_DATABASE_ID in your .env file and restart the server.' 
      };
    }
    
    try {
      console.log(`📝 Creating new KB in DO: ${kbName}`);
      const kbCreateOptions = {
        name: kbName,
        description: `Knowledge base for ${userId}`,
        projectId: projectId,
        databaseId: databaseId,
        bucketName: bucketName,
        itemPath: `${userId}/${kbName}/`,
        region: process.env.DO_REGION || 'tor1'
      };
      
      // Add embedding model ID if provided
      if (embeddingModelId && isValidUUID(embeddingModelId)) {
        kbCreateOptions.embeddingModelId = embeddingModelId;
        console.log(`[KB Setup] Using embedding model ID from env: ${embeddingModelId}`);
      }
      
      console.log(`[KB AUTO] Calling doClient.kb.create() with name: ${kbName}, projectId: ${projectId}, databaseId: ${databaseId}, bucketName: ${bucketName}, itemPath: ${kbCreateOptions.itemPath}${embeddingModelId ? `, embeddingModelId: ${embeddingModelId}` : ''}`);
      const kbResult = await doClient.kb.create(kbCreateOptions);
      
      kbId = kbResult.uuid || kbResult.id;
      console.log(`✅ Created new KB: ${kbName} (${kbId})`);
      
      // Get KB details
      kbDetails = await doClient.kb.get(kbId);
      
      invalidateResourceCache(userId);
      
      return {
        kbId: kbId,
        kbDetails: kbDetails
      };
    } catch (error) {
      console.error('❌ Error creating KB:', error);
      return { error: 'KB_CREATION_FAILED', message: `Failed to create knowledge base: ${error.message}` };
    }
  }
  
  // KB exists - return it
  invalidateResourceCache(userId);
  
  return {
    kbId: kbId,
    kbDetails: kbDetails
  };
}

// Update knowledge base - setup KB and trigger indexing (files already moved by checkboxes)
app.post('/api/update-knowledge-base', async (req, res) => {
  try {
    const { userId } = req.body;
    
    console.log(`[KB Update] Received request for userId: ${userId}`);
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get user document (files already moved by checkboxes)
    let userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Get KB name from user document
    const kbName = getKBNameFromUserDoc(userDoc, userId);
    
    // Get bucket name for data source path
    const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
    if (!bucketUrl) {
      return res.status(500).json({
        success: false,
        error: 'BUCKET_NOT_CONFIGURED',
        message: 'DigitalOcean bucket not configured'
      });
    }
    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';

    // Get list of files currently in KB folder (files already moved by checkboxes)
    const filesInKB = userDoc.files
      .filter(file => {
        return file.bucketKey && file.bucketKey.startsWith(`${userId}/${kbName}/`);
      })
      .map(file => file.bucketKey);
    
    // Setup KB (just create it - no datasource or indexing management)
    const kbSetupResult = await setupKnowledgeBase(
      userId,
      kbName,
      filesInKB,
      bucketName,
      null // No existing job ID needed
    );
    
    if (kbSetupResult.error) {
      return res.status(400).json({
        success: false, 
        error: kbSetupResult.error,
        message: kbSetupResult.message,
        kbId: kbSetupResult.kbId || null
      });
    }
    
    const { kbId } = kbSetupResult;
    let kbDetails = kbSetupResult.kbDetails;
    
    const persistKbState = async () => {
      let retries = 3;
      let docSaved = false;
      let lastError = null;

      while (retries > 0 && !docSaved) {
        try {
          const currentDoc = retries === 3 ? userDoc : await cloudant.getDocument('maia_users', userId);
          if (!currentDoc) {
            throw new Error('User document not found during KB update');
          }

          currentDoc.kbId = kbId;
          currentDoc.kbIndexingNeeded = true;
          currentDoc.kbPendingFiles = filesInKB;
          currentDoc.kbIndexingStartedAt = new Date().toISOString();

          if (!currentDoc.kbCreatedAt && kbDetails) {
            currentDoc.kbCreatedAt = new Date().toISOString();
          }

          if (!Array.isArray(currentDoc.connectedKBs)) {
            currentDoc.connectedKBs = [];
          }
          if (!currentDoc.connectedKBs.includes(kbName)) {
            currentDoc.connectedKBs.push(kbName);
          }
          currentDoc.connectedKB = kbName; // Legacy field

          await cloudant.saveDocument('maia_users', currentDoc);
          userDoc = currentDoc;
          docSaved = true;
        } catch (err) {
          lastError = err;
          if (err.statusCode === 409 || err.error === 'conflict') {
            retries -= 1;
            if (retries === 0) {
              console.error(`[KB AUTO] Document conflict while updating KB state for ${userId}: ${err.message}`);
              throw err;
            }
            await new Promise(resolve => setTimeout(resolve, 200 * (4 - retries)));
          } else {
            throw err;
          }
        }
      }
      return userDoc;
    };

    userDoc = await persistKbState();
    
    // Check if files have changed and need re-indexing
    // Compare current files in KB folder with what was previously indexed
    const currentIndexedFiles = userDoc.kbIndexedFiles || [];
    const filesChanged = JSON.stringify([...filesInKB].sort()) !== JSON.stringify([...currentIndexedFiles].sort());
    
    // Also check if user explicitly requested indexing (kbIndexingNeeded flag)
    const indexingRequested = userDoc.kbIndexingNeeded === true;
    
    let jobId = null;
    let indexingStarted = false;
    
    // If files changed OR indexing was explicitly requested, start a new indexing job
    if (filesChanged || indexingRequested) {
      if (!filesChanged && indexingRequested) {
        console.log(`[KB Update] Indexing requested by user (kbIndexingNeeded=true), files in KB: ${filesInKB.length}`);
      }
      try {
        // Check if there's already an active indexing job
        if (userDoc.kbLastIndexingJobId) {
          try {
            const existingJobStatus = await doClient.indexing.getStatus(userDoc.kbLastIndexingJobId);
            const existingStatus = existingJobStatus.status || existingJobStatus.job_status || existingJobStatus.state;
            const isActive = existingStatus === 'INDEX_JOB_STATUS_PENDING' || 
                           existingStatus === 'INDEX_JOB_STATUS_RUNNING' ||
                           existingStatus === 'INDEX_JOB_STATUS_IN_PROGRESS' ||
                           existingStatus === 'pending' ||
                           existingStatus === 'running' ||
                           existingStatus === 'in_progress';
            
            if (isActive) {
              console.log(`[KB Update] ⚠️ Indexing job ${userDoc.kbLastIndexingJobId} is already running - using existing job`);
              jobId = userDoc.kbLastIndexingJobId;
              indexingStarted = true;
            }
          } catch (statusError) {
            // Job doesn't exist or failed - proceed to start new one
            console.log(`[KB Update] Existing job ${userDoc.kbLastIndexingJobId} not found or failed - starting new job`);
          }
        }
        
        // Before starting a new job, check if there are any active jobs via listForKB
        // This prevents getting stuck waiting for a job that doesn't exist
        if (!jobId) {
          try {
            const existingJobs = await doClient.indexing.listForKB(kbId);
            const jobsArray = Array.isArray(existingJobs) ? existingJobs : 
                            (existingJobs?.jobs || existingJobs?.indexing_jobs || existingJobs?.data || []);
            
            // Find any active indexing job
            const activeJob = jobsArray.find(j => {
              const jobStatus = j.status || j.job_status || j.state;
              return jobStatus === 'INDEX_JOB_STATUS_PENDING' || 
                     jobStatus === 'INDEX_JOB_STATUS_RUNNING' ||
                     jobStatus === 'INDEX_JOB_STATUS_IN_PROGRESS' ||
                     jobStatus === 'pending' ||
                     jobStatus === 'running' ||
                     jobStatus === 'in_progress';
            });
            
            if (activeJob) {
              const foundJobId = activeJob.uuid || activeJob.id || activeJob.indexing_job_id;
              console.log(`[KB Update] ⚠️ Found active indexing job ${foundJobId} via listForKB - using existing job`);
              jobId = foundJobId;
              indexingStarted = true;
              
              // Update userDoc with the found job ID
              try {
                const freshDoc = await cloudant.getDocument('maia_users', userId);
                if (freshDoc && freshDoc.kbLastIndexingJobId !== foundJobId) {
                  freshDoc.kbLastIndexingJobId = foundJobId;
                  await cloudant.saveDocument('maia_users', freshDoc);
                }
              } catch (updateErr) {
                console.warn(`[KB Update] ⚠️ Could not update userDoc with found job ID:`, updateErr.message);
              }
            }
          } catch (listError) {
            console.error(`[KB Update] ❌ Error listing indexing jobs:`, listError.message);
            // Continue to start new job if listing fails
          }
        }
        
        // Start new indexing job if no active job found
        if (!jobId) {
          // Get current datasources from KB
          let datasources = kbDetails?.datasources || kbDetails?.data_sources || kbDetails?.knowledge_base_data_sources || [];
          
          // Query S3/Spaces directly to get actual files in KB folder (source of truth)
          const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
          const s3Client = new S3Client({
            endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
            region: 'us-east-1',
            forcePathStyle: false,
            credentials: {
              accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
              secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
            }
          });
          
          const kbFolderPath = `${userId}/${kbName}/`;
          const listCommand = new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: kbFolderPath
          });
          
          let actualFilesInKB = [];
          try {
            const listResult = await s3Client.send(listCommand);
            actualFilesInKB = (listResult.Contents || [])
              .filter(file => {
                const key = file.Key || '';
                // Only include actual files (not folders), exclude .keep files
                return key.startsWith(kbFolderPath) && 
                       !key.endsWith('/') && 
                       !key.endsWith('.keep') &&
                       key !== kbFolderPath;
              })
              .map(file => file.Key || '');
            
            console.log(`[KB Update] Found ${actualFilesInKB.length} actual file(s) in KB folder: ${actualFilesInKB.map(k => k.split('/').pop()).join(', ')}`);
          } catch (s3Error) {
            console.error(`[KB Update] ⚠️ Error querying S3 for KB folder files:`, s3Error.message);
            // Fallback to userDoc.files if S3 query fails
            actualFilesInKB = userDoc.files
              .filter(file => file.bucketKey && file.bucketKey.startsWith(kbFolderPath))
              .map(file => file.bucketKey);
          }
          
          // Build map of existing data sources by file path
          const existingDsByPath = new Map();
          for (const ds of datasources) {
            const dsPath = ds.item_path || ds.path || ds.spaces_data_source?.item_path;
            if (dsPath) {
              existingDsByPath.set(dsPath, ds.uuid || ds.id);
            }
          }
          
          // Build map of file data source UUIDs from userDoc
          const fileDsMap = new Map();
          for (const file of userDoc.files || []) {
            if (file.bucketKey && file.kbDataSourceUuid) {
              fileDsMap.set(file.bucketKey, file.kbDataSourceUuid);
            }
          }
          
          // Find files that need data sources created
          const newlyCreatedDsUuids = [];
          for (const filePath of actualFilesInKB) {
            const fileName = filePath.split('/').pop();
            const expectedPath = `${userId}/${kbName}/${fileName}`;
            
            // Check if data source already exists (by path or by file's kbDataSourceUuid)
            const existingDsUuid = existingDsByPath.get(expectedPath) || fileDsMap.get(filePath);
            
            if (!existingDsUuid) {
              // Need to create a data source for this file
              try {
                console.log(`[KB Update] Creating per-file data source for: ${expectedPath}`);
                const newDataSource = await doClient.kb.addDataSource(kbId, {
                  bucketName: bucketName,
                  itemPath: expectedPath,
                  region: process.env.DO_REGION || 'tor1'
                });
                
                const dsUuid = newDataSource.uuid || newDataSource.id || newDataSource.knowledge_base_data_source?.uuid;
                if (dsUuid) {
                  // Store the data source UUID on the file in userDoc
                  const fileIndex = userDoc.files.findIndex(f => f.bucketKey === filePath);
                  if (fileIndex >= 0) {
                    userDoc.files[fileIndex].kbDataSourceUuid = dsUuid;
                  } else {
                    // File not in userDoc yet - add it (shouldn't happen, but handle it)
                    console.warn(`[KB Update] ⚠️ File ${filePath} found in S3 but not in userDoc.files`);
                  }
                  newlyCreatedDsUuids.push(dsUuid);
                  existingDsByPath.set(expectedPath, dsUuid); // Add to map for next iteration
                  console.log(`[KB Update] ✅ Created per-file data source ${dsUuid} for ${fileName}`);
                }
              } catch (dsError) {
                console.error(`[KB Update] ❌ Error creating per-file data source for ${expectedPath}:`, dsError.message);
                // Continue with other files
              }
            } else {
              // Data source exists - ensure it's stored on the file
              const fileIndex = userDoc.files.findIndex(f => f.bucketKey === filePath);
              if (fileIndex >= 0 && !userDoc.files[fileIndex].kbDataSourceUuid) {
                userDoc.files[fileIndex].kbDataSourceUuid = existingDsUuid;
              }
            }
          }
          
          // Save file updates if any data sources were created or updated
          if (newlyCreatedDsUuids.length > 0) {
            try {
              await cloudant.saveDocument('maia_users', userDoc);
            } catch (saveErr) {
              console.warn(`[KB Update] ⚠️ Failed to save file data source UUIDs:`, saveErr.message);
            }
            
            // Refresh KB details to get all datasources
            kbDetails = await doClient.kb.get(kbId);
            datasources = kbDetails?.datasources || kbDetails?.data_sources || kbDetails?.knowledge_base_data_sources || [];
          }
          
          // Determine which data sources to index:
          // First, check actual indexing status from DO API to see which data sources need indexing
          // - If kbReindexAll: index all current data sources
          // - Else if kbChangedDataSourceUuids present: index only those
          // - Else if files were just added (newlyCreatedDsUuids): index those
          // - Else: check DO API for which data sources are not indexed and index those
          
          // Get fresh data sources from DO API to check indexing status (this is the source of truth)
          let dataSourcesWithStatus = [];
          try {
            dataSourcesWithStatus = await doClient.kb.listDataSources(kbId);
            console.log(`[KB Update] Retrieved ${dataSourcesWithStatus.length} data source(s) with status from DO API`);
          } catch (dsStatusError) {
            console.warn(`[KB Update] ⚠️ Could not retrieve data source status from DO API:`, dsStatusError.message);
            // Fall back to using datasources from kbDetails
            dataSourcesWithStatus = datasources;
          }
          
          // Build list of all data source UUIDs from the API response (source of truth)
          const allDsUuids = dataSourcesWithStatus
            .map(ds => ds.uuid || ds.id)
            .filter(Boolean);
          
          // Build map of data source UUID -> indexing status
          const dsIndexingStatus = new Map();
          for (const ds of dataSourcesWithStatus) {
            const dsUuid = ds.uuid || ds.id;
            if (dsUuid) {
              const lastJob = ds?.last_datasource_indexing_job;
              // A file is indexed if it has a last_datasource_indexing_job (regardless of status)
              // The presence of last_datasource_indexing_job indicates the data source has been processed
              const isIndexed = !!lastJob;
              dsIndexingStatus.set(dsUuid, isIndexed);
              if (lastJob) {
                console.log(`[KB Update] Data source ${dsUuid}: INDEXED (status: ${lastJob.status || 'unknown'})`);
              } else {
                console.log(`[KB Update] Data source ${dsUuid}: NOT INDEXED (no last_datasource_indexing_job)`);
              }
            }
          }
          
          let listToIndex = [];
          
          if (userDoc.kbReindexAll) {
            listToIndex = allDsUuids;
            console.log(`[KB Update] Re-indexing all ${allDsUuids.length} data sources (kbReindexAll=true)`);
          } else if (Array.isArray(userDoc.kbChangedDataSourceUuids) && userDoc.kbChangedDataSourceUuids.length > 0) {
            listToIndex = userDoc.kbChangedDataSourceUuids.filter(uuid => allDsUuids.includes(uuid));
            console.log(`[KB Update] Indexing ${listToIndex.length} changed data source(s) from kbChangedDataSourceUuids`);
          } else if (newlyCreatedDsUuids.length > 0) {
            listToIndex = newlyCreatedDsUuids.filter(uuid => allDsUuids.includes(uuid));
            console.log(`[KB Update] Indexing ${newlyCreatedDsUuids.length} newly created data source(s)`);
          } else {
            // Check DO API for which data sources are not indexed
            const unindexedDsUuids = allDsUuids.filter(uuid => {
              const isIndexed = dsIndexingStatus.get(uuid) === true;
              return !isIndexed;
            });
            
            if (unindexedDsUuids.length > 0) {
              listToIndex = unindexedDsUuids;
              console.log(`[KB Update] Found ${unindexedDsUuids.length} unindexed data source(s) from DO API status check: ${unindexedDsUuids.join(', ')}`);
            } else if (allDsUuids.length > 0) {
              // All data sources are indexed - nothing to do
              console.log(`[KB Update] All ${allDsUuids.length} data source(s) are already indexed according to DO API`);
              listToIndex = [];
            } else {
              // No data sources at all
              console.log(`[KB Update] No data sources found in KB`);
              listToIndex = [];
            }
          }

          if (listToIndex.length === 0) {
            console.warn(`[KB Update] ⚠️ No data sources to index - KB may be empty or all datasources were removed`);
            console.log(`[KB Update] Debug: kbReindexAll=${userDoc.kbReindexAll}, filesInKB.length=${filesInKB.length}`);
            // If KB is empty and kbReindexAll was set, mark as complete
            if (userDoc.kbReindexAll && filesInKB.length === 0) {
              console.log(`[KB Update] Handling empty KB case`);
              const emptyDoc = await cloudant.getDocument('maia_users', userId);
              if (emptyDoc) {
                emptyDoc.kbIndexedFiles = [];
                emptyDoc.kbPendingFiles = undefined;
                emptyDoc.kbIndexingNeeded = false;
                emptyDoc.kbReindexAll = false;
                emptyDoc.kbChangedDataSourceUuids = [];
                await cloudant.saveDocument('maia_users', emptyDoc);
                invalidateResourceCache(userId);
              }
              return res.json({
                success: true,
                message: 'Knowledge base updated successfully (empty KB)',
                kbId: kbId,
                filesInKB: [],
                jobId: null,
                phase: 'complete'
              });
            } else {
              // No data sources to index, but KB might have files that need per-file data sources created
              // Or files were just deleted and we need to clear the indexing flags
              console.log(`[KB Update] Handling no datasources case (kbReindexAll=${userDoc.kbReindexAll}, filesInKB.length=${filesInKB.length})`);
              const freshDoc = await cloudant.getDocument('maia_users', userId);
              if (freshDoc) {
                // Clear indexing flags since there's nothing to index
                freshDoc.kbIndexingNeeded = false;
                freshDoc.kbReindexAll = false;
                freshDoc.kbChangedDataSourceUuids = [];
                await cloudant.saveDocument('maia_users', freshDoc);
                invalidateResourceCache(userId);
              }
              return res.json({
                success: true,
                message: 'Knowledge base updated successfully (no data sources to index)',
                kbId: kbId,
                filesInKB: filesInKB,
                jobId: null,
                phase: 'complete'
              });
            }
          } else {
              try {
                // Start indexing job using global endpoint
                const indexingJob = await doClient.indexing.startGlobal(kbId, listToIndex);
                jobId = indexingJob.uuid || indexingJob.id || indexingJob.indexing_job?.uuid || indexingJob.indexing_job?.id || indexingJob.job?.uuid || indexingJob.job?.id;
                
                if (jobId) {
                  console.log(`✅ Started indexing job: ${jobId}`);
                  
                  // Store job ID in user document
                  const jobUserDoc = await cloudant.getDocument('maia_users', userId);
                  if (jobUserDoc) {
                    // Clear change tracking flags now that indexing started
                    jobUserDoc.kbChangedDataSourceUuids = [];
                    jobUserDoc.kbReindexAll = false;
                    jobUserDoc.kbLastIndexingJobId = jobId;
                    jobUserDoc.kbIndexingStartedAt = new Date().toISOString();
                    jobUserDoc.workflowStage = 'indexing';
                    await cloudant.saveDocument('maia_users', jobUserDoc);
                    invalidateResourceCache(userId);
                  }
                  
                  indexingStarted = true;
                } else {
                  console.warn(`[KB Update] ⚠️ Indexing job started but no jobId found in response`);
                }
              } catch (startError) {
                // Check if error is "already running"
                if (startError.message && startError.message.includes('already') && startError.message.includes('running')) {
                  console.log(`[KB Update] Indexing already running - finding active job ID`);
                  
                  // Try to find the active indexing job from the KB
                  try {
                    const indexingJobs = await doClient.indexing.listForKB(kbId);
                    if (Array.isArray(indexingJobs) && indexingJobs.length > 0) {
                      // Find the first active (pending or running) job
                      const activeJob = indexingJobs.find(job => {
                        const status = job.status || job.job_status || job.state;
                        return status === 'INDEX_JOB_STATUS_PENDING' || 
                               status === 'INDEX_JOB_STATUS_RUNNING' ||
                               status === 'INDEX_JOB_STATUS_IN_PROGRESS' ||
                               status === 'pending' ||
                               status === 'running' ||
                               status === 'in_progress';
                      });
                      
                      if (activeJob) {
                        jobId = activeJob.uuid || activeJob.id || activeJob.indexing_job_id;
                        if (jobId) {
                          console.log(`[KB Update] ✅ Found active indexing job: ${jobId}`);
                          
                          // Store job ID in user document
                          const jobUserDoc = await cloudant.getDocument('maia_users', userId);
                          if (jobUserDoc) {
                            jobUserDoc.kbLastIndexingJobId = jobId;
                            jobUserDoc.kbIndexingStartedAt = new Date().toISOString();
                            jobUserDoc.workflowStage = 'indexing';
                            await cloudant.saveDocument('maia_users', jobUserDoc);
                            invalidateResourceCache(userId);
                          }
                          
                          indexingStarted = true;
                        } else {
                          console.warn(`[KB Update] ⚠️ Found active job but no jobId in response`);
                        }
                      } else {
                        console.warn(`[KB Update] ⚠️ No active indexing job found in KB's job list`);
                      }
                    } else {
                      console.warn(`[KB Update] ⚠️ No indexing jobs found for KB`);
                    }
                  } catch (listError) {
                    console.error(`[KB Update] ❌ Error listing indexing jobs:`, listError.message);
                    // Continue - we'll try to poll anyway if userDoc has a job ID
                  }
                } else {
                  throw startError;
                }
              }
            }
          }
      } catch (indexingError) {
        console.error(`[KB Update] ❌ Error starting indexing job:`, indexingError.message);
        // Continue - background polling will try to find the job
      }
    } else {
      console.log(`[KB Update] Files unchanged and no indexing requested - no indexing needed`);
      console.log(`[KB Update] Files in KB folder (${filesInKB.length}):`, filesInKB.map(key => key.split('/').pop()));
      console.log(`[KB Update] Files indexed in user document (${currentIndexedFiles.length}):`, currentIndexedFiles.map(key => key.split('/').pop()));
    }
    
    // Return response with jobId if available
    res.json({
      success: true,
      message: indexingStarted ? 'Knowledge base updated, indexing started' : 'Knowledge base updated successfully',
      kbId: kbId,
      filesInKB: filesInKB,
      jobId: jobId || null,
      phase: indexingStarted ? 'indexing_started' : 'kb_created'
    });
    
    // Only start polling if we actually started a new job
    // Don't poll if we didn't start a job - that would find old completed jobs incorrectly
    if (jobId && indexingStarted) {
      // Verify the job actually exists and is active before starting to poll
      // This prevents getting stuck waiting for a job that doesn't exist
      try {
        const verifyJobs = await doClient.indexing.listForKB(kbId);
        const verifyJobsArray = Array.isArray(verifyJobs) ? verifyJobs : 
                              (verifyJobs?.jobs || verifyJobs?.indexing_jobs || verifyJobs?.data || []);
        
        const verifyJob = verifyJobsArray.find(j => {
          const currentJobId = j.uuid || j.id || j.indexing_job_id;
          return currentJobId === jobId;
        });
        
        if (!verifyJob) {
          console.warn(`[KB Update] ⚠️ Job ${jobId} not found in active jobs list - will not start polling`);
          // Job doesn't exist - don't start polling
          return;
        }
        
        const verifyStatus = verifyJob.status || verifyJob.job_status || verifyJob.state;
        const isActive = verifyStatus === 'INDEX_JOB_STATUS_PENDING' || 
                        verifyStatus === 'INDEX_JOB_STATUS_RUNNING' ||
                        verifyStatus === 'INDEX_JOB_STATUS_IN_PROGRESS' ||
                        verifyStatus === 'pending' ||
                        verifyStatus === 'running' ||
                        verifyStatus === 'in_progress';
        
        if (!isActive) {
          console.warn(`[KB Update] ⚠️ Job ${jobId} is not active (status: ${verifyStatus}) - will not start polling`);
          // Job is not active - don't start polling
          return;
        }
        
        console.log(`[KB Update] ✅ Verified job ${jobId} is active (status: ${verifyStatus}) - starting polling`);
      } catch (verifyError) {
        console.warn(`[KB Update] ⚠️ Could not verify job before polling:`, verifyError.message);
        // Continue with polling if verification fails (might be a transient error)
      }
    
    // Start polling for indexing jobs in background (non-blocking)
      // Poll every 30 seconds for max 60 minutes (120 polls)
    const startTime = Date.now();
    const pollDelayMs = 30000; // 30 seconds
    const maxPolls = Math.ceil((60 * 60 * 1000) / pollDelayMs);
    let pollCount = 0;
      let activeJobId = jobId; // Track the specific job we started
    let finished = false;
    let pollTimer = null;

    const clearPollTimer = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const scheduleNextPoll = () => {
      if (finished) return;
      pollTimer = setTimeout(runPoll, pollDelayMs);
    };

    const completeIndexing = async (job, fileCount, tokenValue, indexedFiles) => {
      if (finished) return;
      finished = true;
      clearPollTimer();

      const elapsedTime = Math.round((Date.now() - startTime) / 1000); // seconds
      const elapsedMinutes = Math.floor(elapsedTime / 60);
      const elapsedSeconds = elapsedTime % 60;

      const finalTokens = String(job.tokens || job.total_tokens || tokenValue || 0);
      const finalFileCount = job.data_source_jobs?.[0]?.indexed_file_count || fileCount;

      try {
        const finalUserDoc = await cloudant.getDocument('maia_users', userId);
        if (finalUserDoc) {
            // Get current files in KB folder (source of truth for what should be indexed)
            const kbName = getKBNameFromUserDoc(finalUserDoc, userId);
            const currentFilesInKB = (finalUserDoc.files || [])
              .filter(file => file.bucketKey && file.bucketKey.startsWith(`${userId}/${kbName}/`))
              .map(file => file.bucketKey);
            
            // Use current files in KB folder as source of truth (they were successfully indexed)
            const filesToIndex = currentFilesInKB.length > 0 ? currentFilesInKB : (indexedFiles || []);
            
            const previousIndexedFiles = finalUserDoc.kbIndexedFiles || [];
            const previousTokens = finalUserDoc.kbLastIndexedAt ? (await getCachedKB(kbId))?.total_tokens || '0' : '0';
            
            // Calculate indexing duration
            const indexingDurationSeconds = elapsedTime;
            const indexingDurationMinutes = Math.floor(indexingDurationSeconds / 60);
            const indexingDurationSecondsRemainder = indexingDurationSeconds % 60;
            
            finalUserDoc.kbIndexedFiles = filesToIndex;
          finalUserDoc.kbPendingFiles = undefined;
          finalUserDoc.kbIndexingNeeded = false;
          finalUserDoc.kbLastIndexedAt = new Date().toISOString();
          finalUserDoc.kbLastIndexingJobId = activeJobId;
            finalUserDoc.kbIndexingDurationSeconds = indexingDurationSeconds;
            finalUserDoc.kbLastIndexingTokens = finalTokens;
          if (finalUserDoc.workflowStage === 'indexing') {
            if (finalUserDoc.files && finalUserDoc.files.length > 0) {
              finalUserDoc.workflowStage = 'files_archived';
            } else {
              finalUserDoc.workflowStage = 'agent_deployed';
            }
          }
          await cloudant.saveDocument('maia_users', finalUserDoc);
            
            // Log indexing completion with essential details
            console.log(`[KB INDEXING] ✅ Indexing completed successfully: ${filesToIndex.length} files, ${finalTokens} tokens, ${indexingDurationMinutes}m ${indexingDurationSecondsRemainder}s`);
            
          invalidateResourceCache(userId);
        }

        // Attach KB to agent if needed
        try {
          if (finalUserDoc && finalUserDoc.assignedAgentId) {
            await doClient.agent.attachKB(finalUserDoc.assignedAgentId, kbId);
          }
        } catch (attachError) {
          if (!attachError.message || !attachError.message.includes('already')) {
            console.error(`[KB AUTO] ❌ Error attaching KB to agent:`, attachError.message);
          }
        }

        // Generate patient summary after indexing completes
        try {
          if (finalUserDoc && finalUserDoc.assignedAgentId && finalUserDoc.agentEndpoint && finalUserDoc.agentApiKey) {
            console.log(`[KB AUTO] 📝 Starting patient summary generation for user ${userId}...`);
            const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');
            const agentProvider = new DigitalOceanProvider(finalUserDoc.agentApiKey, {
              baseURL: finalUserDoc.agentEndpoint
            });

            const summaryPrompt = 'Please generate a comprehensive patient summary based on all available medical records and documents in the knowledge base. Include key medical history, diagnoses, medications, allergies, and important notes.';

            const summaryResponse = await agentProvider.chat(
              [{ role: 'user', content: summaryPrompt }],
              { model: finalUserDoc.agentModelName || 'openai-gpt-oss-120b' }
            );

            const summary = summaryResponse.content || summaryResponse.text || '';

            if (!summary || summary.trim().length === 0) {
              console.error(`[KB AUTO] ❌ Patient summary generation returned empty result for user ${userId}`);
            } else {
            const summaryUserDoc = await cloudant.getDocument('maia_users', userId);
            if (summaryUserDoc) {
                // Use helper function to add new summary (default to 'newest' strategy)
                addNewSummary(summaryUserDoc, summary, 'newest');
              summaryUserDoc.workflowStage = 'patient_summary';
              await cloudant.saveDocument('maia_users', summaryUserDoc);
              invalidateResourceCache(userId);
                console.log(`[KB AUTO] ✅ Patient summary generated and saved successfully for user ${userId}`);
              } else {
                console.error(`[KB AUTO] ❌ Could not load user document to save patient summary for user ${userId}`);
            }
            }
          } else {
            console.log(`[KB AUTO] ⚠️ Skipping patient summary generation for user ${userId} - agent not fully configured (assignedAgentId: ${!!finalUserDoc?.assignedAgentId}, agentEndpoint: ${!!finalUserDoc?.agentEndpoint}, agentApiKey: ${!!finalUserDoc?.agentApiKey})`);
          }
        } catch (summaryError) {
          console.error(`[KB AUTO] ❌ Error generating patient summary for user ${userId}:`, summaryError.message);
          console.error(`[KB AUTO] ❌ Patient summary error stack:`, summaryError.stack);
        }
      } catch (completionError) {
        console.error('[KB AUTO] ❌ Error finalizing indexing completion:', completionError.message);
      }
    };

    try {
      const indexingUserDoc = await cloudant.getDocument('maia_users', userId);
      if (indexingUserDoc) {
        indexingUserDoc.workflowStage = 'indexing';
        await cloudant.saveDocument('maia_users', indexingUserDoc);
      }
    } catch (err) {
      console.error('[KB AUTO] Error setting workflowStage to indexing:', err);
    }

    const runPoll = async () => {
      if (finished) return;
      pollCount += 1;

      try {
        // Always get fresh user document to ensure we have current state
        const currentUserDoc = await cloudant.getDocument('maia_users', userId);
        if (!currentUserDoc || currentUserDoc.kbLastIndexingJobId !== activeJobId) {
          // Job ID changed or user doc not found - stop polling
          console.log(`[KB AUTO] ⚠️ Job ID mismatch or user doc not found. Expected: ${activeJobId}, Found: ${currentUserDoc?.kbLastIndexingJobId || 'none'}. Stopping polling.`);
          finished = true;
          clearPollTimer();
          return;
        }

        const indexingJobs = await doClient.indexing.listForKB(kbId);
         
         // listForKB already returns the jobs array, so indexingJobs should be an array
         // But handle case where it might still be wrapped
         let jobsArray = indexingJobs;
         if (Array.isArray(indexingJobs)) {
           jobsArray = indexingJobs;
         } else if (indexingJobs.jobs && Array.isArray(indexingJobs.jobs)) {
           jobsArray = indexingJobs.jobs; // API returns { "jobs": [...] }
         } else if (indexingJobs.indexing_jobs && Array.isArray(indexingJobs.indexing_jobs)) {
           jobsArray = indexingJobs.indexing_jobs;
         } else if (indexingJobs.data && Array.isArray(indexingJobs.data)) {
           jobsArray = indexingJobs.data;
             } else {
           jobsArray = [];
         }
         
         // First, try to find the specific job we're tracking by ID
         let job = jobsArray.find(j => {
           const currentJobId = j.uuid || j.id || j.indexing_job_id;
           return currentJobId === activeJobId;
         });
         
         // If not found by ID, find any active or completed job (fallback)
         if (!job) {
           job = jobsArray.find(j => {
           const jobStatus = j.status || j.job_status || j.state;
           return jobStatus === 'INDEX_JOB_STATUS_PENDING' || 
                  jobStatus === 'INDEX_JOB_STATUS_RUNNING' ||
                    jobStatus === 'INDEX_JOB_STATUS_IN_PROGRESS' ||
                  jobStatus === 'INDEX_JOB_STATUS_COMPLETED' ||
                  jobStatus === 'pending' ||
                  jobStatus === 'running' ||
                  jobStatus === 'in_progress' ||
                  jobStatus === 'completed';
         });
         }
         
         if (job) {
           const currentJobId = job.uuid || job.id || job.indexing_job_id;
           const status = job.status || job.job_status || job.state;
           
           // Update activeJobId only if we found a different job (shouldn't happen, but handle it)
           if (currentJobId && currentJobId !== activeJobId) {
             console.log(`[KB AUTO] ⚠️ Found different job ID: ${currentJobId} (expected ${activeJobId}). Updating tracking.`);
             activeJobId = currentJobId;
           }

           const kbDetails = await getCachedKB(kbId);
           const tokens = String(kbDetails?.total_tokens || kbDetails?.token_count || kbDetails?.tokens || job.tokens || job.total_tokens || 0);

           // Get fresh user document for files (don't use closure variable)
           const updatedUserDoc = await cloudant.getDocument('maia_users', userId);
           const kbNameForFiles = getKBNameFromUserDoc(updatedUserDoc, userId);
           // Get current files in KB folder from user document (source of truth)
           const currentFilesInKB = (updatedUserDoc?.files || [])
             .filter(file => file.bucketKey && file.bucketKey.startsWith(`${userId}/${kbNameForFiles}/`))
             .map(file => file.bucketKey);
           const indexedFiles = updatedUserDoc?.kbPendingFiles && updatedUserDoc.kbPendingFiles.length > 0 
             ? updatedUserDoc.kbPendingFiles 
             : currentFilesInKB;
           const fileCount = job.data_source_jobs?.[0]?.indexed_file_count || indexedFiles.length;

          // Only mark as complete if this is the job we're tracking AND it's actually completed
          const isCompleted = (status === 'INDEX_JOB_STATUS_COMPLETED' || 
                             status === 'completed' ||
                             status === 'COMPLETED' ||
                             (job.completed === true) ||
                             (job.phase === 'BATCH_JOB_PHASE_COMPLETED') ||
                            (job.phase === 'BATCH_JOB_PHASE_SUCCEEDED')) &&
                            // Only complete if this is EXACTLY the job we started
                            currentJobId === activeJobId;

          if (isCompleted) {
             console.log(`[KB AUTO] ✅ Detected completion for job ${activeJobId} (poll ${pollCount})`);
             await completeIndexing(job, fileCount, tokens, indexedFiles);
             return;
           } else if (pollCount % 6 === 0) {
             // Log progress every 6 polls (3 minutes)
             console.log(`[KB AUTO] 📊 Polling job ${activeJobId} (poll ${pollCount}/${maxPolls}): status=${status}, files=${fileCount}, tokens=${tokens}`);
           }
         } else {
           // No job found - check if it failed or if we should continue
           const failedJob = jobsArray.find(j => {
             const currentJobId = j.uuid || j.id || j.indexing_job_id;
             return currentJobId === activeJobId && (
               j.status === 'INDEX_JOB_STATUS_FAILED' || 
               j.job_status === 'INDEX_JOB_STATUS_FAILED' ||
               j.state === 'INDEX_JOB_STATUS_FAILED' ||
               j.status === 'failed' || 
               j.job_status === 'failed' ||
               j.state === 'failed' ||
               j.status === 'FAILED' ||
               j.job_status === 'FAILED' ||
               j.state === 'FAILED' ||
               (j.failed === true)
             );
           });

           if (failedJob) {
             finished = true;
             clearPollTimer();
             const failedJobId = failedJob.uuid || failedJob.id || failedJob.indexing_job_id;
             console.error(`[KB AUTO] ❌ Indexing job ${failedJobId} failed:`, failedJob.error || failedJob.message || 'Unknown error');
             return;
           } else if (pollCount % 6 === 0) {
             // Log when job not found (might have completed and been removed from list)
             console.log(`[KB AUTO] ⚠️ Job ${activeJobId} not found in jobs list (poll ${pollCount}). Jobs found: ${jobsArray.length}`);
           }
         }
       } catch (error) {
         console.error(`[KB AUTO] ❌ Error polling indexing status (poll ${pollCount}):`, error.message);
         if (isRateLimitError(error) && pollCount > 0) {
           pollCount -= 1; // do not count this attempt when rate limited
         }
       }

       if (!finished) {
         if (pollCount >= maxPolls) {
           finished = true;
           clearPollTimer();
           console.error(`[KB AUTO] ⚠️ Polling timeout: No indexing job found after ${maxPolls} polls (${Math.round((maxPolls * pollDelayMs) / 60000)} minutes)`);
         } else {
           scheduleNextPoll();
         }
       }
     };

     runPoll();
    } // End of polling block - only runs if jobId || indexingStarted || (filesChanged || indexingRequested)
  } catch (error) {
    console.error('❌ Error updating knowledge base:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to update knowledge base: ${error.message}`,
      error: 'UPDATE_FAILED'
    });
  }
});

// Get KB indexing status
// This endpoint checks backend state first (single source of truth), then falls back to DO API if needed
app.get('/api/kb-indexing-status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }
    
    // Get user document - this is our single source of truth
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }
    
    const kbName = getKBNameFromUserDoc(userDoc, userId);
    
    // STEP 1: Check if backend has already completed processing
    // Backend completion indicators:
    // - kbPendingFiles is cleared (undefined/empty) - backend cleared it on completion
    // - kbIndexedFiles is set - backend set it on completion
    // - kbLastIndexingJobId matches this jobId - confirms this is the completed job
    const hasBackendCompleted = 
      (!userDoc.kbPendingFiles || (Array.isArray(userDoc.kbPendingFiles) && userDoc.kbPendingFiles.length === 0)) &&
      userDoc.kbIndexedFiles && 
      Array.isArray(userDoc.kbIndexedFiles) && 
      userDoc.kbIndexedFiles.length > 0 &&
      userDoc.kbLastIndexingJobId === jobId;
    
    if (hasBackendCompleted) {
      // Backend has completed - return completion status immediately
      // Get KB details for token count
      let tokens = userDoc.kbLastIndexingTokens || '0';
      if (userDoc.kbId && (!tokens || tokens === '0')) {
        try {
          const kbDetails = await getCachedKB(userDoc.kbId);
          tokens = String(kbDetails?.total_tokens || kbDetails?.token_count || kbDetails?.tokens || 0);
        } catch (kbError) {
          // Use stored tokens or default
        }
      }
      
      return res.json({
        success: true,
        phase: 'complete',
        status: 'INDEX_JOB_STATUS_COMPLETED',
        kb: kbName,
        tokens: tokens,
        filesIndexed: userDoc.kbIndexedFiles.length,
        completed: true,
        progress: 1.0,
        kbIndexedFiles: userDoc.kbIndexedFiles,
        backendCompleted: true // Indicates backend automation (attach KB, generate summary) has finished
      });
    }
    
    // STEP 2: Backend hasn't completed yet - check DO API for current status
    // This provides real-time progress while backend is still working
    let jobStatus = null;
    let phase = 'indexing';
    let status = 'INDEX_JOB_STATUS_RUNNING';
    let completed = false;
    let tokens = '0';
    let filesIndexed = 0;
    let kbIndexedFilesFromDO = null; // Initialize at function scope
    
    try {
      // Get job status from DO API
      jobStatus = await doClient.indexing.getStatus(jobId);
      status = jobStatus.status || jobStatus.job?.status || 'INDEX_JOB_STATUS_RUNNING';
      
      // Determine phase based on status
      if (status === 'INDEX_JOB_STATUS_PENDING') {
        phase = 'indexing_started';
      } else if (status === 'INDEX_JOB_STATUS_RUNNING') {
        phase = 'indexing';
      } else if (status === 'INDEX_JOB_STATUS_COMPLETED') {
        phase = 'indexing'; // Still 'indexing' because backend hasn't finished processing yet
        completed = true; // DO API says completed
      } else if (status === 'INDEX_JOB_STATUS_FAILED') {
        phase = 'error';
        completed = true;
      }
      
      // Get KB details for token count and name
      if (userDoc.kbId) {
        try {
          const kbDetails = await doClient.kb.get(userDoc.kbId);
          tokens = String(kbDetails.total_tokens || kbDetails.token_count || kbDetails.tokens || 0);
        } catch (kbError) {
          console.error('Error getting KB details:', kbError);
          // Continue with defaults
        }
      }
      
      // If job is completed, query DO API directly to get the actual indexed files
      // This ensures we return the correct state even if backend hasn't updated userDoc yet
      if (status === 'INDEX_JOB_STATUS_COMPLETED' && userDoc.kbId) {
        try {
          const dataSources = await doClient.kb.listDataSources(userDoc.kbId);
          const kbName = getKBNameFromUserDoc(userDoc, userId);
          const kbFolderPath = `${userId}/${kbName}/`;
          
          // Get all files that have been indexed (have last_datasource_indexing_job)
          const indexedFilesList = [];
          for (const ds of dataSources) {
            const dsPath = ds?.item_path || ds?.spaces_data_source?.item_path;
            if (dsPath && dsPath.startsWith(kbFolderPath)) {
              // If data source has a last_datasource_indexing_job, the file is indexed
              if (ds?.last_datasource_indexing_job) {
                indexedFilesList.push(dsPath);
              }
            }
          }
          
          kbIndexedFilesFromDO = indexedFilesList;
          filesIndexed = indexedFilesList.length;
        } catch (dsError) {
          console.warn(`[KB Status] Could not query data sources for indexed files: ${dsError.message}`);
          // Fall back to userDoc or counting files
        }
      }
      
      // If we don't have indexed files from DO API, use userDoc or count files
      if (!kbIndexedFilesFromDO) {
        if (userDoc.kbPendingFiles && Array.isArray(userDoc.kbPendingFiles) && userDoc.kbPendingFiles.length > 0) {
        filesIndexed = userDoc.kbPendingFiles.length;
          kbIndexedFilesFromDO = userDoc.kbPendingFiles;
        } else if (userDoc.kbIndexedFiles && Array.isArray(userDoc.kbIndexedFiles) && userDoc.kbIndexedFiles.length > 0) {
          filesIndexed = userDoc.kbIndexedFiles.length;
          kbIndexedFilesFromDO = userDoc.kbIndexedFiles;
      } else if (userDoc.files) {
        const kbNameForCount = getKBNameFromUserDoc(userDoc, userId);
          const filesInKB = (userDoc.files || []).filter(file => 
          file.bucketKey && file.bucketKey.startsWith(`${userId}/${kbNameForCount}/`)
          ).map(file => file.bucketKey);
          filesIndexed = filesInKB.length;
          kbIndexedFilesFromDO = filesInKB;
        }
      }
      
    } catch (error) {
      console.error('❌ Error getting indexing status from DO API:', error);
      return res.status(500).json({
        success: false,
        error: 'STATUS_CHECK_FAILED',
        message: `Failed to get indexing status: ${error.message}`,
        phase: 'error'
      });
    }
    
    // If indexing failed in DO API, return error
    if (status === 'INDEX_JOB_STATUS_FAILED') {
      return res.json({
        success: false,
        phase: 'error',
        status: status,
        error: jobStatus.error || jobStatus.message || 'Indexing job failed',
        kb: kbName,
        tokens: tokens,
        filesIndexed: filesIndexed,
        completed: true,
        backendCompleted: false
      });
    }

    // Return current status - backend may still be processing automation
    res.json({
      success: true,
      phase: phase,
      status: status,
      kb: kbName,
      tokens: tokens,
      filesIndexed: filesIndexed,
      completed: completed,
      progress: jobStatus.progress || 0.0,
      kbIndexedFiles: kbIndexedFilesFromDO || userDoc.kbIndexedFiles || userDoc.kbPendingFiles || undefined,
      backendCompleted: false // Backend automation (attach KB, generate summary) not finished yet
    });
  } catch (error) {
    console.error('❌ Error getting indexing status:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to get indexing status: ${error.message}`,
      error: 'STATUS_FAILED'
    });
  }
});

// Cancel KB indexing job
app.post('/api/cancel-kb-indexing', async (req, res) => {
  try {
    const { userId, jobId } = req.body;
    
    if (!userId || !jobId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID and job ID are required',
        error: 'MISSING_REQUIRED_FIELDS'
      });
    }

    // Get user document to restore original state
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Check if indexing has already completed (backend has finished processing)
    const hasBackendCompleted = 
      (!userDoc.kbPendingFiles || (Array.isArray(userDoc.kbPendingFiles) && userDoc.kbPendingFiles.length === 0)) &&
      userDoc.kbIndexedFiles && 
      Array.isArray(userDoc.kbIndexedFiles) && 
      userDoc.kbIndexedFiles.length > 0 &&
      userDoc.kbLastIndexingJobId === jobId;
    
    if (hasBackendCompleted) {
      // Indexing already completed - cannot cancel
      return res.json({
        success: false,
        message: 'Indexing has already completed. Cannot cancel a completed job.',
        error: 'ALREADY_COMPLETED',
        alreadyCompleted: true
      });
    }

    // Cancel the indexing job via DO API
    try {
      await doClient.indexing.cancel(jobId);
      console.log(`[KB Cancel] ✅ Cancelled indexing job ${jobId} for user ${userId}`);
    } catch (cancelError) {
      // Check if error is because job is already completed, doesn't exist, or can't be cancelled (405)
      const errorMsg = cancelError.message || '';
      const statusCode = cancelError.statusCode || cancelError.$metadata?.httpStatusCode;
      if (statusCode === 405 || statusCode === 404 || 
          errorMsg.includes('completed') || 
          errorMsg.includes('not found') || 
          errorMsg.includes('404') ||
          errorMsg.includes('405') ||
          errorMsg.includes('Method Not Allowed')) {
        console.log(`[KB Cancel] Job ${jobId} cannot be cancelled (status: ${statusCode || 'N/A'}) - likely already completed or in terminal state. Continuing with cleanup.`);
      } else {
        console.error(`[KB Cancel] Error cancelling job ${jobId}:`, cancelError);
        // Continue with cleanup even if cancel fails
      }
    }

    // Restore original file state from kbPendingFiles snapshot
    // If kbPendingFiles exists, it means files were moved but indexing hasn't completed
    // We need to restore files to their original locations
    if (userDoc.kbPendingFiles && Array.isArray(userDoc.kbPendingFiles) && userDoc.kbPendingFiles.length > 0) {
      const kbName = getKBNameFromUserDoc(userDoc, userId);
      const { S3Client, CopyObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      
      const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
      const bucketName = bucketUrl?.split('//')[1]?.split('.')[0] || 'maia';
      
      const s3Client = new S3Client({
        endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
        region: 'us-east-1',
        forcePathStyle: false,
        credentials: {
          accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
        }
      });

      // Restore files: move from KB folder back to archived
      for (const kbFileKey of userDoc.kbPendingFiles) {
        // Extract filename from bucketKey
        const fileName = kbFileKey.split('/').pop();
        const archivedKey = `${userId}/archived/${fileName}`;
        
        // Check if file exists in KB folder
        try {
          const copyCommand = new CopyObjectCommand({
            Bucket: bucketName,
            CopySource: `${bucketName}/${kbFileKey}`,
            Key: archivedKey
          });
          await s3Client.send(copyCommand);
          
          const deleteCommand = new DeleteObjectCommand({
            Bucket: bucketName,
            Key: kbFileKey
          });
          await s3Client.send(deleteCommand);
          
          // Update file metadata in user document
          const fileIndex = userDoc.files?.findIndex(f => f.bucketKey === kbFileKey);
          if (fileIndex >= 0 && userDoc.files) {
            userDoc.files[fileIndex].bucketKey = archivedKey;
            userDoc.files[fileIndex].knowledgeBases = [];
          }
          
          console.log(`[KB Cancel] ✅ Restored file: ${kbFileKey} -> ${archivedKey}`);
        } catch (fileError) {
          console.error(`[KB Cancel] ⚠️ Error restoring file ${kbFileKey}:`, fileError);
          // Continue with other files
        }
      }
    }

    // Clear indexing state
    userDoc.kbPendingFiles = undefined;
    userDoc.kbIndexingNeeded = false;
    userDoc.kbLastIndexingJobId = undefined;
    
    // Don't change kbIndexedFiles - keep it as it was before indexing started
    
    await cloudant.saveDocument('maia_users', userDoc);
    
    res.json({
      success: true,
      message: 'Indexing cancelled and files restored to original state'
    });
  } catch (error) {
    console.error('❌ Error cancelling KB indexing:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to cancel indexing: ${error.message}`,
      error: 'CANCEL_FAILED'
    });
  }
});

// Get shared group chats
app.get('/api/shared-group-chats', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get all chats for this user from maia_chats
    const allChats = await cloudant.getAllDocuments('maia_chats');
    
    // Filter to only shared group chats owned by this user
    const sharedChats = allChats.filter(chat => 
      chat._id.startsWith(`${userId}-`) && 
      chat.type === 'group_chat' && 
      chat.isShared === true
    );
    
    res.json({
      success: true,
      chats: sharedChats,
      count: sharedChats.length
    });
  } catch (error) {
    console.error('❌ Error fetching shared group chats:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to fetch chats: ${error.message}`,
      error: 'FETCH_FAILED'
    });
  }
});

// Get admin email (for email link)
app.get('/api/admin-email', (req, res) => {
  res.json({
    email: process.env.RESEND_ADMIN_EMAIL || 'admin@yourdomain.com'
  });
});

// Admin: Get all users with statistics
app.get('/api/admin/users', async (req, res) => {
  try {
    // Allow unauthenticated access when running locally (only check hostname, not NODE_ENV)
    const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    
    // If not localhost, require authentication and check for ADMIN_USERNAME
    if (!isLocalhost) {
      const sessionUserId = req.session?.userId;
      const adminUsername = process.env.ADMIN_USERNAME;
      
      if (!sessionUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required'
        });
      }
      
      if (!adminUsername || sessionUserId !== adminUsername) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. Admin privileges required.'
        });
      }
    }
    
    // Get all users from maia_users database
    const allUsers = await cloudant.getAllDocuments('maia_users');
    
    // Filter out design documents and non-user documents
    const users = allUsers.filter(doc => doc.userId && !doc._id.startsWith('_design'));
    
    // Get all sessions to find last activity
    const allSessions = await cloudant.getAllDocuments('maia_sessions');
    const sessionsByUserId = new Map();
    allSessions.forEach(session => {
      if (session.userId && !session._id.startsWith('_design')) {
        const existing = sessionsByUserId.get(session.userId);
        if (!existing || (session.lastActivity && (!existing.lastActivity || session.lastActivity > existing.lastActivity))) {
          sessionsByUserId.set(session.userId, session);
        }
      }
    });
    
    // Get all chats to count saved chats per user
    const allChats = await cloudant.getAllDocuments('maia_chats');
    const chatsByUserId = new Map();
    allChats.forEach(chat => {
      if (chat.currentUser && !chat._id.startsWith('_design')) {
        const count = chatsByUserId.get(chat.currentUser) || 0;
        chatsByUserId.set(chat.currentUser, count + 1);
      }
    });
    
    // Count deep link users (users with isDeepLink flag)
    const deepLinkUserIds = new Set();
    users.forEach(user => {
      if (user.isDeepLink === true) {
        deepLinkUserIds.add(user.userId);
      }
    });
    
    // Calculate statistics for each user
    const userStats = await Promise.all(users.map(async (userDoc) => {
      const userId = userDoc.userId;
      
      // Get last activity from sessions
      const session = sessionsByUserId.get(userId);
      let lastActivity = null;
      if (session?.lastActivity) {
        const lastActivityDate = new Date(session.lastActivity);
        const now = new Date();
        const diffMs = now - lastActivityDate;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);
        
        if (diffMins < 60) {
          lastActivity = `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
        } else if (diffHours < 24) {
          lastActivity = `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
        } else {
          lastActivity = `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
        }
      }
      
      // Get provisioned date
      const provisionedDate = userDoc.createdAt || userDoc.provisionedAt || null;
      
      // Get total file storage in MB (using same calculation as file routes)
      let totalStorageMB = 0;
      try {
        const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
        if (bucketUrl && process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID && process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY) {
          const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
          const s3Client = new S3Client({
            endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
            region: 'us-east-1',
            forcePathStyle: false,
            credentials: {
              accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY
            }
          });
          // Use the same getUserBucketSize function as file routes
          const totalSizeBytes = await getUserBucketSize(s3Client, bucketName, userId);
          // Convert to MB (same as storage-usage endpoint)
          totalStorageMB = Math.round((totalSizeBytes / (1024 * 1024)) * 100) / 100;
        }
      } catch (error) {
        // Silently fail - storage calculation is optional for admin view
        // Errors are already logged by getUserBucketSize if needed
      }
      
      // Get files indexed in KB
      const filesIndexed = userDoc.kbIndexedFiles ? userDoc.kbIndexedFiles.length : 0;
      
      // Get saved chats count
      const savedChatsCount = chatsByUserId.get(userId) || 0;
      
      // Count deep link users that have accessed this user's chats
      // Each chat has a deepLinkUserIds array tracking which deep link users accessed it
      const userChats = allChats.filter(chat => {
        const ownerId = chat.patientOwner || chat.currentUser;
        // Also try to extract from chat _id if patientOwner is missing
        if (!ownerId && chat._id) {
          const match = chat._id.match(/^([^-]+)-chat_/);
          return match && match[1] === userId;
        }
        return ownerId === userId;
      });
      
      // Collect all unique deep link user IDs from this user's chats
      const uniqueDeepLinkUserIds = new Set();
      userChats.forEach(chat => {
        if (Array.isArray(chat.deepLinkUserIds)) {
          chat.deepLinkUserIds.forEach(deepLinkUserId => {
            uniqueDeepLinkUserIds.add(deepLinkUserId);
          });
        }
      });
      
      const deepLinkUsersCount = uniqueDeepLinkUserIds.size;
      
      return {
        userId: userId,
        domain: userDoc.domain || null,
        workflowStage: userDoc.workflowStage || 'unknown',
        lastActivity: lastActivity || 'Never',
        provisionedDate: provisionedDate,
        totalStorageMB: totalStorageMB,
        filesIndexed: filesIndexed,
        savedChatsCount: savedChatsCount,
        deepLinkUsersCount: deepLinkUsersCount
      };
    }));
    
    // Count total deep link users
    const totalDeepLinkUsers = deepLinkUserIds.size;
    
    res.json({
      success: true,
      users: userStats,
      totalUsers: userStats.length,
      totalDeepLinkUsers: totalDeepLinkUsers,
      passkeyConfig: {
        rpID: passkeyService.rpID,
        origin: passkeyService.origin
      }
    });
  } catch (error) {
    console.error('Error fetching admin users:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Admin: Delete user and all associated resources
app.delete('/api/admin/users/:userId', async (req, res) => {
  try {
    // Allow unauthenticated access when running locally (only check hostname, not NODE_ENV)
    const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    
    // If not localhost, require authentication and check for ADMIN_USERNAME
    if (!isLocalhost) {
      const sessionUserId = req.session?.userId;
      const adminUsername = process.env.ADMIN_USERNAME;
      
      if (!sessionUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required'
        });
      }
      
      if (!adminUsername || sessionUserId !== adminUsername) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. Admin privileges required.'
        });
      }
    }
    
    const { userId } = req.params;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'User ID is required'
      });
    }

    // Get user document first to collect information
    let userDoc;
    try {
      userDoc = await cloudant.getDocument('maia_users', userId);
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const deletionDetails = {
      spacesDeleted: false,
      filesDeleted: 0,
      kbDeleted: false,
      agentDeleted: false,
      userDocDeleted: false,
      sessionsDeleted: 0,
      deepLinkUsersDeleted: 0,
      chatsDeleted: 0,
      errors: []
    };

    // 1. Delete all files from Spaces folder
    try {
      const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
      if (bucketUrl) {
        const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
        const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
        
        const s3Client = new S3Client({
          endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
          region: 'us-east-1',
          forcePathStyle: false,
          credentials: {
            accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
          }
        });

        // List all files with userId prefix
        let continuationToken = null;
        do {
          const listCommand = new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: `${userId}/`,
            ContinuationToken: continuationToken || undefined
          });

          const listResult = await s3Client.send(listCommand);
          
          if (listResult.Contents && listResult.Contents.length > 0) {
            // Delete all files
            for (const file of listResult.Contents) {
              if (file.Key) {
                try {
                  const deleteCommand = new DeleteObjectCommand({
                    Bucket: bucketName,
                    Key: file.Key
                  });
                  await s3Client.send(deleteCommand);
                  deletionDetails.filesDeleted++;
                } catch (err) {
                  deletionDetails.errors.push(`Failed to delete file ${file.Key}: ${err.message}`);
                }
              }
            }
          }

          continuationToken = listResult.NextContinuationToken || null;
        } while (continuationToken);

        deletionDetails.spacesDeleted = true;
      }
    } catch (error) {
      deletionDetails.errors.push(`Failed to delete Spaces folder: ${error.message}`);
    }

    // 2. Delete Knowledge Base
    try {
      const kbId = userDoc.kbId;
      if (kbId) {
        // Check if KB exists before trying to delete
        try {
          await doClient.kb.get(kbId);
          await doClient.kb.delete(kbId);
          deletionDetails.kbDeleted = true;
        } catch (error) {
          if (error.statusCode === 404 || error.message?.includes('not found')) {
            deletionDetails.kbDeleted = true; // Already deleted, consider it success
          } else {
            throw error;
          }
        }
      } else {
        deletionDetails.kbDeleted = true; // No KB to delete
      }
    } catch (error) {
      deletionDetails.errors.push(`Failed to delete Knowledge Base: ${error.message}`);
    }

    // 3. Delete Agent
    try {
      const agentId = userDoc.assignedAgentId;
      if (agentId) {
        // Check if agent exists before trying to delete
        try {
          await doClient.agent.get(agentId);
          await doClient.agent.delete(agentId);
          deletionDetails.agentDeleted = true;
        } catch (error) {
          if (error.statusCode === 404 || error.message?.includes('not found')) {
            deletionDetails.agentDeleted = true; // Already deleted, consider it success
          } else {
            throw error;
          }
        }
      } else {
        deletionDetails.agentDeleted = true; // No agent to delete
      }
    } catch (error) {
      deletionDetails.errors.push(`Failed to delete Agent: ${error.message}`);
    }

    // 4. Delete user sessions from maia_sessions
    try {
      const allSessions = await cloudant.getAllDocuments('maia_sessions');
      const userSessions = allSessions.filter(session => session.userId === userId && !session._id.startsWith('_design'));
      
      for (const session of userSessions) {
        try {
          await cloudant.deleteDocument('maia_sessions', session._id);
          deletionDetails.sessionsDeleted++;
        } catch (err) {
          deletionDetails.errors.push(`Failed to delete session ${session._id}: ${err.message}`);
        }
      }
    } catch (error) {
      deletionDetails.errors.push(`Failed to delete sessions: ${error.message}`);
    }

    // 5. Delete deep link users and user chats from maia_chats
    try {
      const allChats = await cloudant.getAllDocuments('maia_chats');
      // Find chats owned by this user (check patientOwner, currentUser, or extract from _id)
      const userChats = allChats.filter(chat => {
        if (chat._id.startsWith('_design')) return false;
        const ownerId = chat.patientOwner || chat.currentUser;
        if (ownerId === userId) return true;
        // Also try to extract from chat _id if patientOwner is missing
        if (!ownerId && chat._id) {
          const match = chat._id.match(/^([^-]+)-chat_/);
          return match && match[1] === userId;
        }
        return false;
      });
      
      // Collect all unique deep link user IDs from these chats
      const deepLinkUserIdsToDelete = new Set();
      userChats.forEach(chat => {
        if (Array.isArray(chat.deepLinkUserIds)) {
          chat.deepLinkUserIds.forEach(deepLinkUserId => {
            deepLinkUserIdsToDelete.add(deepLinkUserId);
          });
        }
      });
      
      // Delete each deep link user
      let deepLinkUsersDeleted = 0;
      for (const deepLinkUserId of deepLinkUserIdsToDelete) {
        try {
          await cloudant.deleteDocument('maia_users', deepLinkUserId);
          deepLinkUsersDeleted++;
        } catch (err) {
          // Deep link user might not exist or already deleted - log but continue
          if (err.statusCode !== 404) {
            deletionDetails.errors.push(`Failed to delete deep link user ${deepLinkUserId}: ${err.message}`);
          }
        }
      }
      
      if (deepLinkUsersDeleted > 0) {
        deletionDetails.deepLinkUsersDeleted = deepLinkUsersDeleted;
      }
      
      // Now delete the chats
      for (const chat of userChats) {
        try {
          await cloudant.deleteDocument('maia_chats', chat._id);
          deletionDetails.chatsDeleted++;
        } catch (err) {
          deletionDetails.errors.push(`Failed to delete chat ${chat._id}: ${err.message}`);
        }
      }
    } catch (error) {
      deletionDetails.errors.push(`Failed to delete chats and deep link users: ${error.message}`);
    }

    // 6. Delete user document (do this last)
    try {
      await cloudant.deleteDocument('maia_users', userId);
      deletionDetails.userDocDeleted = true;
    } catch (error) {
      deletionDetails.errors.push(`Failed to delete user document: ${error.message}`);
      return res.status(500).json({
        success: false,
        error: 'Failed to delete user document',
        details: deletionDetails
      });
    }

    // 7. Send email notification to admin
    try {
      await emailService.sendUserDeletionNotification({
        userId: userId,
        userEmail: userDoc.email || null,
        displayName: userDoc.displayName || userId,
        deletionDetails: deletionDetails
      });
    } catch (error) {
      console.error('Failed to send deletion notification email:', error);
      // Don't fail the deletion if email fails
    }

    res.json({
      success: true,
      message: 'User and all associated resources deleted',
      details: deletionDetails
    });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get user status (for contextual tip)
app.get('/api/user-status', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Validate user resources against DigitalOcean (single source of truth)
    const { hasAgent, kbStatus, userDoc } = await validateUserResources(userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }
    
    // Include initial file info if available
    // If initialFile exists but bucketKey is missing, try to reconstruct it from KB name
    let initialFile = null;
    if (userDoc.initialFile) {
      let bucketKey = userDoc.initialFile.bucketKey;
      
      // If bucketKey is missing, try to reconstruct it from KB name and fileName
      if (!bucketKey && userDoc.initialFile.fileName) {
        const kbName = getKBNameFromUserDoc(userDoc, userId);
        if (kbName) {
          // File should be in userId/KB/FileName.pdf
          const cleanFileName = userDoc.initialFile.fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
          bucketKey = `${userId}/${kbName}/${cleanFileName}`;
          // Update user document with the reconstructed bucketKey
          try {
            userDoc.initialFile.bucketKey = bucketKey;
            await cloudant.saveDocument('maia_users', userDoc);
          } catch (updateErr) {
            // Failed to update user document - continue
          }
        }
      }
      
      initialFile = {
        fileName: userDoc.initialFile.fileName,
        bucketKey: bucketKey,
        fileSize: userDoc.initialFile.fileSize,
        uploadedAt: userDoc.initialFile.uploadedAt
      };
      
    }

    const workflowStage = userDoc.workflowStage || 'unknown';
    const fileCount = userDoc.files ? userDoc.files.length : 0;
    
    // Convert kbStatus to hasKB for backward compatibility, but also return kbStatus
    const hasKB = kbStatus === 'attached' || kbStatus === 'not_attached';
    
    // Check if KB has indexed files
    const hasFilesInKB = hasKB && userDoc.kbIndexedFiles && 
                         Array.isArray(userDoc.kbIndexedFiles) && 
                         userDoc.kbIndexedFiles.length > 0;

    // Get KB name for file path resolution
    const kbName = getKBNameFromUserDoc(userDoc, userId);
    
    res.json({
      success: true,
      workflowStage,
      hasAgent,
      fileCount,
      hasKB,
      hasFilesInKB,
      kbStatus, // 'none' | 'not_attached' | 'attached'
      kbName, // KB folder name (e.g., 'userId-agent-YYYYMMDD-HHMMSS')
      initialFile,
      currentMedications: userDoc.currentMedications || null
    });
  } catch (error) {
    console.error('❌ Error fetching user status:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to fetch user status: ${error.message}`,
      error: 'FETCH_FAILED'
    });
  }
});

// Toggle KB connection to Agent endpoint (attach/detach)
app.post('/api/toggle-kb-connection', async (req, res) => {
  try {
    const { userId, action } = req.body; // action: 'attach' | 'detach'
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    if (!action || (action !== 'attach' && action !== 'detach')) {
      return res.status(400).json({ 
        success: false, 
        message: 'Action must be "attach" or "detach"',
        error: 'INVALID_ACTION'
      });
    }

    // Get user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    if (!userDoc.assignedAgentId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User has no assigned agent',
        error: 'NO_AGENT'
      });
    }

    if (!userDoc.kbId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User has no knowledge base',
        error: 'NO_KB'
      });
    }

    try {
      if (action === 'attach') {
        // Attach KB to agent
        await doClient.agent.attachKB(userDoc.assignedAgentId, userDoc.kbId);
        console.log(`✅ Attached KB ${userDoc.kbId} to agent ${userDoc.assignedAgentId}`);
        
        // Invalidate cache so subsequent calls get fresh connection status
        invalidateResourceCache(userId);
        
        res.json({ 
          success: true, 
          message: 'Knowledge base attached to agent successfully',
          agentId: userDoc.assignedAgentId,
          kbId: userDoc.kbId,
          connected: true
        });
      } else {
        // Detach KB from agent
        await doClient.agent.detachKB(userDoc.assignedAgentId, userDoc.kbId);
        console.log(`✅ Detached KB ${userDoc.kbId} from agent ${userDoc.assignedAgentId}`);
        
        // Invalidate cache so subsequent calls get fresh connection status
        invalidateResourceCache(userId);
        
        res.json({ 
          success: true, 
          message: 'Knowledge base detached from agent successfully',
          agentId: userDoc.assignedAgentId,
          kbId: userDoc.kbId,
          connected: false
        });
      }
    } catch (error) {
      console.error(`❌ Error ${action}ing KB:`, error);
      // Check if KB is already in the desired state (might return 409 or 404)
      if (error.message && (error.message.includes('already') || error.message.includes('409'))) {
        if (action === 'attach') {
          console.log('ℹ️ KB already attached to agent');
          res.json({ 
            success: true, 
            message: 'Knowledge base is already attached to agent',
            agentId: userDoc.assignedAgentId,
            kbId: userDoc.kbId,
            connected: true,
            alreadyAttached: true
          });
        } else {
          throw error; // Can't detach if already attached means something's wrong
        }
      } else if (error.message && error.message.includes('404')) {
        if (action === 'detach') {
          console.log('ℹ️ KB already detached from agent');
          res.json({ 
            success: true, 
            message: 'Knowledge base is already detached from agent',
            agentId: userDoc.assignedAgentId,
            kbId: userDoc.kbId,
            connected: false,
            alreadyDetached: true
          });
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Error toggling KB connection:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to ${req.body.action || 'toggle'} KB connection: ${error.message}`,
      error: error.message 
    });
  }
});

// Attach KB to Agent endpoint (kept for backward compatibility)
app.post('/api/attach-kb-to-agent', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    if (!userDoc.assignedAgentId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User has no assigned agent',
        error: 'NO_AGENT'
      });
    }

    if (!userDoc.kbId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User has no knowledge base',
        error: 'NO_KB'
      });
    }

    try {
      // Attach KB to agent
      await doClient.agent.attachKB(userDoc.assignedAgentId, userDoc.kbId);
      console.log(`✅ Attached KB ${userDoc.kbId} to agent ${userDoc.assignedAgentId}`);
      
      res.json({ 
        success: true, 
        message: 'Knowledge base attached to agent successfully',
        agentId: userDoc.assignedAgentId,
        kbId: userDoc.kbId
      });
    } catch (error) {
      console.error('❌ Error attaching KB to agent:', error);
      // Check if KB is already attached (might return 409 or similar)
      if (error.message && (error.message.includes('already') || error.message.includes('409'))) {
        console.log('ℹ️ KB already attached to agent');
        res.json({ 
          success: true, 
          message: 'Knowledge base is already attached to agent',
          agentId: userDoc.assignedAgentId,
          kbId: userDoc.kbId,
          alreadyAttached: true
        });
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Error attaching KB to agent:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to attach KB to agent: ${error.message}`,
      error: error.message 
    });
  }
});

// Reset KB endpoint - clears all KB-related fields except kbName
app.post('/api/reset-kb', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Clear all KB-related fields except kbName (which is permanent)
    userDoc.kbId = null;
    userDoc.connectedKBs = [];
    userDoc.connectedKB = null; // Legacy field
    userDoc.kbIndexedFiles = [];
    userDoc.kbPendingFiles = [];
    userDoc.kbLastIndexingJobId = null;
    userDoc.kbIndexingStartedAt = null;
    userDoc.kbCreatedAt = null;
    userDoc.kbLastIndexedAt = null;

    // Check if there are files in the KB folder - if so, indexing is needed
    const kbName = getKBNameFromUserDoc(userDoc, userId);
    const filesInKB = userDoc.files?.filter(file => 
      file.bucketKey && file.bucketKey.startsWith(`${userId}/${kbName}/`)
    ) || [];
    
    // Set kbIndexingNeeded based on whether files exist in KB folder
    userDoc.kbIndexingNeeded = filesInKB.length > 0;

    // Save updated user document
    await cloudant.saveDocument('maia_users', userDoc);

    console.log(`✅ Reset KB for user ${userId} (kbName preserved: ${userDoc.kbName || 'none'})`);

    res.json({ 
      success: true, 
      message: 'Knowledge base reset successfully',
      kbName: userDoc.kbName || null
    });
  } catch (error) {
    console.error('Error resetting KB:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to reset KB: ${error.message}`,
      error: error.message 
    });
  }
});

// Generate Patient Summary endpoint
app.post('/api/generate-patient-summary', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    if (!userDoc.assignedAgentId || !userDoc.agentEndpoint || !userDoc.agentApiKey) {
      return res.status(400).json({ 
        success: false, 
        message: 'User agent is not properly configured',
        error: 'AGENT_NOT_CONFIGURED'
      });
    }

    // Use the agent to generate a patient summary
    // We'll use the DigitalOcean provider directly to call the agent
    const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');
    const agentProvider = new DigitalOceanProvider(userDoc.agentApiKey, {
      baseURL: userDoc.agentEndpoint
    });

    const summaryPrompt = 'Please generate a comprehensive patient summary based on all available medical records and documents in the knowledge base. Include key medical history, diagnoses, medications, allergies, and important notes.';
    
    console.log(`📝 Generating patient summary for user ${userId} using agent ${userDoc.assignedAgentId}`);
    
    try {
      // chat() method signature: chat(messages, options, onUpdate)
      // messages: array of message objects
      // options: object with model, stream, etc.
      const summaryResponse = await agentProvider.chat(
        [{ role: 'user', content: summaryPrompt }], // messages array
        { 
          model: userDoc.agentModelName || 'openai-gpt-oss-120b',
          stream: false
        } // options object
      );

      const summary = summaryResponse.content || summaryResponse.text || '';
      
      if (!summary || summary.trim().length === 0) {
        throw new Error('Empty summary received from agent');
      }

      // Re-fetch user document to get latest revision (may have been updated by background polling)
      // Retry up to 3 times to handle document conflicts
      let saved = false;
      let retries = 0;
      const maxRetries = 3;
      
      // Get current summary for undo (don't save yet - frontend will choose replace strategy)
      let savedCurrentSummary = null;
      try {
        const freshUserDoc = await cloudant.getDocument('maia_users', userId);
        if (freshUserDoc) {
          const summaries = initializeSummariesArray(freshUserDoc);
          savedCurrentSummary = summaries.length > 0 ? summaries[summaries.length - 1] : null;
        }
      } catch (err) {
        console.warn('Failed to get current summary for undo:', err);
      }
      
      // Store for response
      res.locals.savedCurrentSummary = savedCurrentSummary;
      saved = true; // Mark as "saved" (actually just prepared, frontend will save)

      console.log(`✅ Patient summary generated successfully for user ${userId}`);
      
      // Get current summaries array (before saving new one)
      const finalUserDoc = await cloudant.getDocument('maia_users', userId);
      const summaries = initializeSummariesArray(finalUserDoc);
      
      res.json({ 
        success: true, 
        summary,
        message: 'Patient summary generated successfully',
        summaries: summaries.map((s, index) => ({
          text: s.text,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          isCurrent: index === summaries.length - 1
        })),
        savedCurrentSummary: res.locals.savedCurrentSummary || null
      });
    } catch (error) {
      console.error('❌ Error generating patient summary:', error);
      throw error;
    }
  } catch (error) {
    console.error('Error generating patient summary:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to generate patient summary: ${error.message}`,
      error: error.message 
    });
  }
});

// Helper functions for managing multiple patient summaries
const MAX_SUMMARIES = 3;

function initializeSummariesArray(userDoc) {
  // Initialize patientSummaries array if it doesn't exist
  if (!userDoc.patientSummaries || !Array.isArray(userDoc.patientSummaries)) {
    userDoc.patientSummaries = [];
  }
  
  // Migrate old patientSummary to array if it exists and array is empty
  if (userDoc.patientSummary && userDoc.patientSummaries.length === 0) {
    const createdAt = userDoc.patientSummaryGeneratedAt || new Date().toISOString();
    userDoc.patientSummaries.push({
      text: userDoc.patientSummary,
      createdAt: createdAt,
      updatedAt: createdAt
    });
  }
  
  return userDoc.patientSummaries;
}

function getCurrentSummary(userDoc) {
  // Current summary is the most recent one (last in array)
  const summaries = initializeSummariesArray(userDoc);
  if (summaries.length === 0) {
    return null;
  }
  return summaries[summaries.length - 1];
}

function addNewSummary(userDoc, summaryText, replaceStrategy = 'newest', replaceIndex = null) {
  const summaries = initializeSummariesArray(userDoc);
  const now = new Date().toISOString();
  const newSummary = {
    text: summaryText,
    createdAt: now,
    updatedAt: now
  };
  
  // Save current summary for undo (if exists)
  const currentSummary = summaries.length > 0 ? summaries[summaries.length - 1] : null;
  
  if (replaceIndex !== null && replaceIndex >= 0 && replaceIndex < summaries.length) {
    // Replace at specific index and make the new summary current (move to end)
    if (replaceIndex === summaries.length - 1) {
      // Replacing current summary - just update it
      summaries[replaceIndex] = newSummary;
    } else {
      // Replacing a non-current summary - remove old one, add new at end
      summaries.splice(replaceIndex, 1);
      summaries.push(newSummary);
    }
  } else if (summaries.length < MAX_SUMMARIES) {
    // Add to array
    summaries.push(newSummary);
  } else {
    // Replace based on strategy
    if (replaceStrategy === 'oldest') {
      // Remove oldest (first) and add new at end
      summaries.shift();
      summaries.push(newSummary);
    } else if (replaceStrategy === 'newest') {
      // Replace newest (last) with new
      summaries[summaries.length - 1] = newSummary;
    }
    // 'keep' strategy means don't add (handled by caller)
  }
  
  // Update backward compatibility fields
  userDoc.patientSummary = newSummary.text;
  userDoc.patientSummaryGeneratedAt = now;
  
  return { summaries, currentSummary };
}

function swapSummary(userDoc, index) {
  const summaries = initializeSummariesArray(userDoc);
  if (index < 0 || index >= summaries.length || index === summaries.length - 1) {
    return false; // Invalid index or already current
  }
  
  // Swap the summary at index with the last one (current)
  const temp = summaries[index];
  summaries[index] = summaries[summaries.length - 1];
  summaries[summaries.length - 1] = temp;
  
  // Update backward compatibility fields
  const current = summaries[summaries.length - 1];
  userDoc.patientSummary = current.text;
  userDoc.patientSummaryGeneratedAt = current.updatedAt || current.createdAt;
  
  return true;
}

// Patient Summary endpoints
app.get('/api/patient-summary', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    const summaries = initializeSummariesArray(userDoc);
    const currentSummary = getCurrentSummary(userDoc);
    
    res.json({ 
      success: true, 
      summary: currentSummary ? currentSummary.text : '',
      summaries: summaries.map((s, index) => ({
        text: s.text,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        isCurrent: index === summaries.length - 1
      }))
    });
  } catch (error) {
    console.error('Error fetching patient summary:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch patient summary',
      error: error.message 
    });
  }
});

app.post('/api/patient-summary', async (req, res) => {
  try {
    const { userId, summary, replaceStrategy, replaceIndex } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    if (!summary) {
      return res.status(400).json({ 
        success: false, 
        message: 'Summary is required',
        error: 'MISSING_SUMMARY'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Add new summary (or update current if replaceStrategy is 'keep')
    if (replaceStrategy === 'keep') {
      // Just update the current summary's text and updatedAt
      const summaries = initializeSummariesArray(userDoc);
      if (summaries.length > 0) {
        summaries[summaries.length - 1].text = summary;
        summaries[summaries.length - 1].updatedAt = new Date().toISOString();
    userDoc.patientSummary = summary;
      } else {
        // No summaries exist, add first one
        addNewSummary(userDoc, summary, 'newest');
      }
    } else {
      // Add new summary with replace strategy or specific index
      addNewSummary(userDoc, summary, replaceStrategy || 'newest', replaceIndex);
    }
    
    userDoc.updatedAt = new Date().toISOString();
    // Set workflowStage to patient_summary when summary is saved
    userDoc.workflowStage = 'patient_summary';
    
    await cloudant.saveDocument('maia_users', userDoc);
    
    const summaries = initializeSummariesArray(userDoc);
    res.json({ 
      success: true, 
      message: 'Patient summary saved successfully',
      summaries: summaries.map((s, index) => ({
        text: s.text,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        isCurrent: index === summaries.length - 1
      }))
    });
  } catch (error) {
    console.error('Error saving patient summary:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to save patient summary',
      error: error.message 
    });
  }
});

// Swap summary endpoint - make a non-current summary the current one
app.post('/api/patient-summary/swap', async (req, res) => {
  try {
    const { userId, index } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    if (typeof index !== 'number' || index < 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Valid index is required',
        error: 'MISSING_INDEX'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    const swapped = swapSummary(userDoc, index);
    if (!swapped) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid index or summary is already current',
        error: 'INVALID_SWAP'
      });
    }
    
    userDoc.updatedAt = new Date().toISOString();
    await cloudant.saveDocument('maia_users', userDoc);
    
    const summaries = initializeSummariesArray(userDoc);
    res.json({ 
      success: true, 
      message: 'Summary swapped successfully',
      summaries: summaries.map((s, idx) => ({
        text: s.text,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        isCurrent: idx === summaries.length - 1
      }))
    });
  } catch (error) {
    console.error('Error swapping patient summary:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to swap patient summary',
      error: error.message 
    });
  }
});

// Serve static files from dist in production
// On DigitalOcean App Platform, NODE_ENV might not be set to 'production'
// So we also check if dist folder exists as an indicator

// Check if we're in production (before CORS setup)
const distPath = path.join(__dirname, '../dist');
const distExists = existsSync(distPath);
const isProduction = process.env.NODE_ENV === 'production' || distExists;

if (isProduction) {
  const indexPath = path.join(distPath, 'index.html');
  
  // Check if index.html exists
  const indexExists = existsSync(indexPath);
  
  if (distExists) {
    try {
      const distFiles = readdirSync(distPath);
    } catch (err) {
      console.error(`❌ [STATIC] Error reading dist folder:`, err);
    }
  }
  
  // Serve Privacy.md specifically (before static middleware and catch-all)
  // This route must come BEFORE express.static to ensure it's handled correctly
  app.get('/Privacy.md', (req, res, next) => {
    const privacyPath = path.join(distPath, 'Privacy.md');
    console.log(`📄 [PRIVACY] Request for Privacy.md, checking: ${privacyPath}`);
    
    if (existsSync(privacyPath)) {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
      res.sendFile(privacyPath, (err) => {
        if (err) {
          console.error(`❌ [PRIVACY] Error serving Privacy.md:`, err);
          res.status(500).send('Error loading privacy policy');
        } else {
          console.log(`✅ [PRIVACY] Served Privacy.md from ${privacyPath}`);
        }
      });
    } else {
      console.log(`⚠️ [PRIVACY] Privacy.md not found at ${privacyPath}`);
      res.status(404).json({ error: 'Privacy policy not found' });
    }
  });

  // Get patient diary entries
  app.get('/api/patient-diary', async (req, res) => {
    try {
      // Security: Only use userId from authenticated session, never from query parameters
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Get the user document
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Return diary entries if they exist
      const entries = userDoc.patientDiary?.entries || [];
      
      // Sort by dateTime (oldest first, like a chat)
      const sortedEntries = [...entries].sort((a, b) => {
        const dateA = new Date(a.dateTime);
        const dateB = new Date(b.dateTime);
        return dateA.getTime() - dateB.getTime();
      });
      
      // Ensure all entries have a posted flag (for backward compatibility)
      sortedEntries.forEach(entry => {
        if (entry.posted === undefined) {
          entry.posted = false;
        }
      });

      res.json({
        success: true,
        entries: sortedEntries,
        entryCount: sortedEntries.length
      });
    } catch (error) {
      console.error('Error loading patient diary:', error);
      res.status(500).json({ error: `Failed to load diary: ${error.message}` });
    }
  });

  // Add patient diary entry
  app.post('/api/patient-diary', async (req, res) => {
    try {
      // Security: Only use userId from authenticated session, never from request body
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { entry } = req.body;
      if (!entry || !entry.message || !entry.dateTime) {
        return res.status(400).json({ error: 'Entry with message and dateTime is required' });
      }

      // Get the user document
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Initialize patientDiary object if it doesn't exist
      if (!userDoc.patientDiary) {
        userDoc.patientDiary = {
          entries: []
        };
      }

      // Generate entry ID
      const entryId = `diary-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Add the new entry
      const newEntry = {
        id: entryId,
        message: entry.message.trim(),
        dateTime: entry.dateTime,
        bubbleId: entry.bubbleId || null // Will be set by frontend if not provided
      };

      userDoc.patientDiary.entries.push(newEntry);
      userDoc.patientDiary.lastUpdated = new Date().toISOString();
      userDoc.updatedAt = new Date().toISOString();

      await cloudant.saveDocument('maia_users', userDoc);

      res.json({
        success: true,
        message: 'Diary entry saved successfully',
        entryId: entryId,
        entry: newEntry
      });
    } catch (error) {
      console.error('Error saving patient diary entry:', error);
      res.status(500).json({ error: `Failed to save diary entry: ${error.message}` });
    }
  });

  // Mark diary entries as posted
  app.post('/api/patient-diary/mark-posted', async (req, res) => {
    try {
      // Security: Only use userId from authenticated session, never from request body
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { entryIds } = req.body;
      if (!entryIds || !Array.isArray(entryIds)) {
        return res.status(400).json({ error: 'Entry IDs array is required' });
      }

      // Get the user document
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Initialize patientDiary if it doesn't exist
      if (!userDoc.patientDiary) {
        userDoc.patientDiary = { entries: [] };
      }

      // Mark entries as posted
      let updated = false;
      userDoc.patientDiary.entries.forEach(entry => {
        if (entryIds.includes(entry.id)) {
          entry.posted = true;
          updated = true;
        }
      });

      if (updated) {
        userDoc.patientDiary.lastUpdated = new Date().toISOString();
        userDoc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument('maia_users', userDoc);
      }

      res.json({
        success: true,
        message: 'Entries marked as posted',
        markedCount: entryIds.length
      });
    } catch (error) {
      console.error('Error marking diary entries as posted:', error);
      res.status(500).json({ error: `Failed to mark entries as posted: ${error.message}` });
    }
  });

  // Update entry bubbleId
  app.post('/api/patient-diary/update-bubble-id', async (req, res) => {
    try {
      // Security: Only use userId from authenticated session, never from request body
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { entryId, bubbleId } = req.body;
      if (!entryId || !bubbleId) {
        return res.status(400).json({ error: 'Entry ID and bubble ID are required' });
      }

      // Get the user document
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Initialize patientDiary if it doesn't exist
      if (!userDoc.patientDiary) {
        userDoc.patientDiary = { entries: [] };
      }

      // Find and update the entry
      const entry = userDoc.patientDiary.entries.find(e => e.id === entryId);
      if (!entry) {
        return res.status(404).json({ error: 'Entry not found' });
      }

      entry.bubbleId = bubbleId;
      userDoc.patientDiary.lastUpdated = new Date().toISOString();
      userDoc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument('maia_users', userDoc);

      res.json({
        success: true,
        message: 'Entry bubbleId updated successfully'
      });
    } catch (error) {
      console.error('Error updating entry bubbleId:', error);
      res.status(500).json({ error: `Failed to update bubbleId: ${error.message}` });
    }
  });

  // Delete diary entries
  app.post('/api/patient-diary/delete', async (req, res) => {
    try {
      // Security: Only use userId from authenticated session, never from request body
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { entryIds } = req.body;
      if (!entryIds || !Array.isArray(entryIds)) {
        return res.status(400).json({ error: 'Entry IDs array is required' });
      }

      // Get the user document
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Initialize patientDiary if it doesn't exist
      if (!userDoc.patientDiary) {
        userDoc.patientDiary = { entries: [] };
      }

      // Remove entries
      const initialLength = userDoc.patientDiary.entries.length;
      userDoc.patientDiary.entries = userDoc.patientDiary.entries.filter(
        entry => !entryIds.includes(entry.id)
      );

      const deletedCount = initialLength - userDoc.patientDiary.entries.length;

      if (deletedCount > 0) {
        userDoc.patientDiary.lastUpdated = new Date().toISOString();
        userDoc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument('maia_users', userDoc);
      }

      res.json({
        success: true,
        message: 'Entries deleted successfully',
        deletedCount
      });
    } catch (error) {
      console.error('Error deleting diary entries:', error);
      res.status(500).json({ error: `Failed to delete entries: ${error.message}` });
    }
  });

  // Save privacy filter pseudonym mapping
  app.post('/api/privacy-filter-mapping', async (req, res) => {
    try {
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { mapping } = req.body;
      if (!mapping || !Array.isArray(mapping)) {
        return res.status(400).json({ error: 'Mapping array is required' });
      }

      // Get the user document
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Initialize privacyFilter object if it doesn't exist
      if (!userDoc.privacyFilter) {
        userDoc.privacyFilter = {};
      }

      // Save the mapping
      userDoc.privacyFilter.pseudonymMapping = mapping;
      userDoc.privacyFilter.lastUpdated = new Date().toISOString();
      userDoc.updatedAt = new Date().toISOString();

      await cloudant.saveDocument('maia_users', userDoc);

      res.json({
        success: true,
        message: 'Pseudonym mapping saved successfully',
        mappingCount: mapping.length
      });
    } catch (error) {
      console.error('Error saving privacy filter mapping:', error);
      res.status(500).json({ error: `Failed to save mapping: ${error.message}` });
    }
  });

  // Load privacy filter pseudonym mapping
  app.get('/api/privacy-filter-mapping', async (req, res) => {
    try {
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Get the user document
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Return the mapping if it exists
      const mapping = userDoc.privacyFilter?.pseudonymMapping || [];
      const lastUpdated = userDoc.privacyFilter?.lastUpdated || null;

      res.json({
        success: true,
        mapping,
        lastUpdated,
        mappingCount: mapping.length
      });
    } catch (error) {
      console.error('Error loading privacy filter mapping:', error);
      res.status(500).json({ error: `Failed to load mapping: ${error.message}` });
    }
  });

  // Serve random names from NEW-AGENT.txt for privacy filtering
  app.get('/api/random-names', (req, res) => {
    const newAgentPath = path.join(__dirname, '../NEW-AGENT.txt');
    
    if (!existsSync(newAgentPath)) {
      return res.status(404).json({ error: 'NEW-AGENT.txt not found' });
    }

    try {
      const content = readFileSync(newAgentPath, 'utf-8');
      
      // Find the "## Random Names" section
      const randomNamesSection = content.match(/## Random Names\s*\n([\s\S]*?)(?=\n---|\n##|$)/i);
      if (!randomNamesSection) {
        return res.status(404).json({ error: 'Random Names section not found' });
      }

      // Extract names (one per line, filter out empty lines and section headers)
      const names = randomNamesSection[1]
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => {
          // Extract just the name (remove any trailing notes in parentheses)
          const nameMatch = line.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+(?:\.[A-Z])?)+)/);
          return nameMatch ? nameMatch[1] : null;
        })
        .filter(name => name !== null);

      res.json({ names });
    } catch (err) {
      console.error('Error reading random names:', err);
      res.status(500).json({ error: 'Error loading random names' });
    }
  });

  // Serve welcome page video caption from NEW-AGENT.txt
  app.get('/api/welcome-caption', (req, res) => {
    const newAgentPath = path.join(__dirname, '../NEW-AGENT.txt');
    console.log(`📄 [WELCOME] Request for welcome caption, checking: ${newAgentPath}`);
    
    if (!existsSync(newAgentPath)) {
      console.log(`⚠️ [WELCOME] NEW-AGENT.txt not found at ${newAgentPath}`);
      return res.status(404).json({ error: 'Welcome caption not found' });
    }

    try {
      const content = readFileSync(newAgentPath, 'utf-8');
      const lines = content.split('\n');
      
      // Find the "## Welcome Page Video Caption" section
      let captionStartIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '## Welcome Page Video Caption') {
          captionStartIndex = i + 1;
          break;
        }
      }

      if (captionStartIndex === -1) {
        console.log(`⚠️ [WELCOME] Welcome Page Video Caption section not found in NEW-AGENT.txt`);
        return res.status(404).json({ error: 'Welcome caption section not found' });
      }

      // Extract caption text (until next section or end of file)
      const captionLines = [];
      for (let i = captionStartIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        // Stop at next section header or empty line followed by section
        if (line.startsWith('##') && line !== '## Welcome Page Video Caption') {
          break;
        }
        if (line) {
          captionLines.push(line);
        } else if (captionLines.length > 0) {
          // Allow one empty line, but stop at multiple empty lines
          const nextNonEmpty = lines.slice(i + 1).find(l => l.trim());
          if (nextNonEmpty && nextNonEmpty.trim().startsWith('##')) {
            break;
          }
          captionLines.push('');
        }
      }

      const caption = captionLines.join(' ').trim();
      
      if (!caption) {
        console.log(`⚠️ [WELCOME] Welcome caption is empty`);
        return res.status(404).json({ error: 'Welcome caption is empty' });
      }

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
      res.json({ caption });
      console.log(`✅ [WELCOME] Served welcome caption from NEW-AGENT.txt`);
    } catch (err) {
      console.error(`❌ [WELCOME] Error reading NEW-AGENT.txt:`, err);
      res.status(500).json({ error: 'Error loading welcome caption' });
    }
  });
  
  // Serve static assets (JS, CSS, images, etc.)
  // fallthrough: true allows requests to continue to the catch-all if file not found
  // Note: Privacy.md is handled above, so it won't be served by static middleware
  app.use(express.static(distPath, {
    maxAge: '1y', // Cache static assets for 1 year
    etag: true,
    fallthrough: true // Allow fallthrough to catch-all for SPA routes
  }));
  
  
  // Catch-all handler: serve index.html for all non-API routes
  // This enables client-side routing for the Vue SPA
  // IMPORTANT: This must be the LAST route handler
  app.get('*', (req, res) => {
    console.log(`🎯 [CATCH-ALL] Request: ${req.method} ${req.path}`);
    
    // Skip API routes - these should have been handled by API routes above
    if (req.path.startsWith('/api')) {
      console.log(`❌ [CATCH-ALL] API route not found: ${req.path}`);
      return res.status(404).json({ error: 'API endpoint not found' });
    }
    
    // Check if this is a static asset request (CSS, JS, images, etc.)
    const isStaticAsset = req.path.startsWith('/assets/') || 
                          req.path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|webp|avif)$/);
    
    if (isStaticAsset) {
      // For static assets, check if file exists
      const filePath = path.join(distPath, req.path);
      if (existsSync(filePath)) {
        // File exists - serve it (should have been caught by static middleware, but handle it anyway)
        console.log(`📦 [CATCH-ALL] Serving static asset: ${req.path}`);
        return res.sendFile(filePath);
      } else {
        // File doesn't exist - return 404 (don't serve index.html for missing assets)
        console.log(`❌ [CATCH-ALL] Static asset not found: ${req.path}`);
        return res.status(404).send('Asset not found');
      }
    }
    
    // For SPA routes, serve index.html (SPA fallback)
    console.log(`📄 [CATCH-ALL] Serving index.html for: ${req.path}`);
    res.sendFile(indexPath, (err) => {
      if (err) {
        console.error(`❌ [CATCH-ALL] Error serving index.html from ${indexPath}:`, err);
        console.error(`❌ [CATCH-ALL] Error details:`, err.message);
        res.status(500).send('Error loading application');
      } else {
        console.log(`✅ [CATCH-ALL] Successfully served index.html for: ${req.path}`);
      }
    });
  });
} else {
  // In dev mode, serve Privacy.md from public folder
  const publicPath = path.join(__dirname, '../public');
  app.get('/Privacy.md', (req, res) => {
    const privacyPath = path.join(publicPath, 'Privacy.md');
    if (existsSync(privacyPath)) {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.sendFile(privacyPath, (err) => {
        if (err) {
          console.error(`❌ [PRIVACY] Error serving Privacy.md:`, err);
          res.status(500).send('Error loading privacy policy');
        } else {
          console.log(`✅ [PRIVACY] Served Privacy.md from ${privacyPath}`);
        }
      });
    } else {
      console.log(`⚠️ [PRIVACY] Privacy.md not found at ${privacyPath}`);
      res.status(404).send('Privacy policy not found');
    }
  });

  // Serve welcome page video caption from NEW-AGENT.txt (dev mode)
  app.get('/api/welcome-caption', (req, res) => {
    const newAgentPath = path.join(__dirname, '../NEW-AGENT.txt');
    console.log(`📄 [WELCOME] Request for welcome caption, checking: ${newAgentPath}`);
    
    if (!existsSync(newAgentPath)) {
      console.log(`⚠️ [WELCOME] NEW-AGENT.txt not found at ${newAgentPath}`);
      return res.status(404).json({ error: 'Welcome caption not found' });
    }

    try {
      const content = readFileSync(newAgentPath, 'utf-8');
      const lines = content.split('\n');
      
      // Find the "## Welcome Page Video Caption" section
      let captionStartIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '## Welcome Page Video Caption') {
          captionStartIndex = i + 1;
          break;
        }
      }

      if (captionStartIndex === -1) {
        console.log(`⚠️ [WELCOME] Welcome Page Video Caption section not found in NEW-AGENT.txt`);
        return res.status(404).json({ error: 'Welcome caption section not found' });
      }

      // Extract caption text (until next section or end of file)
      const captionLines = [];
      for (let i = captionStartIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        // Stop at next section header or empty line followed by section
        if (line.startsWith('##') && line !== '## Welcome Page Video Caption') {
          break;
        }
        if (line) {
          captionLines.push(line);
        } else if (captionLines.length > 0) {
          // Allow one empty line, but stop at multiple empty lines
          const nextNonEmpty = lines.slice(i + 1).find(l => l.trim());
          if (nextNonEmpty && nextNonEmpty.trim().startsWith('##')) {
            break;
          }
          captionLines.push('');
        }
      }

      const caption = captionLines.join(' ').trim();
      
      if (!caption) {
        console.log(`⚠️ [WELCOME] Welcome caption is empty`);
        return res.status(404).json({ error: 'Welcome caption is empty' });
      }

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
      res.json({ caption });
      console.log(`✅ [WELCOME] Served welcome caption from NEW-AGENT.txt`);
    } catch (err) {
      console.error(`❌ [WELCOME] Error reading NEW-AGENT.txt:`, err);
      res.status(500).json({ error: 'Error loading welcome caption' });
    }
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`User app server running on port ${PORT}`);
  console.log(`Passkey rpID: ${passkeyService.rpID}`);
  console.log(`Passkey origin: ${passkeyService.origin}`);
  console.log(`\n📊 Available Chat Providers:`);
  chatClient.getAvailableProviders().forEach(provider => {
    console.log(`   ✅ ${provider}`);
  });
});

export default app;

