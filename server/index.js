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
    const needsUpdate = 
      userDoc.assignedAgentId !== userAgent.uuid ||
      userDoc.assignedAgentName !== userAgent.name ||
      !userAgent.deployment?.url;
    
    if (needsUpdate) {
      userDoc.assignedAgentId = userAgent.uuid;
      userDoc.assignedAgentName = userAgent.name;
      userDoc.agentEndpoint = userAgent.deployment?.url ? `${userAgent.deployment.url}/api/v1` : null;
      
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

