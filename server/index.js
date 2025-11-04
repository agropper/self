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

const emailService = new EmailService({
  apiKey: process.env.RESEND_API_KEY,
  fromEmail: process.env.RESEND_FROM_EMAIL,
  adminEmail: process.env.RESEND_ADMIN_EMAIL,
  baseUrl: process.env.PUBLIC_APP_URL || `http://localhost:${PORT}`
});

const doClient = new DigitalOceanClient(process.env.DIGITALOCEAN_TOKEN, {
  region: process.env.DO_REGION || 'tor1'
});

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
app.use(cors({
  origin: 'http://localhost:5173',
  credentials: true
}));
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
    
    // Find user's agent
    const userAgent = await findUserAgent(doClient, userId);
    
    if (!userAgent) {
      return res.status(404).json({ 
        success: false, 
        message: 'No agent found for user',
        error: 'AGENT_NOT_FOUND'
      });
    }
    
    // Get user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    // Check if agent info needs updating
    const agentModelName = userAgent.model?.inference_name || userAgent.model?.name || null;
    const needsUpdate = 
      userDoc.assignedAgentId !== userAgent.uuid ||
      userDoc.assignedAgentName !== userAgent.name ||
      userDoc.agentModelName !== agentModelName ||
      !userAgent.deployment?.url;
    
    if (needsUpdate) {
      userDoc.assignedAgentId = userAgent.uuid;
      userDoc.assignedAgentName = userAgent.name;
      userDoc.agentEndpoint = userAgent.deployment?.url ? `${userAgent.deployment.url}/api/v1` : null;
      // Store model inference_name for API requests
      userDoc.agentModelName = userAgent.model?.inference_name || userAgent.model?.name || null;
      
      await cloudant.saveDocument('maia_users', userDoc);
      console.log(`✅ Synced agent ${userAgent.name} for user ${userId}`);
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
            max-width: 900px;
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
        </div>
        <script>
          const userId = '${userId}';
          let pollInterval;
          
          function updatePage(data) {
            const header = document.getElementById('status-header');
            const currentStep = document.getElementById('current-step');
            const stepsContainer = document.getElementById('steps-container');
            const statusContainer = document.getElementById('status-container');
            
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
          
          // Poll immediately, then every 10 seconds
          pollStatus();
          pollInterval = setInterval(pollStatus, 10000);
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

    // Check if user already has an agent
    if (userDoc.assignedAgentId) {
      // User already provisioned - return success
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

    // Start provisioning asynchronously
    provisionUserAsync(userId, token).catch(error => {
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

// Async provisioning function
async function provisionUserAsync(userId, token) {
  try {
    // Get user document
    let userDoc = await cloudant.getDocument('maia_users', userId);

    // Update status
    const updateStatus = (step, details = {}) => {
      const status = provisioningStatus.get(userId);
      if (status) {
        status.currentStep = step;
        status.steps.push({ step, timestamp: new Date().toISOString(), ...details });
      }
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
      throw new Error(`Could not determine valid model ID or project ID. Model ID: ${modelId || 'Not found'}, Project ID: ${projectId || 'Not found'}`);
    }

    // MAIA medical assistant instruction (from NEW-AGENT.txt)
    const maiaInstruction = `You are MAIA, a medical AI assistant, that can search through a patient's health records in a knowledge base and provide relevant answers to their requests. Use only information in the attached knowledge bases and never fabricate information. There is a lot of redundancy in a patient's knowledge base. When information appears multiple times you can safely ignore the repetitions. To ensure that all medications are accurately listed in the future, the assistant should adopt a systematic approach: Comprehensive Review: Thoroughly examine every chunk in the knowledge base to identify all medication entries, regardless of their status (active or stopped). Avoid Premature Filtering: Refrain from filtering medications based on their status unless explicitly instructed to do so. This ensures that all prescribed medications are included. Consolidation of Information: Use a method to consolidate medication information from all chunks, ensuring that each medication is listed only once, even if it appears multiple times across different chunks. Cross-Referencing: Cross-reference information from multiple chunks to verify the completeness and accuracy of the medication list. Systematic Extraction: Implement a systematic process or algorithm to extract medication information, reducing the likelihood of human error or oversight. If you are asked for a patient summary, use the following categories and format: Highlight the label and category headings. Display the patient's name followed by their age and sex. A concise medical history; including surgical history -- Doctors seen recently (say, within a year) and diagnoses of those visits -- Current Medications -- Stopped or Inactive Medications --Allergies --Brief social history: employment (or school) status; living situation; use of tobacco, alcohol, drugs --Radiology in the past year --Other testing in the past year (PFTs, EKGs, etc) Do not show your reasoning. Just provide the response in English. Always start your response with the patient's name, age and sex. 

Remove any mention of problems or medications for sexual function.

Format section headings so they are not too large.`;

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

    // Step 2: Wait for Deployment
    updateStatus('Waiting for agent deployment...');
    
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
        
        if (deploymentStatus === 'STATUS_RUNNING') {
          break;
        } else if (deploymentStatus === 'STATUS_FAILED') {
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

    // Step 4: Create API Key
    updateStatus('Creating API key...');
    
    const apiKey = await agentClient.createApiKey(newAgent.uuid, `agent-${newAgent.uuid}-api-key`);

    if (!apiKey) {
      throw new Error('API key creation failed - no key returned');
    }

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

    // Step 6: Update User Document
    updateStatus('Updating user document...');
    
    userDoc.assignedAgentId = newAgent.uuid;
    userDoc.assignedAgentName = agentName;
    userDoc.agentEndpoint = agentDetails?.deployment?.url ? `${agentDetails.deployment.url}/api/v1` : null;
    userDoc.agentModelName = agentDetails?.model?.inference_name || agentDetails?.model?.name || null;
    userDoc.agentApiKey = apiKey;
    userDoc.provisioned = true;
    userDoc.provisionedAt = new Date().toISOString();
    // Clear the provision token after successful provisioning
    userDoc.provisionToken = undefined;
    userDoc.provisionTokenCreatedAt = undefined;
    
    await cloudant.saveDocument('maia_users', userDoc);

    updateStatus('User document updated', { updated: true });

    // Mark as completed
    const status = provisioningStatus.get(userId);
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
    const status = provisioningStatus.get(userId);
    if (status) {
      status.status = 'failed';
      status.error = error.message;
      status.completedAt = Date.now();
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

// Serve static files from dist in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
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
  console.log(`\n🤖 Anthropic Model: claude-sonnet-4-5-20250929 (Claude Sonnet 4.5)`);
});

export default app;

