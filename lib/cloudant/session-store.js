/**
 * Cloudant session store for express-session
 */

import session from 'express-session';

const Store = session.Store;

export class CloudantSessionStore extends Store {
  constructor(options = {}) {
    super(options);
    this.cloudantClient = options.cloudantClient;
    this.dbName = options.dbName || 'maia_sessions';
    this.ttl = options.ttl || 24 * 60 * 60 * 1000; // 24 hours default

    if (!this.cloudantClient) {
      throw new Error('CloudantClient is required');
    }
  }

  /**
   * Get session from Cloudant
   */
  async get(sessionId, callback) {
    try {
      if (!sessionId || typeof sessionId !== 'string') {
        if (callback) callback(null, null);
        return;
      }

      const cleanSessionId = sessionId.trim();
      if (!cleanSessionId || cleanSessionId === 'undefined') {
        if (callback) callback(null, null);
        return;
      }

      const docId = `session_${cleanSessionId}`;
      const sessionDoc = await this.cloudantClient.getDocument(this.dbName, docId);

      if (!sessionDoc || !sessionDoc.isActive) {
        if (callback) callback(null, null);
        return;
      }

      // Check if session has expired
      const now = new Date();
      const lastActivity = new Date(sessionDoc.lastActivity);

      if ((now - lastActivity) > this.ttl) {
        await this.destroy(cleanSessionId, () => {});
        if (callback) callback(null, null);
        return;
      }

      const sessionData = {
        userId: sessionDoc.userId,
        username: sessionDoc.username,
        displayName: sessionDoc.displayName,
        sessionType: sessionDoc.sessionType,
        lastActivity: sessionDoc.lastActivity,
        createdAt: sessionDoc.createdAt,
        expiresAt: sessionDoc.expiresAt,
        authenticatedAt: sessionDoc.authenticatedAt
      };

      if (callback) callback(null, sessionData);
    } catch (error) {
      if (callback) callback(error, null);
    }
  }

  /**
   * Set session in Cloudant
   */
  async set(sessionId, sessionData, callback) {
    try {
      if (!sessionId || typeof sessionId !== 'string') {
        if (callback) callback(new Error('Invalid sessionId'));
        return;
      }

      const cleanSessionId = sessionId.trim();
      if (!cleanSessionId || cleanSessionId === 'undefined') {
        if (callback) callback(new Error('Invalid sessionId value'));
        return;
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.ttl);

      const sessionDoc = {
        _id: `session_${cleanSessionId}`,
        sessionId: cleanSessionId,
        isActive: true,
        userId: sessionData.userId,
        username: sessionData.username,
        displayName: sessionData.displayName,
        sessionType: sessionData.sessionType || 'authenticated',
        lastActivity: now.toISOString(),
        createdAt: sessionData.createdAt || now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        authenticatedAt: sessionData.authenticatedAt
      };

      await this.cloudantClient.saveDocument(this.dbName, sessionDoc);
      if (callback) callback(null);
    } catch (error) {
      if (callback) callback(error);
    }
  }

  /**
   * Destroy session
   */
  async destroy(sessionId, callback) {
    try {
      const cleanSessionId = sessionId.trim();
      const docId = `session_${cleanSessionId}`;
      await this.cloudantClient.deleteDocument(this.dbName, docId);
      if (callback) callback(null);
    } catch (error) {
      // If document doesn't exist, that's okay for destroy operations
      if (callback) callback(null);
    }
  }

  /**
   * Touch session (update lastActivity)
   */
  async touch(sessionId, sessionData, callback) {
    try {
      const cleanSessionId = sessionId.trim();
      const docId = `session_${cleanSessionId}`;
      
      const existing = await this.cloudantClient.getDocument(this.dbName, docId);
      if (existing) {
        existing.lastActivity = new Date().toISOString();
        await this.cloudantClient.saveDocument(this.dbName, existing);
      }
      // If doesn't exist, that's okay for touch operations
      
      if (callback) callback(null);
    } catch (error) {
      if (callback) callback(error);
    }
  }
}

