/**
 * Email service for admin notifications
 * Uses Resend API for sending emails
 */

export class EmailService {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.RESEND_API_KEY;
    this.fromEmail = options.fromEmail || process.env.RESEND_FROM_EMAIL;
    this.adminEmail = options.adminEmail || process.env.RESEND_ADMIN_EMAIL;
    this.baseUrl = options.baseUrl || process.env.PUBLIC_APP_URL || 'http://localhost:3001';
  }

  /**
   * Send email notification to admin about new user registration
   * @param {Object} options
   * @param {string} options.userId - User ID
   * @param {string} options.displayName - User display name
   * @param {string} options.email - User email address
   * @param {string} options.provisionToken - Provisioning token for deep link
   */
  async sendNewUserNotification({ userId, displayName, email, provisionToken }) {
    if (!this.apiKey || !this.fromEmail || !this.adminEmail) {
      console.warn('⚠️  Email service not configured (RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_ADMIN_EMAIL)');
      return { success: false, error: 'Email service not configured' };
    }

    const provisionUrl = `${this.baseUrl}/api/admin/provision?token=${provisionToken}&userId=${userId}`;

    const emailData = {
      from: this.fromEmail,
      to: this.adminEmail,
      subject: `New User Registration: ${displayName || userId}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">New User Registration</h2>
          <p>A new user has registered with passkey authentication:</p>
          <ul style="list-style: none; padding: 0;">
            <li><strong>User ID:</strong> ${userId}</li>
            <li><strong>Display Name:</strong> ${displayName || userId}</li>
            ${email ? `<li><strong>Email:</strong> ${email}</li>` : ''}
            <li><strong>Registered:</strong> ${new Date().toISOString()}</li>
          </ul>
          <p>Click the link below to provision this user (create agent and Spaces folder):</p>
          <p style="margin: 20px 0;">
            <a href="${provisionUrl}" 
               style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">
              Provision User
            </a>
          </p>
          <p style="color: #666; font-size: 12px; margin-top: 30px;">
            This is an automated notification from MAIA User App.
          </p>
        </div>
      `
    };

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(emailData)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Resend API error:', response.status, errorText);
        return { success: false, error: `Resend API error: ${response.status}` };
      }

      const result = await response.json();
      console.log('✅ New user notification email sent to admin');
      return { success: true, messageId: result.id };
    } catch (error) {
      console.error('❌ Error sending email:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send provisioning completion email to user
   * @param {Object} options
   * @param {string} options.userId - User ID
   * @param {string} options.userEmail - User email address
   * @param {boolean} options.success - Whether provisioning succeeded
   * @param {string} options.errorDetails - Error details if provisioning failed
   */
  async sendProvisioningCompletionEmail({ userId, userEmail, success, errorDetails = null }) {
    if (!this.apiKey || !this.fromEmail) {
      console.warn('⚠️  Email service not configured (RESEND_API_KEY, RESEND_FROM_EMAIL)');
      return { success: false, error: 'Email service not configured' };
    }

    if (!userEmail) {
      console.warn('⚠️  No user email provided, skipping provisioning completion email');
      return { success: false, error: 'No user email provided' };
    }

    const subject = success 
      ? `Private MAIA provisioned for ${userId}`
      : `Private MAIA provisioning failed for ${userId}`;

    const body = success
      ? `Hi ${userId},\n${userEmail}\n\nYour Private AI agent has been provisioned and is ready to receive your health records.\n\nMAIA, including your Private AI agent, can work with imported files directly but large documents may fail and many privacy features will be unavailable. For large files and best results, use the SAVED FILES tab in My Stuff to choose files for indexing into your knowledge base.\n\nI look forward to hearing from you with comments, suggestions and, of course, bugs.\n\n-Adrian`
      : `Hi ${userId},\n${userEmail}\n\nUnfortunately, provisioning of your Private AI agent failed.\n\nError Details:\n${errorDetails || 'Unknown error occurred during provisioning.'}\n\nPlease contact support for assistance.\n\n-Adrian`;

    const emailData = {
      from: this.fromEmail,
      to: userEmail,
      bcc: 'agropper@healthurl.com',
      subject: subject,
      text: body
    };
    
    // Add CC to admin email if configured
    if (this.adminEmail) {
      emailData.cc = this.adminEmail;
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(emailData)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Resend API error:', response.status, errorText);
        return { success: false, error: `Resend API error: ${response.status}` };
      }

      const result = await response.json();
      console.log(`✅ Provisioning ${success ? 'success' : 'failure'} email sent to ${userEmail}`);
      return { success: true, messageId: result.id };
    } catch (error) {
      console.error('❌ Error sending provisioning completion email:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send user deletion notification to admin
   * @param {Object} options
   * @param {string} options.userId - User ID
   * @param {string} options.userEmail - User email address
   * @param {string} options.displayName - User display name
   * @param {Object} options.deletionDetails - Details of what was deleted
   */
  async sendUserDeletionNotification({ userId, userEmail, displayName, deletionDetails }) {
    if (!this.apiKey || !this.fromEmail || !this.adminEmail) {
      console.warn('⚠️  Email service not configured (RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_ADMIN_EMAIL)');
      return { success: false, error: 'Email service not configured' };
    }

    const emailData = {
      from: this.fromEmail,
      to: this.adminEmail,
      subject: `User Deleted: ${displayName || userId}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #d32f2f;">User Account Deleted</h2>
          <p>The following user account has been permanently deleted:</p>
          <ul style="list-style: none; padding: 0;">
            <li><strong>User ID:</strong> ${userId}</li>
            <li><strong>Display Name:</strong> ${displayName || userId}</li>
            <li><strong>Email:</strong> ${userEmail || '(not provided)'}</li>
            <li><strong>Deleted:</strong> ${new Date().toISOString()}</li>
          </ul>
          <h3 style="color: #333; margin-top: 30px;">Deletion Details:</h3>
          <ul style="list-style: none; padding: 0;">
            <li><strong>Spaces Folder:</strong> ${deletionDetails.spacesDeleted ? '✅ Deleted' : '❌ Failed'}</li>
            <li><strong>Files Deleted:</strong> ${deletionDetails.filesDeleted || 0}</li>
            <li><strong>Knowledge Base:</strong> ${deletionDetails.kbDeleted ? '✅ Deleted' : '❌ Failed or not found'}</li>
            <li><strong>Agent:</strong> ${deletionDetails.agentDeleted ? '✅ Deleted' : '❌ Failed or not found'}</li>
            <li><strong>User Document:</strong> ${deletionDetails.userDocDeleted ? '✅ Deleted' : '❌ Failed'}</li>
            <li><strong>Sessions:</strong> ${deletionDetails.sessionsDeleted || 0} deleted</li>
            <li><strong>Chats:</strong> ${deletionDetails.chatsDeleted || 0} deleted</li>
          </ul>
          ${deletionDetails.errors && deletionDetails.errors.length > 0 ? `
            <h3 style="color: #d32f2f; margin-top: 30px;">Errors:</h3>
            <ul>
              ${deletionDetails.errors.map(err => `<li>${err}</li>`).join('')}
            </ul>
          ` : ''}
          <p style="margin-top: 30px; padding: 15px; background-color: #f5f5f5; border-radius: 4px;">
            <strong>User Email:</strong> ${userEmail || '(not provided)'}<br>
            ${userEmail ? 'You may want to send a personal goodbye message to this user.' : 'No email address was provided for this user.'}
          </p>
          <p style="color: #666; font-size: 12px; margin-top: 30px;">
            This is an automated notification from MAIA User App.
          </p>
        </div>
      `
    };

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(emailData)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Resend API error:', response.status, errorText);
        return { success: false, error: `Resend API error: ${response.status}` };
      }

      const result = await response.json();
      console.log('✅ User deletion notification email sent to admin');
      return { success: true, messageId: result.id };
    } catch (error) {
      console.error('❌ Error sending deletion notification email:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate a secure provisioning token
   * In production, this should use a proper token generation method
   */
  generateProvisionToken(userId) {
    // Simple token generation - in production, use crypto.randomBytes or similar
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    return `${userId}_${timestamp}_${random}`;
  }
}

