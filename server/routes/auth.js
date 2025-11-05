/**
 * Authentication routes for user app
 */

// Helper to get client info for audit logging
function getClientInfo(req) {
  return {
    ip: req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown',
    userAgent: req.headers['user-agent'] || 'unknown'
  };
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
      
      // Generate provisioning token for admin deep link
      const provisionToken = emailService.generateProvisionToken(updatedUser.userId);
      updatedUser.provisionToken = provisionToken;
      updatedUser.provisionTokenCreatedAt = new Date().toISOString();
      
      // Set workflowStage to request_sent (admin has been notified and can provision)
      updatedUser.workflowStage = 'request_sent';
      
      // Generate knowledge base name: userId-kb-<MMDDYYYYHHMM>
      const now = new Date();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const year = now.getFullYear();
      const hour = String(now.getHours()).padStart(2, '0');
      const minute = String(now.getMinutes()).padStart(2, '0');
      const kbName = `${updatedUser.userId}-kb-${month}${day}${year}${hour}${minute}`;
      
      updatedUser.connectedKB = kbName;
      updatedUser.kbStatus = 'pending';
      
      await cloudant.saveDocument('maia_users', updatedUser);

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

      // Send email notification to admin
      try {
        await emailService.sendNewUserNotification({
          userId: updatedUser.userId,
          displayName: updatedUser.displayName || updatedUser.userId,
          email: updatedUser.email || null,
          provisionToken: provisionToken
        });
      } catch (emailError) {
        // Log error but don't fail registration if email fails
        console.error('❌ Failed to send admin notification email:', emailError);
      }

      res.json({ 
        success: true, 
        user: {
          userId: updatedUser.userId,
          displayName: updatedUser.displayName
        }
      });
    } catch (error) {
      console.error('Registration verify error:', error);
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
        displayName: req.session.displayName
      }
    });
  });
}

