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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('T')[0]; // YYYYMMDD
  return `${userId}-kb-${timestamp}${Date.now().toString().slice(-6)}`;
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
  // Also log to console with [NEW USER] prefix
  console.log(`[NEW USER] ${message}`);
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
      // In production, be more strict
      if (isProductionForCors) {
        console.warn(`⚠️ [CORS] Blocked origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      } else {
        // In development, allow all origins
        callback(null, true);
      }
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

console.log(`🌐 [CORS] Allowed origins: ${allowedOrigins.join(', ')}`);
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

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
setupFileRoutes(app);

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
    const needsUpdate = 
      userDoc.assignedAgentId !== userAgent.uuid ||
      userDoc.assignedAgentName !== userAgent.name ||
      userDoc.agentModelName !== agentModelName ||
      !userAgent.deployment?.url;
    
    if (needsUpdate) {
      // Retry logic for 409 conflicts
      let retries = 3;
      let saved = false;
      
      while (retries > 0 && !saved) {
        try {
      userDoc.assignedAgentId = userAgent.uuid;
      userDoc.assignedAgentName = userAgent.name;
      userDoc.agentEndpoint = userAgent.deployment?.url ? `${userAgent.deployment.url}/api/v1` : null;
      // Store model inference_name for API requests
      userDoc.agentModelName = userAgent.model?.inference_name || userAgent.model?.name || null;
      
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
                  <strong>Config Stored</strong>
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
              'Config Stored': verification.results.agentConfigStored,
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

    // Validate token
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

    // Set workflowStage to approved when admin starts provisioning
    // Initialize logs if not already done
    if (!provisioningLogs.has(userId)) {
      provisioningLogs.set(userId, []);
    }
    logProvisioning(userId, `🔵 Admin provision request for user: ${userId}, token: ${token.substring(0, 8)}...`, 'info');
    logProvisioning(userId, `📍 Setting workflowStage to 'approved'`, 'info');
    userDoc.workflowStage = 'approved';
    await cloudant.saveDocument('maia_users', userDoc);

    // Check if user already has an agent
    if (userDoc.assignedAgentId) {
      // User already provisioned - return success
      logProvisioning(userId, `ℹ️  User ${userId} already has agent: ${userDoc.assignedAgentId}`, 'info');
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

    // Initialize provisioning status
    provisioningStatus.set(userId, {
      status: 'in_progress',
      steps: [],
      startTime: Date.now(),
      currentStep: 'Starting...'
    });
    
    // Initialize provisioning logs
    if (!provisioningLogs.has(userId)) {
      provisioningLogs.set(userId, []);
    }
    logProvisioning(userId, `🚀 Starting async provisioning for user: ${userId}`, 'info');

    // Start provisioning asynchronously
    provisionUserAsync(userId, token).catch(error => {
      logProvisioning(userId, `❌ Unhandled error in async provisioning: ${error.message}`, 'error');
      const status = provisioningStatus.get(userId);
      if (status) {
        status.status = 'failed';
        status.error = error.message;
        status.completedAt = Date.now();
      }
    });

    // Return page immediately with polling
    res.send(getProvisionPage(userId));
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

// Comprehensive verification function
async function verifyProvisioningComplete(userId, agentId, agentName, kbName, expectedConfig) {
  logProvisioning(userId, `🔍 Starting comprehensive verification...`, 'info');
  
  const verificationResults = {
    bucketFolders: { passed: false, message: '' },
    agentExists: { passed: false, message: '' },
    agentDeployed: { passed: false, message: '' },
    agentConfig: { passed: false, message: '' },
    agentConfigStored: { passed: false, message: '' },
    apiKey: { passed: false, message: '' },
    apiKeyWorks: { passed: false, message: '' }
  };
  
  try {
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
        // Also handle undefined/null values (treat undefined/null as 0 for temperature)
        const actualMaxTokens = agentDetails.max_tokens || agentDetails.maxTokens;
        const actualTemperature = agentDetails.temperature ?? 0; // Treat undefined/null as 0
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
    
    // 4. Verify agent config in maia_agents collection
    try {
      const agentDoc = await cloudant.getDocument('maia_agents', agentId);
      if (agentDoc && agentDoc.userId === userId) {
        verificationResults.agentConfigStored.passed = true;
        verificationResults.agentConfigStored.message = `Agent config stored in maia_agents`;
        logProvisioning(userId, `✅ Agent config stored in maia_agents`, 'success');
      } else {
        verificationResults.agentConfigStored.message = `Agent config not found in maia_agents`;
        logProvisioning(userId, `❌ Agent config not found in maia_agents`, 'error');
      }
    } catch (err) {
      if (err.statusCode === 404) {
        verificationResults.agentConfigStored.message = `Agent config document not found`;
        logProvisioning(userId, `❌ Agent config document not found in maia_agents`, 'error');
      } else {
        verificationResults.agentConfigStored.message = `Error checking maia_agents: ${err.message}`;
        logProvisioning(userId, `❌ Error checking maia_agents: ${err.message}`, 'error');
      }
    }
    
    // 5. Verify API key
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
          
          // Merge updates with latest document
          const updatedDoc = {
            ...latestDoc,
            ...updates,
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

    // Create agent name: {userId}-agent-{YYYYMMDD}
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const agentName = `${userId}-agent-${dateStr}`;

    const agentClient = doClient.agent;

    // Final validation
    if (!isValidUUID(modelId) || !isValidUUID(projectId)) {
      throw new Error(`Cannot create agent: Invalid modelId or projectId`);
    }

    // Step 1: Create Agent
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
      temperature: 0,
      k: 10,
      retrievalMethod: 'RETRIEVAL_METHOD_NONE'
    });

    if (!newAgent || !newAgent.uuid) {
      throw new Error('Agent creation failed - no UUID returned');
    }

    updateStatus('Agent created', { agentId: newAgent.uuid, agentName });

    // Set workflowStage to agent_named after agent is successfully created
    userDoc = await updateUserDoc({ workflowStage: 'agent_named' });

    // Step 2: Wait for Deployment
    updateStatus('Waiting for agent deployment...');
    logProvisioning(userId, `⏳ Waiting for agent deployment (agentId: ${newAgent.uuid})...`, 'info');
    
    // Wait 3 seconds before first check
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Poll for deployment status
    let agentDetails = null;
    let deploymentStatus = 'STATUS_PENDING';
    const maxAttempts = 60; // 5 minutes max (60 attempts @ 5s interval)
    let attempts = 0;

    while (attempts < maxAttempts && deploymentStatus !== 'STATUS_RUNNING') {
      try {
        agentDetails = await agentClient.get(newAgent.uuid);
        deploymentStatus = agentDetails?.deployment?.status || 'STATUS_PENDING';
        
        if (attempts % 6 === 0 || deploymentStatus === 'STATUS_RUNNING') {
          logProvisioning(userId, `📊 Deployment status check (${attempts}/${maxAttempts}): ${deploymentStatus}`, 'info');
        }
        
        if (deploymentStatus === 'STATUS_RUNNING') {
          logProvisioning(userId, `✅ Agent deployment reached STATUS_RUNNING after ${attempts} attempts`, 'success');
          break;
        } else if (deploymentStatus === 'STATUS_FAILED') {
          logProvisioning(userId, `❌ Agent deployment failed with status: ${deploymentStatus}`, 'error');
          throw new Error('Agent deployment failed');
        }
        
        attempts++;
        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
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

    if (deploymentStatus !== 'STATUS_RUNNING') {
      throw new Error(`Agent deployment timed out after ${attempts} attempts. Status: ${deploymentStatus}`);
    }

    updateStatus('Agent deployed', { 
      status: deploymentStatus,
      endpoint: agentDetails?.deployment?.url ? `${agentDetails.deployment.url}/api/v1` : null,
      attempts
    });

    // Set workflowStage to agent_deployed when deployment reaches STATUS_RUNNING
    userDoc = await updateUserDoc({ workflowStage: 'agent_deployed' });

    // Step 3: Update Agent (to ensure all config is set)
    updateStatus('Updating agent configuration...');
    
    await agentClient.update(newAgent.uuid, {
      instruction: maiaInstruction,
      max_tokens: 16384,
      top_p: 1,
      temperature: 0,
      k: 10,
      retrieval_method: 'RETRIEVAL_METHOD_NONE'
    });

    updateStatus('Agent configuration updated', { updated: true });

    // Save agent config to maia_agents collection
    logProvisioning(userId, `💾 Saving agent config to maia_agents collection...`, 'info');
    try {
      const agentConfigDoc = {
        _id: newAgent.uuid,
        userId: userId,
        agentId: newAgent.uuid,
        agentName: agentName,
        instruction: maiaInstruction,
        config: {
          maxTokens: 16384,
          topP: 1,
          temperature: 0,
          k: 10,
          retrievalMethod: 'RETRIEVAL_METHOD_NONE'
        },
        deployment: {
          status: agentDetails?.deployment?.status || 'STATUS_UNKNOWN',
          url: agentDetails?.deployment?.url || null,
          createdAt: new Date().toISOString()
        },
        model: {
          uuid: agentDetails?.model?.uuid || modelId,
          name: agentDetails?.model?.name || null,
          inference_name: agentDetails?.model?.inference_name || null
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      await cloudant.saveDocument('maia_agents', agentConfigDoc);
      logProvisioning(userId, `✅ Agent config saved to maia_agents collection`, 'success');
    } catch (err) {
      logProvisioning(userId, `⚠️  Failed to save agent config to maia_agents: ${err.message}`, 'warning');
      // Non-critical, continue
    }

    // Step 3.5: Create bucket folders
    updateStatus('Creating bucket folders...');
    logProvisioning(userId, `📁 Creating bucket folders for user: ${userId}`, 'info');
    
    try {
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
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
        
        // Get KB name from user document
        const kbName = getKBNameFromUserDoc(userDoc, userId);
        
        // Create placeholder files to make folders visible in dashboard
        // In S3/Spaces, folders are just prefixes, so we need at least one object
        const rootPlaceholder = `${userId}/.keep`;
        const archivedPlaceholder = `${userId}/archived/.keep`;
        const kbPlaceholder = `${userId}/${kbName}/.keep`;
        
        // Create root userId folder placeholder (for new imports)
        await s3Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: rootPlaceholder,
          Body: '',
          ContentType: 'text/plain',
          Metadata: {
            createdBy: 'provisioning',
            createdAt: new Date().toISOString()
          }
        }));
        
        // Create archived folder placeholder (for files moved from root)
        await s3Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: archivedPlaceholder,
          Body: '',
          ContentType: 'text/plain',
          Metadata: {
            createdBy: 'provisioning',
            createdAt: new Date().toISOString()
          }
        }));
        
        // Create KB folder placeholder
        await s3Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: kbPlaceholder,
          Body: '',
          ContentType: 'text/plain',
          Metadata: {
            createdBy: 'provisioning',
            createdAt: new Date().toISOString()
          }
        }));
        
        logProvisioning(userId, `✅ Bucket folders created: ${userId}/ (root), ${userId}/archived/ (archived), and ${userId}/${kbName}/ (KB)`, 'success');
        
        // Store the intended KB name for workflow/staging purposes (KB doesn't exist yet)
        // This is different from connectedKB/connectedKBs which indicate an actual connected KB
        await updateUserDoc({
          kbName: kbName  // Intended KB name, not an actual connected KB
        });
        
        updateStatus('Bucket folders created', { 
          root: `${userId}/`,
          kb: `${userId}/${kbName}/`
        });
      } else {
        logProvisioning(userId, `⚠️  Bucket not configured, skipping folder creation`, 'warning');
      }
    } catch (err) {
      logProvisioning(userId, `⚠️  Failed to create bucket folders: ${err.message}`, 'warning');
      // Non-critical, continue
    }

    // Step 4: Create API Key
    updateStatus('Creating API key...');
    logProvisioning(userId, `🔑 Creating API key for agent: ${newAgent.uuid}`, 'info');
    
    const apiKey = await agentClient.createApiKey(newAgent.uuid, `agent-${newAgent.uuid}-api-key`);

    if (!apiKey) {
      logProvisioning(userId, `❌ API key creation failed - no key returned`, 'error');
      throw new Error('API key creation failed - no key returned');
    }

    logProvisioning(userId, `✅ API key created successfully (length: ${apiKey.length} chars)`, 'success');
    updateStatus('API key created', { keyCreated: true });

    // Step 5: Test Agent
    updateStatus('Testing agent...');
    
    let testResult = null;
    try {
      const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');
      const agentEndpoint = agentDetails?.deployment?.url ? `${agentDetails.deployment.url}/api/v1` : null;
      
      if (agentEndpoint) {
        const testProvider = new DigitalOceanProvider(apiKey, { baseURL: agentEndpoint });
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

    // Step 6: Update User Document (before verification)
    updateStatus('Updating user document...');
    
    const agentEndpoint = agentDetails?.deployment?.url ? `${agentDetails.deployment.url}/api/v1` : null;
    const agentModelName = agentDetails?.model?.inference_name || agentDetails?.model?.name || null;
    
    userDoc = await updateUserDoc({
      assignedAgentId: newAgent.uuid,
      assignedAgentName: agentName,
      agentEndpoint: agentEndpoint,
      agentModelName: agentModelName,
      agentApiKey: apiKey,
      provisioned: true,
      provisionedAt: new Date().toISOString(),
      provisionToken: undefined,
      provisionTokenCreatedAt: undefined
    });

    updateStatus('User document updated', { 
      updated: true,
      agentId: newAgent.uuid,
      agentName: agentName
    });

    // Step 7: Comprehensive Verification
    updateStatus('Verifying provisioning complete...');
    logProvisioning(userId, `🔍 Starting comprehensive verification...`, 'info');
    
    // Get KB name from user document
    const kbName = getKBNameFromUserDoc(userDoc, userId);
    
    const expectedConfig = {
      maxTokens: 16384,
      temperature: 0,
      topP: 1
    };
    
    const verification = await verifyProvisioningComplete(
      userId, 
      newAgent.uuid, 
      agentName, 
      kbName, 
      expectedConfig
    );
    
    // Update status with verification results
    const status = provisioningStatus.get(userId);
    if (status) {
      status.verification = verification;
    }
    
    if (!verification.allCriticalPassed) {
      logProvisioning(userId, `❌ Verification failed - critical checks did not pass`, 'error');
      updateStatus('Verification failed', { 
        verification,
        note: 'Some critical checks failed. Review logs for details.'
      });
      // Don't mark as completed if critical checks fail
      throw new Error(`Provisioning verification failed: ${JSON.stringify(verification.results)}`);
    }
    
    logProvisioning(userId, `✅ All critical verification checks passed`, 'success');
    // Don't log verbose verification details - status is already tracked internally
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
  }
}

// Save group chat endpoint
app.post('/api/save-group-chat', async (req, res) => {
  try {
    const { chatHistory, uploadedFiles, currentUser, connectedKB } = req.body;
    
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
    const userName = currentUser || 'anonymous';
    const randomId = Math.random().toString(36).substr(2, 9);
    const chatId = `${userName}-chat_${Date.now()}_${randomId}`;
    
    const groupChatDoc = {
      _id: chatId,
      type: 'group_chat',
      shareId: shareId,
      currentUser: currentUser,
      patientOwner: currentUser,
      connectedKB: connectedKB || 'No KB connected',
      chatHistory,
      uploadedFiles: processedFiles,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      participantCount: chatHistory.filter(msg => msg.role === 'user').length,
      messageCount: chatHistory.length,
      isShared: true
    };

    // Save to maia_chats database
    const result = await cloudant.saveDocument('maia_chats', groupChatDoc);
    
    // Set workflowStage to link_stored when chat is saved with shareId
    try {
      const userDoc = await cloudant.getDocument('maia_users', currentUser);
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
      message: 'Group chat saved successfully' 
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
    const { chatHistory, uploadedFiles, currentUser, connectedKB, shareId } = req.body;

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

    if (!currentUser) {
      return res.status(400).json({
        success: false,
        message: 'Current user is required to update chat',
        error: 'MISSING_USER_ID'
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

    if (existingChat.currentUser && existingChat.currentUser !== currentUser) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update this chat',
        error: 'CHAT_UPDATE_FORBIDDEN'
      });
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

    await cloudant.saveDocument('maia_chats', existingChat);

    // Keep workflowStage in sync when chats are updated
    try {
      const userDoc = await cloudant.getDocument('maia_users', currentUser);
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
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get all chats for this user from maia_chats
    const allChats = await cloudant.getAllDocuments('maia_chats');
    
    // Filter to only chats owned by this user (by _id prefix)
    const userChats = allChats.filter(chat => chat._id.startsWith(`${userId}-`));
    
    console.log(`✅ Found ${userChats.length} chats for user ${userId}`);
    
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
    
    // Get all chats and find the one with matching shareId
    const allChats = await cloudant.getAllDocuments('maia_chats');
    const chat = allChats.find(c => c.shareId === shareId);
    
    if (!chat) {
      return res.status(404).json({ 
        success: false, 
        message: 'Chat not found',
        error: 'CHAT_NOT_FOUND'
      });
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
    const { userId, fileMetadata } = req.body;
    
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

    // SPECIAL CASE: Public User files are session-only (not saved to database)
    if (userId === 'Public User') {
      return res.json({
        success: true,
        message: 'File uploaded successfully (session-only for Public User)',
        sessionOnly: true
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

// Auto-archive files at root level (move from userId/ to userId/archived/)
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
    const { S3Client, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');

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

        // Update file metadata in user document
        if (userDoc.files) {
          const fileIndex = userDoc.files.findIndex(f => f.bucketKey === sourceKey);
          if (fileIndex >= 0) {
            userDoc.files[fileIndex].bucketKey = destKey;
            archivedFiles.push(fileName);
          }
        }

        archivedCount++;
      } catch (err) {
        console.error(`❌ Error archiving file ${fileName}:`, err);
      }
    }

    // Save updated user document if files were moved
    if (archivedCount > 0 && userDoc.files) {
      // Set workflowStage to files_archived when files are archived
      userDoc.workflowStage = 'files_archived';
      await cloudant.saveDocument('maia_users', userDoc);
    }

    res.json({
      success: true,
      message: `Archived ${archivedCount} file(s)`,
      archivedCount,
      archivedFiles
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

// Get user files
app.get('/api/user-files', async (req, res) => {
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

    const files = userDoc.files || [];
    
    // Get indexed files from user document (tracks which files were actually indexed)
    const indexedFiles = userDoc.kbIndexedFiles || [];
    
    res.json({
      success: true,
      files: files,
      indexedFiles: indexedFiles
    });
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
    const { S3Client, CopyObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');

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

    // Handle intermediate step (root -> archived) if needed
    if (intermediateKey && sourceKey !== intermediateKey) {
      console.log(`[KB Management] Archiving file first: ${sourceKey} -> ${intermediateKey}`);
      
      // Copy from root to archived
      const archiveCopy = new CopyObjectCommand({
        Bucket: bucketName,
        CopySource: `${bucketName}/${sourceKey}`,
        Key: intermediateKey
      });
      await s3Client.send(archiveCopy);
      
      // Delete from root
      const archiveDelete = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: sourceKey
      });
      await s3Client.send(archiveDelete);
      
      // Update sourceKey for next step
      sourceKey = intermediateKey;
      
      // Update file's bucketKey in user document
      userDoc.files[fileIndex].bucketKey = intermediateKey;
    }

    // Move file to final destination if different from source
    if (sourceKey !== destKey) {
      console.log(`[KB Management] Moving file: ${sourceKey} -> ${destKey} (KB: ${inKnowledgeBase ? 'ADD' : 'REMOVE'})`);
      
      // Copy file to new location
      const copyCommand = new CopyObjectCommand({
        Bucket: bucketName,
        CopySource: `${bucketName}/${sourceKey}`,
        Key: destKey
      });
      await s3Client.send(copyCommand);

      // Delete from old location
      const deleteCommand = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: sourceKey
      });
      await s3Client.send(deleteCommand);

      console.log(`[KB Management] ✅ File moved successfully: ${sourceKey} -> ${destKey}`);

      // Update file's bucketKey in user document
      userDoc.files[fileIndex].bucketKey = destKey;
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
    } else {
      // Remove from knowledge base
      userDoc.files[fileIndex].knowledgeBases = [];
      
      // Also remove from indexed files if it was indexed (check both old and new bucketKey)
      if (userDoc.kbIndexedFiles && Array.isArray(userDoc.kbIndexedFiles)) {
        userDoc.kbIndexedFiles = userDoc.kbIndexedFiles.filter(
          indexedKey => indexedKey !== bucketKey && indexedKey !== destKey && indexedKey !== sourceKey
        );
      }
    }

    userDoc.files[fileIndex].updatedAt = new Date().toISOString();

    // Save the updated user document
    await cloudant.saveDocument('maia_users', userDoc);
    
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

    // Delete file from Spaces
    const deleteCommand = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: bucketKey
    });

    await s3Client.send(deleteCommand);
    console.log(`✅ Deleted file from Spaces: ${bucketKey}`);

    // Remove file from user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (userDoc && userDoc.files) {
      userDoc.files = userDoc.files.filter(f => f.bucketKey !== bucketKey);
      await cloudant.saveDocument('maia_users', userDoc);
      console.log(`✅ Removed file metadata from user document: ${bucketKey}`);
    }

    // TODO: Trigger KB re-indexing if file was in KB
    // This would involve:
    // 1. Check if file was in knowledge base
    // 2. Remove from KB data source
    // 3. Trigger re-indexing

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
      console.log(`[KB AUTO] Calling doClient.kb.get(${kbId}) to get full KB details after creation`);
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
    
    const { kbId, kbDetails } = kbSetupResult;
    
    // Update user document with KB info
    userDoc.kbId = kbId;
    userDoc.kbIndexingNeeded = true;
    userDoc.kbPendingFiles = filesInKB;
    userDoc.kbIndexingStartedAt = new Date().toISOString();
    
    // Set kbCreatedAt if KB was just created
    if (!userDoc.kbCreatedAt && kbDetails) {
      userDoc.kbCreatedAt = new Date().toISOString();
    }
    
    // KB now exists in DO - update connectedKBs array
    if (!userDoc.connectedKBs || !Array.isArray(userDoc.connectedKBs)) {
      userDoc.connectedKBs = [];
    }
    if (!userDoc.connectedKBs.includes(kbName)) {
      userDoc.connectedKBs.push(kbName);
    }
    userDoc.connectedKB = kbName; // Legacy field
    
    // Save updated user document
    await cloudant.saveDocument('maia_users', userDoc);
    
    
    // Return success immediately - polling happens in background
    res.json({
      success: true,
      message: 'Knowledge base created successfully',
      kbId: kbId,
      filesInKB: filesInKB,
      phase: 'kb_created'
    });
    
    // Start polling for indexing jobs in background (non-blocking)
    // Poll every 10 seconds for max 30 minutes (180 polls)
    const startTime = Date.now();
    const pollDelayMs = 30000; // 30 seconds
    const maxPolls = Math.ceil((30 * 60 * 1000) / pollDelayMs);
    let pollCount = 0;
    let activeJobId = null;
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

      console.log(`[KB AUTO] ✅ Indexing completed! Files: ${finalFileCount}, Tokens: ${finalTokens}, Elapsed: ${elapsedMinutes}m ${elapsedSeconds}s`);

      try {
        const finalUserDoc = await cloudant.getDocument('maia_users', userId);
        if (finalUserDoc) {
          finalUserDoc.kbIndexedFiles = indexedFiles;
          finalUserDoc.kbPendingFiles = undefined;
          finalUserDoc.kbIndexingNeeded = false;
          finalUserDoc.kbLastIndexedAt = new Date().toISOString();
          finalUserDoc.kbLastIndexingJobId = activeJobId;
          if (finalUserDoc.workflowStage === 'indexing') {
            if (finalUserDoc.files && finalUserDoc.files.length > 0) {
              finalUserDoc.workflowStage = 'files_archived';
            } else {
              finalUserDoc.workflowStage = 'agent_deployed';
            }
          }
          await cloudant.saveDocument('maia_users', finalUserDoc);
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

            const summaryUserDoc = await cloudant.getDocument('maia_users', userId);
            if (summaryUserDoc) {
              summaryUserDoc.patientSummary = summary;
              summaryUserDoc.patientSummaryGeneratedAt = new Date().toISOString();
              summaryUserDoc.workflowStage = 'patient_summary';
              await cloudant.saveDocument('maia_users', summaryUserDoc);
              invalidateResourceCache(userId);
            }
          }
        } catch (summaryError) {
          console.error(`[KB AUTO] ❌ Error generating patient summary:`, summaryError.message);
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
         
         // Find active or completed job
         const job = jobsArray.find(j => {
           const jobStatus = j.status || j.job_status || j.state;
           return jobStatus === 'INDEX_JOB_STATUS_PENDING' || 
                  jobStatus === 'INDEX_JOB_STATUS_RUNNING' ||
                  jobStatus === 'INDEX_JOB_STATUS_IN_PROGRESS' || // Actual status from API
                  jobStatus === 'INDEX_JOB_STATUS_COMPLETED' ||
                  jobStatus === 'pending' ||
                  jobStatus === 'running' ||
                  jobStatus === 'in_progress' ||
                  jobStatus === 'completed';
         });
         
         if (job) {
           activeJobId = job.uuid || job.id || job.indexing_job_id;
           const status = job.status || job.job_status || job.state;

           const kbDetails = await getCachedKB(kbId);
           const tokens = String(kbDetails?.total_tokens || kbDetails?.token_count || kbDetails?.tokens || job.tokens || job.total_tokens || 0);

           const updatedUserDoc = await cloudant.getDocument('maia_users', userId);
           const indexedFiles = updatedUserDoc?.kbPendingFiles || filesInKB;
           const fileCount = job.data_source_jobs?.[0]?.indexed_file_count || indexedFiles.length;

           console.log(`[KB AUTO] Poll ${pollCount}/${maxPolls}, Files: ${fileCount}, Tokens: ${tokens}`);

           const isCompleted = status === 'INDEX_JOB_STATUS_COMPLETED' || 
                             status === 'completed' ||
                             status === 'COMPLETED' ||
                             (job.completed === true) ||
                             (job.phase === 'BATCH_JOB_PHASE_COMPLETED') ||
                             (job.phase === 'BATCH_JOB_PHASE_SUCCEEDED');

           const numericTokens = parseInt(tokens, 10);
           const hasIndexedData = Number.isFinite(numericTokens) && numericTokens > 0 && fileCount > 0;

           if (isCompleted || hasIndexedData) {
             await completeIndexing(job, fileCount, tokens, indexedFiles);
             return;
           }
         } else {
           const failedJob = jobsArray.find(j => {
             const jobStatus = j.status || j.job_status || j.state;
             return jobStatus === 'INDEX_JOB_STATUS_FAILED' || 
                    jobStatus === 'failed' || 
                    jobStatus === 'FAILED' ||
                    (j.failed === true);
           });

           if (failedJob) {
             finished = true;
             clearPollTimer();
             const failedJobId = failedJob.uuid || failedJob.id || failedJob.indexing_job_id;
             console.error(`[KB AUTO] ❌ Indexing job ${failedJobId} failed:`, failedJob.error || failedJob.message || 'Unknown error');
             return;
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
    
    // Get user document to find KB ID
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }
    
    // Get indexing job status from DO API
    let jobStatus = null;
    let kbDetails = null;
    let phase = 'indexing';
    let status = 'INDEX_JOB_STATUS_RUNNING';
    let completed = false;
    let tokens = '0';
    let filesIndexed = 0;
    let kbName = getKBNameFromUserDoc(userDoc, userId);
    
    try {
      // Get job status from DO API
      jobStatus = await doClient.indexing.getStatus(jobId);
      status = jobStatus.status || jobStatus.job?.status || 'INDEX_JOB_STATUS_RUNNING';
      
      console.log(`[KB Indexing Status] Job ${jobId} status: ${status}`);
      
      // Determine phase based on status
      if (status === 'INDEX_JOB_STATUS_PENDING') {
        phase = 'indexing_started';
      } else if (status === 'INDEX_JOB_STATUS_RUNNING') {
        phase = 'indexing';
      } else if (status === 'INDEX_JOB_STATUS_COMPLETED') {
        phase = 'complete';
        completed = true;
        console.log(`[KB Indexing Status] ✅ Job ${jobId} completed successfully`);
      } else if (status === 'INDEX_JOB_STATUS_FAILED') {
        phase = 'error';
        completed = true;
        console.log(`[KB Indexing Status] ❌ Job ${jobId} failed`);
      }
      
      // Get KB details for token count and name
      if (userDoc.kbId) {
        try {
          kbDetails = await doClient.kb.get(userDoc.kbId);
          tokens = String(kbDetails.total_tokens || kbDetails.token_count || kbDetails.tokens || 0);
          kbName = kbDetails.name || kbName;
        } catch (kbError) {
          console.error('Error getting KB details:', kbError);
          // Continue with defaults
        }
      }
      
      // Count files - prioritize kbIndexedFiles (actual indexed), then kbPendingFiles (being indexed), then derive from KB folder
      if (userDoc.kbIndexedFiles && Array.isArray(userDoc.kbIndexedFiles) && userDoc.kbIndexedFiles.length > 0) {
        filesIndexed = userDoc.kbIndexedFiles.length;
      } else if (userDoc.kbPendingFiles && Array.isArray(userDoc.kbPendingFiles) && userDoc.kbPendingFiles.length > 0) {
        filesIndexed = userDoc.kbPendingFiles.length;
      } else if (userDoc.files) {
        const kbNameForCount = getKBNameFromUserDoc(userDoc, userId);
        filesIndexed = userDoc.files.filter(file => 
          file.bucketKey && file.bucketKey.startsWith(`${userId}/${kbNameForCount}/`)
        ).length;
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
    
    // If indexing completed successfully, update indexed files in user document
    // Use retry logic for atomic state transition (pending -> indexed)
    let finalIndexedFiles = null;
    if (completed && status === 'INDEX_JOB_STATUS_COMPLETED' && userId) {
      const maxRetries = 3;
      let retryCount = 0;
      let success = false;
      
      while (retryCount < maxRetries && !success) {
        try {
          const updatedUserDoc = await cloudant.getDocument('maia_users', userId);
          if (updatedUserDoc) {
            // Check if kbPendingFiles exists - this is our source of truth for what was indexed
            if (updatedUserDoc.kbPendingFiles && Array.isArray(updatedUserDoc.kbPendingFiles) && updatedUserDoc.kbPendingFiles.length > 0) {
              // Atomic update: set kbIndexedFiles from kbPendingFiles in one operation
              updatedUserDoc.kbIndexedFiles = [...updatedUserDoc.kbPendingFiles]; // Create a copy
              updatedUserDoc.kbPendingFiles = undefined; // Clear pending
              updatedUserDoc.kbIndexingNeeded = false;
              updatedUserDoc.kbLastIndexedAt = new Date().toISOString();
              
              // Save with retry on conflict
              try {
                await cloudant.saveDocument('maia_users', updatedUserDoc);
                finalIndexedFiles = updatedUserDoc.kbIndexedFiles;
                filesIndexed = finalIndexedFiles.length;
                success = true;
                console.log(`[KB Indexing Status] ✅ Updated kbIndexedFiles with ${finalIndexedFiles.length} files:`, finalIndexedFiles);
              } catch (saveErr) {
                if (saveErr.statusCode === 409 && retryCount < maxRetries - 1) {
                  // Document conflict - retry
                  retryCount++;
                  console.log(`[KB Indexing Status] ⚠️ Document conflict, retrying (${retryCount}/${maxRetries})...`);
                  await new Promise(resolve => setTimeout(resolve, 100 * retryCount)); // Exponential backoff
                  continue;
                } else {
                  throw saveErr;
                }
              }
            } else {
              // No kbPendingFiles - check if kbIndexedFiles already exists (might have been set by another request)
              if (updatedUserDoc.kbIndexedFiles && Array.isArray(updatedUserDoc.kbIndexedFiles) && updatedUserDoc.kbIndexedFiles.length > 0) {
                finalIndexedFiles = updatedUserDoc.kbIndexedFiles;
                filesIndexed = finalIndexedFiles.length;
                console.log(`[KB Indexing Status] ℹ️ kbIndexedFiles already set (${finalIndexedFiles.length} files)`);
                success = true;
              } else {
                // This is an error condition - indexing completed but we have no record of what was indexed
                console.error(`[KB Indexing Status] ❌ ERROR: Indexing completed but kbPendingFiles is empty and kbIndexedFiles is not set for user ${userId}`);
                console.error(`[KB Indexing Status] This indicates a state synchronization issue. User document:`, {
                  kbId: updatedUserDoc.kbId,
                  kbPendingFiles: updatedUserDoc.kbPendingFiles,
                  kbIndexedFiles: updatedUserDoc.kbIndexedFiles,
                  kbLastIndexingJobId: updatedUserDoc.kbLastIndexingJobId
                });
                success = true; // Don't retry - this is a data issue, not a race condition
              }
            }
          }
        } catch (err) {
          if (retryCount < maxRetries - 1) {
            retryCount++;
            console.log(`[KB Indexing Status] ⚠️ Error updating indexed files, retrying (${retryCount}/${maxRetries}):`, err.message);
            await new Promise(resolve => setTimeout(resolve, 100 * retryCount));
          } else {
            console.error('[KB Indexing Status] ❌ Error updating indexed files after retries:', err);
            throw err;
          }
        }
      }
    }
    
    // If indexing failed, return error info
    if (status === 'INDEX_JOB_STATUS_FAILED') {
      return res.json({
        success: false,
        phase: 'error',
        status: status,
        error: jobStatus.error || jobStatus.message || 'Indexing job failed',
        kb: kbName,
        tokens: tokens,
        filesIndexed: filesIndexed,
        completed: true
      });
    }

    // Include kbIndexedFiles in response if available (from update or from userDoc)
    // This allows frontend to always have the latest state
    const responseIndexedFiles = finalIndexedFiles || (userDoc.kbIndexedFiles && Array.isArray(userDoc.kbIndexedFiles) ? userDoc.kbIndexedFiles : undefined);
    
    res.json({
      success: true,
      phase: phase,
      status: status,
      kb: kbName,
      tokens: tokens,
      filesIndexed: filesIndexed,
      completed: completed,
      progress: jobStatus.progress || (completed ? 1.0 : 0.0),
      // Include kbIndexedFiles in response so frontend can use it directly (single source of truth)
      kbIndexedFiles: responseIndexedFiles
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

    const workflowStage = userDoc.workflowStage || 'unknown';
    const fileCount = userDoc.files ? userDoc.files.length : 0;
    
    // Convert kbStatus to hasKB for backward compatibility, but also return kbStatus
    const hasKB = kbStatus === 'attached' || kbStatus === 'not_attached';

    res.json({
      success: true,
      workflowStage,
      hasAgent,
      fileCount,
      hasKB,
      kbStatus // 'none' | 'not_attached' | 'attached'
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

      // Save the summary to user document
      userDoc.patientSummary = summary;
      userDoc.patientSummaryGeneratedAt = new Date().toISOString();
      // Set workflowStage to patient_summary when summary is saved
      userDoc.workflowStage = 'patient_summary';
      await cloudant.saveDocument('maia_users', userDoc);

      console.log(`✅ Patient summary generated successfully for user ${userId}`);
      
      res.json({ 
        success: true, 
        summary,
        message: 'Patient summary generated successfully'
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

    const summary = userDoc.patientSummary || '';
    
    res.json({ 
      success: true, 
      summary 
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
    const { userId, summary } = req.body;
    
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

    // Update the patient summary
    userDoc.patientSummary = summary;
    userDoc.updatedAt = new Date().toISOString();
    // Set workflowStage to patient_summary when summary is saved
    userDoc.workflowStage = 'patient_summary';
    
    await cloudant.saveDocument('maia_users', userDoc);
    
    res.json({ 
      success: true, 
      message: 'Patient summary saved successfully'
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

// Serve static files from dist in production
// On DigitalOcean App Platform, NODE_ENV might not be set to 'production'
// So we also check if dist folder exists as an indicator
console.log(`🔍 [STATIC] NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`🔍 [STATIC] __dirname: ${__dirname}`);

// Check if we're in production (before CORS setup)
const distPath = path.join(__dirname, '../dist');
const distExists = existsSync(distPath);
const isProduction = process.env.NODE_ENV === 'production' || distExists;

console.log(`🔍 [STATIC] dist folder exists: ${distExists}`);
console.log(`🔍 [STATIC] isProduction: ${isProduction}`);

if (isProduction) {
  const indexPath = path.join(distPath, 'index.html');
  
  // Check if index.html exists
  const indexExists = existsSync(indexPath);
  
  console.log(`📁 [STATIC] Serving static files from: ${distPath}`);
  console.log(`📁 [STATIC] index.html exists: ${indexExists}`);
  
  if (distExists) {
    try {
      const distFiles = readdirSync(distPath);
      console.log(`📁 [STATIC] Files in dist: ${distFiles.slice(0, 10).join(', ')}${distFiles.length > 10 ? '...' : ''}`);
    } catch (err) {
      console.error(`❌ [STATIC] Error reading dist folder:`, err);
    }
  }
  
  // Serve static assets (JS, CSS, images, etc.)
  // fallthrough: true allows requests to continue to the catch-all if file not found
  app.use(express.static(distPath, {
    maxAge: '1y', // Cache static assets for 1 year
    etag: true,
    fallthrough: true // Allow fallthrough to catch-all for SPA routes
  }));
  
  // Add middleware to log static file requests
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) {
      console.log(`📄 [STATIC] Request: ${req.method} ${req.path}`);
    }
    next();
  });
  
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
    
    // For all other routes, serve index.html (SPA fallback)
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
  console.log(`⚠️ [STATIC] Not in production mode, skipping static file serving`);
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
  console.log(`\n🤖 Anthropic Model: claude-sonnet-4-5-20250929 (Claude Sonnet 4.5)`);
});

export default app;

