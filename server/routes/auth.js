/**
 * Authentication routes for user app
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Helper to get client info for audit logging
function getClientInfo(req) {
  return {
    ip: req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown',
    userAgent: req.headers['user-agent'] || 'unknown'
  };
}

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
  console.log(`[NEW FLOW 2] Creating bucket folders for user: ${userId}, KB: ${kbName}`);
  
  const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
  if (!bucketUrl) {
    throw new Error('DigitalOcean bucket not configured');
  }
  
  const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
  
  try {
    const s3Client = new S3Client({
      endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
      region: 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
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
    console.log(`[NEW FLOW 2] Created root folder: ${userId}/`);
    
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
    console.log(`[NEW FLOW 2] Created archived folder: ${userId}/archived/`);
    
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
    console.log(`[NEW FLOW 2] Created KB folder: ${userId}/${kbName}/`);
    
    console.log(`[NEW FLOW 2] ✅ All bucket folders created successfully for ${userId}`);
    return { root: `${userId}/`, archived: `${userId}/archived/`, kb: `${userId}/${kbName}/` };
  } catch (err) {
    console.error(`[NEW FLOW 2] ❌ Failed to create bucket folders: ${err.message}`);
    throw new Error(`Failed to create bucket folders: ${err.message}`);
  }
}

export default function setupAuthRoutes(app, passkeyService, cloudant, doClient, auditLog, emailService) {
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
      const { userId, displayName, email } = req.body;

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
      if (existingUser && email) {
        existingUser.email = email; // Update email if provided
      }
      const userDoc = existingUser || {
        _id: userId,
        userId,
        displayName,
        email: email || null,
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
      
      console.log(`[NEW FLOW 2] Starting pre-provisioning setup for user: ${updatedUser.userId}`);
      
      // Generate agent name and KB name BEFORE admin approval
      const agentName = generateAgentName(updatedUser.userId);
      const kbName = generateKBName(updatedUser.userId);
      
      console.log(`[NEW FLOW 2] Generated agent name: ${agentName}`);
      console.log(`[NEW FLOW 2] Generated KB name: ${kbName}`);
      
      // Store agent name and KB name in user document
      updatedUser.assignedAgentName = agentName;
      updatedUser.kbName = kbName;
      
      // Create bucket folders immediately (enables file uploads before admin approval)
      try {
        await createUserBucketFolders(updatedUser.userId, kbName);
        console.log(`[NEW FLOW 2] ✅ Bucket folders created for ${updatedUser.userId}`);
      } catch (folderError) {
        console.error(`[NEW FLOW 2] ❌ Failed to create bucket folders: ${folderError.message}`);
        // Don't fail registration if folder creation fails, but log it
        // User can still proceed, folders will be created during provisioning if needed
      }
      
      // Generate provisioning token for admin deep link
      const provisionToken = emailService.generateProvisionToken(updatedUser.userId);
      updatedUser.provisionToken = provisionToken;
      updatedUser.provisionTokenCreatedAt = new Date().toISOString();
      
      // workflowStage will be set to 'request_sent' after admin email is sent (in registration-complete)
      // For now, keep it as null or set to a pre-request state
      // Don't set workflowStage yet - email hasn't been sent
      
      // Initialize initialFile field (will be set if user uploads a file during registration)
      updatedUser.initialFile = null;
      
      await cloudant.saveDocument('maia_users', updatedUser);
      console.log(`[NEW FLOW 2] ✅ User document saved with agent name and KB name`);

      // Set session
      req.session.userId = updatedUser.userId;
      req.session.username = updatedUser.userId;
      req.session.displayName = updatedUser.displayName;
      req.session.authenticatedAt = new Date().toISOString();
      req.session.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      // Log passkey registration
      const clientInfo = getClientInfo(req);
      await auditLog.logEvent({
        type: 'passkey_registered',
        userId: updatedUser.userId,
        ip: clientInfo.ip,
        userAgent: clientInfo.userAgent
      });

      console.log(`[NEW FLOW 2] Passkey registration logged for ${updatedUser.userId}`);
      console.log(`[NEW FLOW 2] Ready to show file import dialog - folders created, names generated`);

      // Return success with flag indicating file import dialog should be shown
      // The frontend will handle showing the dialog and uploading files
      res.json({ 
        success: true, 
        user: {
          userId: updatedUser.userId,
          displayName: updatedUser.displayName
        },
        showFileImport: true, // Flag to trigger file import dialog
        kbName: kbName // Pass KB name to frontend for file upload
      });
    } catch (error) {
      console.error('Registration verify error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Registration complete - called after file import (or if user skips file)
  app.post('/api/passkey/registration-complete', async (req, res) => {
    try {
      const { userId, initialFile } = req.body;

      if (!userId) {
        return res.status(400).json({ error: 'User ID required' });
      }

      console.log(`[NEW FLOW 2] Completing registration for user: ${userId}`);
      console.log(`[NEW FLOW 2] Initial file:`, initialFile ? `${initialFile.fileName} (${initialFile.bucketKey})` : 'none');

      // Get user document
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Update user document with initial file info if provided
      if (initialFile) {
        userDoc.initialFile = {
          fileName: initialFile.fileName,
          bucketKey: initialFile.bucketKey,
          fileSize: initialFile.fileSize,
          uploadedAt: initialFile.uploadedAt || new Date().toISOString()
        };
        console.log(`[NEW FLOW 2] Stored initial file info in user document: ${initialFile.fileName}`);
      } else {
        userDoc.initialFile = null;
        console.log(`[NEW FLOW 2] No initial file - user proceeding without file`);
      }

      // Set workflowStage to request_sent (admin will be notified)
      userDoc.workflowStage = 'request_sent';
      console.log(`[NEW FLOW 2] Setting workflowStage to 'request_sent' for ${userId}`);

      await cloudant.saveDocument('maia_users', userDoc);
      console.log(`[NEW FLOW 2] User document updated with initial file and workflowStage`);

      // Send email notification to admin (only now, after file import decision)
      try {
        const provisionToken = userDoc.provisionToken;
        await emailService.sendNewUserNotification({
          userId: userDoc.userId,
          displayName: userDoc.displayName || userDoc.userId,
          email: userDoc.email || null,
          provisionToken: provisionToken
        });
        console.log(`[NEW FLOW 2] ✅ Admin notification email sent for ${userId}`);
      } catch (emailError) {
        // Log error but don't fail registration if email fails
        console.error('[NEW FLOW 2] ❌ Failed to send admin notification email:', emailError);
      }

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
      await cloudant.saveDocument('maia_users', updatedUser);

      // Set session
      req.session.userId = updatedUser.userId;
      req.session.username = updatedUser.userId;
      req.session.displayName = updatedUser.displayName;
      req.session.authenticatedAt = new Date().toISOString();
      req.session.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      // Log successful login
      await auditLog.logEvent({
        type: 'login_success',
        userId: updatedUser.userId,
        ip: clientInfo.ip,
        userAgent: clientInfo.userAgent
      });

      res.json({ 
        success: true, 
        user: {
          userId: updatedUser.userId,
          displayName: updatedUser.displayName
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
}

