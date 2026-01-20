/**
 * Authentication routes for user app
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Helper to get client info for audit logging
function getClientInfo(req) {
  return {
    ip: req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown',
    userAgent: req.headers['user-agent'] || 'unknown'
  };
}

function buildAgentName(userId) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  return `${userId}-agent-${timestamp}`;
}

function isValidUUID(value) {
  if (!value || typeof value !== 'string') return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value.trim());
}

async function resolveModelAndProject(doClient) {
  let modelId = process.env.DO_MODEL_ID;
  let projectId = process.env.DO_PROJECT_ID;

  if (!isValidUUID(modelId) || !isValidUUID(projectId)) {
    try {
      const agents = await doClient.agent.list();
      if (agents.length > 0) {
        const existingAgent = await doClient.agent.get(agents[0].uuid || agents[0].id);
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

  if (!isValidUUID(projectId)) {
    try {
      const projectsResponse = await doClient.request('/v2/projects');
      const projects = projectsResponse.projects || projectsResponse.data?.projects || [];
      if (projects.length > 0) {
        const selectedProject = projects[0];
        if (selectedProject?.id && isValidUUID(selectedProject.id)) {
          projectId = selectedProject.id;
        }
      }
    } catch (error) {
      // Continue
    }
  }

  return { modelId, projectId };
}

function getMaiaInstructionText() {
  try {
    const newAgentFilePath = path.join(__dirname, '../../NEW-AGENT.txt');
    const fileContent = readFileSync(newAgentFilePath, 'utf-8');
    const marker = '## MAIA INSTRUCTION TEXT';
    const markerIndex = fileContent.indexOf(marker);
    if (markerIndex === -1) {
      return '';
    }
    const lines = fileContent.slice(markerIndex + marker.length).split('\n');
    let startIndex = lines.findIndex((line) => line.trim() && !line.trim().startsWith('##'));
    if (startIndex === -1) {
      startIndex = 0;
    }
    const contentLines = [];
    for (let i = startIndex; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim().startsWith('## ')) {
        break;
      }
      contentLines.push(line);
    }
    return contentLines.join('\n').trim();
  } catch (error) {
    console.warn('Unable to read NEW-AGENT.txt for agent instructions:', error.message);
    return '';
  }
}

const agentStatusCache = new Map();

async function ensureUserAgent(doClient, cloudant, userDoc) {
  if (!userDoc) return userDoc;
  const userId = userDoc.userId;
  if (!userId) return userDoc;

  let agent = null;
  if (userDoc.assignedAgentId) {
    try {
      agent = await doClient.agent.get(userDoc.assignedAgentId);
    } catch (error) {
      agent = null;
    }
  }

  if (!agent) {
    const { modelId, projectId } = await resolveModelAndProject(doClient);
    if (!isValidUUID(modelId) || !isValidUUID(projectId)) {
      throw new Error('Unable to resolve model or project ID for agent creation');
    }

    const instruction = getMaiaInstructionText();
    const agentName = buildAgentName(userId);
    agent = await doClient.agent.create({
      name: agentName,
      instruction,
      modelId: modelId.trim(),
      projectId: projectId.trim(),
      region: process.env.DO_REGION || 'tor1',
      maxTokens: 16384,
      topP: 1,
      temperature: 0.1,
      k: 10,
      retrievalMethod: 'RETRIEVAL_METHOD_NONE'
    });
  }

  const resolvedAgent = await doClient.agent.get(agent.uuid || agent.id);
  const endpoint = resolvedAgent?.deployment?.url ? `${resolvedAgent.deployment.url}/api/v1` : null;
  userDoc.assignedAgentId = resolvedAgent.uuid || resolvedAgent.id;
  userDoc.assignedAgentName = resolvedAgent.name || userDoc.assignedAgentName;
  userDoc.agentEndpoint = endpoint || userDoc.agentEndpoint || null;
  userDoc.agentModelName = resolvedAgent.model?.inference_name || resolvedAgent.model?.name || userDoc.agentModelName || null;
  userDoc.workflowStage = endpoint ? 'agent_deployed' : 'agent_named';
  userDoc.agentSetupInProgress = !endpoint;
  userDoc.updatedAt = new Date().toISOString();

  await cloudant.saveDocument('maia_users', userDoc);
  return userDoc;
}

export default function setupAuthRoutes(app, passkeyService, cloudant, doClient, auditLog) {
  // Check if user exists and has passkey
  app.get('/api/passkey/check-user', async (req, res) => {
    try {
      const { userId } = req.query;

      if (!userId) {
        return res.status(400).json({ error: 'User ID required' });
      }

      try {
        const userDoc = await cloudant.getDocument('maia_users', userId);
        res.json({
          exists: true,
          hasPasskey: !!userDoc.credentialID
        });
      } catch (error) {
        // User doesn't exist
        res.json({
          exists: false,
          hasPasskey: false
        });
      }
    } catch (error) {
      console.error('Check user error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Passkey registration - generate options
  app.post('/api/passkey/register', async (req, res) => {
    try {
      const { userId, displayName } = req.body;

      if (!userId || !displayName) {
        return res.status(400).json({ error: 'User ID and display name required' });
      }

      // Check if user already exists
      const existingUser = await cloudant.getDocument('maia_users', userId);
      if (existingUser && existingUser.credentialID) {
        return res.status(400).json({ 
          error: 'User already has a passkey',
          hasExistingPasskey: true
        });
      }

      // Generate registration options
      const options = await passkeyService.generateRegistrationOptions({
        userId,
        displayName
      });

      // Store challenge in user document
      const userDoc = existingUser || {
        _id: userId,
        userId,
        displayName,
        email: null,
        domain: passkeyService.rpID,
        type: 'user',
        workflowStage: null,
        createdAt: new Date().toISOString()
      };

      userDoc.challenge = options.challenge;
      userDoc.updatedAt = new Date().toISOString();

      await cloudant.saveDocument('maia_users', userDoc);

      res.json(options);
    } catch (error) {
      console.error('Registration options error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Passkey registration - verify
  app.post('/api/passkey/register-verify', async (req, res) => {
    try {
      const { userId, response } = req.body;

      if (!userId || !response) {
        return res.status(400).json({ error: 'User ID and response required' });
      }

      // Get user document with challenge
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc || !userDoc.challenge) {
        return res.status(400).json({ error: 'No registration challenge found' });
      }

      // Verify registration
      const result = await passkeyService.verifyRegistration({
        response,
        expectedChallenge: userDoc.challenge,
        userDoc
      });

      if (!result.verified) {
        return res.status(400).json({ error: 'Registration verification failed' });
      }

      // Update user with credential info
      const updatedUser = result.userDoc;
      updatedUser.challenge = undefined; // Remove challenge
      
      console.log(`[NEW FLOW 2] Passkey verified; minimal user setup for ${updatedUser.userId}`);
      updatedUser.workflowStage = 'active';
      updatedUser.initialFile = null;
      
      const agentReadyUser = await ensureUserAgent(doClient, cloudant, updatedUser);
      console.log(`[NEW FLOW 2] ✅ User document saved (agent ready)`);

      // Set session
      req.session.userId = agentReadyUser.userId;
      req.session.username = agentReadyUser.userId;
      req.session.displayName = agentReadyUser.displayName;
      req.session.authenticatedAt = new Date().toISOString();
      req.session.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      // Log passkey registration
      const clientInfo = getClientInfo(req);
      await auditLog.logEvent({
        type: 'passkey_registered',
        userId: agentReadyUser.userId,
        ip: clientInfo.ip,
        userAgent: clientInfo.userAgent
      });

      console.log(`[NEW FLOW 2] Passkey registration logged for ${updatedUser.userId}`);
      console.log(`[NEW FLOW 2] Ready to show app UI - no provisioning steps`);

      // Return success with flag indicating file import dialog should be shown
      // The frontend will handle showing the dialog and uploading files
      res.json({ 
        success: true, 
        user: {
          userId: agentReadyUser.userId,
          displayName: agentReadyUser.displayName
        },
        showFileImport: false
      });
    } catch (error) {
      console.error('Registration verify error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Registration complete - legacy endpoint (no initial import)
  app.post('/api/passkey/registration-complete', async (req, res) => {
    try {
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ error: 'User ID required' });
      }

      console.log(`[NEW FLOW 2] Completing registration for user: ${userId}`);

      // Get user document
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({ error: 'User not found' });
      }

      userDoc.workflowStage = 'active';
      userDoc.initialFile = null;

      await cloudant.saveDocument('maia_users', userDoc);
      console.log(`[NEW FLOW 2] User document updated - no admin provisioning`);

      res.json({ 
        success: true, 
        user: {
          userId: userDoc.userId,
          displayName: userDoc.displayName
        }
      });
    } catch (error) {
      console.error('[NEW FLOW 2] Registration complete error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Passkey authentication - generate options
  app.post('/api/passkey/authenticate', async (req, res) => {
    try {
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ error: 'User ID required' });
      }

      // Get user document
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc || !userDoc.credentialID) {
        return res.status(404).json({ error: 'User not found or no passkey registered' });
      }

      // Generate authentication options
      const options = await passkeyService.generateAuthenticationOptions({
        userId,
        userDoc
      });

      // Store challenge
      userDoc.challenge = options.challenge;
      await cloudant.saveDocument('maia_users', userDoc);

      res.json(options);
    } catch (error) {
      console.error('Authentication options error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Passkey authentication - verify
  app.post('/api/passkey/authenticate-verify', async (req, res) => {
    try {
      const { userId, response } = req.body;

      if (!userId || !response) {
        return res.status(400).json({ error: 'User ID and response required' });
      }

      // Get user document with challenge
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc || !userDoc.challenge) {
        return res.status(400).json({ error: 'No authentication challenge found' });
      }

      // Verify authentication
      const result = await passkeyService.verifyAuthentication({
        response,
        expectedChallenge: userDoc.challenge,
        userDoc
      });

      const clientInfo = getClientInfo(req);

      if (!result.verified) {
        // Log failed login attempt
        await auditLog.logEvent({
          type: 'login_failure',
          userId: userId,
          ip: clientInfo.ip,
          userAgent: clientInfo.userAgent,
          details: 'Passkey verification failed'
        });
        return res.status(400).json({ error: 'Authentication verification failed' });
      }

      // Update counter
      const updatedUser = result.userDoc;
      updatedUser.challenge = undefined; // Remove challenge
      const agentReadyUser = await ensureUserAgent(doClient, cloudant, updatedUser);

      // Set session
      req.session.userId = agentReadyUser.userId;
      req.session.username = agentReadyUser.userId;
      req.session.displayName = agentReadyUser.displayName;
      req.session.authenticatedAt = new Date().toISOString();
      req.session.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      // Log successful login
      await auditLog.logEvent({
        type: 'login_success',
        userId: agentReadyUser.userId,
        ip: clientInfo.ip,
        userAgent: clientInfo.userAgent
      });

      res.json({ 
        success: true, 
        user: {
          userId: agentReadyUser.userId,
          displayName: agentReadyUser.displayName
        }
      });
    } catch (error) {
      console.error('Authentication verify error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Sign out
  app.post('/api/sign-out', async (req, res) => {
    const userId = req.session?.userId;
    const clientInfo = getClientInfo(req);
    
    req.session.destroy(async (err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to sign out' });
      }
      try {
        res.clearCookie('maia_deep_link_user');
      } catch (cookieError) {
        console.warn('Unable to clear deep-link cookie on sign-out:', cookieError);
      }
      
      // Log logout
      if (userId) {
        await auditLog.logEvent({
          type: 'logout',
          userId: userId,
          ip: clientInfo.ip,
          userAgent: clientInfo.userAgent
        });
      }
      
      res.json({ success: true });
    });
  });

  // Current user
  app.get('/api/current-user', (req, res) => {
    if (!req.session || !req.session.userId) {
      return res.json({ authenticated: false });
    }

    res.json({
      authenticated: true,
      user: {
        userId: req.session.userId,
        username: req.session.username,
        displayName: req.session.displayName,
        isDeepLink: !!req.session.isDeepLink,
        deepLinkInfo: req.session.isDeepLink ? {
          shareIds: Array.isArray(req.session.deepLinkShareIds)
            ? req.session.deepLinkShareIds
            : (req.session.deepLinkShareIds ? [req.session.deepLinkShareIds] : []),
          activeShareId: req.session.deepLinkShareId || null,
          chatId: req.session.deepLinkChatId || null
        } : null
      }
    });
  });

  app.get('/api/agent-setup-status', async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
          error: 'NOT_AUTHENTICATED'
        });
      }

      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc || !userDoc.assignedAgentId) {
        return res.json({
          success: true,
          status: 'not_started',
          endpointReady: false
        });
      }

      const agentId = userDoc.assignedAgentId;
      const agent = await doClient.agent.get(agentId);
      const deploymentStatus = agent?.deployment?.status || agent?.deployment_status || agent?.status || 'unknown';
      const endpoint = agent?.deployment?.url ? `${agent.deployment.url}/api/v1` : null;

      const cacheKey = `${userId}:${agentId}`;
      const previousStatus = agentStatusCache.get(cacheKey);
      if (!previousStatus || previousStatus !== deploymentStatus) {
        console.log(`[AGENT] Deployment status for ${userId} (${agentId}): ${deploymentStatus}`);
        agentStatusCache.set(cacheKey, deploymentStatus);
      }

      if (endpoint && userDoc.agentEndpoint !== endpoint) {
        userDoc.agentEndpoint = endpoint;
        userDoc.agentSetupInProgress = false;
        userDoc.workflowStage = 'agent_deployed';
        userDoc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument('maia_users', userDoc);
      } else if (!endpoint && userDoc.agentSetupInProgress !== true) {
        userDoc.agentSetupInProgress = true;
        if (userDoc.workflowStage !== 'agent_named') {
          userDoc.workflowStage = 'agent_named';
        }
        userDoc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument('maia_users', userDoc);
      }

      return res.json({
        success: true,
        status: deploymentStatus,
        endpointReady: !!endpoint,
        endpoint
      });
    } catch (error) {
      console.error('Error checking agent setup status:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to check agent status'
      });
    }
  });
}

