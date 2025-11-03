/**
 * Chat routes for AI provider integrations
 */

import { ChatClient } from '../../lib/chat-client/index.js';

export default function setupChatRoutes(app, chatClient) {
  /**
   * Main chat endpoint - routes to appropriate provider
   * POST /api/chat/:provider
   */
  app.post('/api/chat/:provider', async (req, res) => {
    try {
      const { provider } = req.params;
      const { messages, options = {} } = req.body;

      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Messages array required' });
      }

      // Check if provider is available
      if (!chatClient.isProviderAvailable(provider)) {
        return res.status(400).json({ 
          error: `Provider '${provider}' not available`,
          available: chatClient.getAvailableProviders()
        });
      }

      const startTime = Date.now();

      // Check if streaming is requested
      const stream = options.stream || req.headers.accept === 'text/event-stream';

      if (stream) {
        // Setup SSE streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Handle streaming updates
        await chatClient.chat(provider, messages, { ...options, stream: true }, 
          (update) => {
            res.write(`data: ${JSON.stringify(update)}\n\n`);
            
            if (update.isComplete) {
              res.end();
            }
          }
        );
      } else {
        // Non-streaming response
        const response = await chatClient.chat(provider, messages, options);
        const responseTime = Date.now() - startTime;

        res.json({
          ...response,
          _meta: {
            responseTime,
            provider
          }
        });
      }

    } catch (error) {
      console.error('Chat error:', error);
      const statusCode = error.status || error.statusCode || 500;
      res.status(statusCode).json({ 
        error: error.message || 'Chat request failed',
        type: error.type,
        status: statusCode
      });
    }
  });

  /**
   * List available chat providers
   * GET /api/chat/providers
   */
  app.get('/api/chat/providers', (req, res) => {
    res.json({
      providers: chatClient.getAvailableProviders()
    });
  });
}

