/**
 * Chat routes for AI provider integrations
 */

import { ChatClient } from '../../lib/chat-client/index.js';
import { DigitalOceanProvider } from '../../lib/chat-client/providers/digitalocean.js';
import { getOrCreateAgentApiKey, recreateAgentApiKey } from '../utils/agent-helper.js';

export default function setupChatRoutes(app, chatClient, cloudant, doClient) {
  /**
   * Main chat endpoint - routes to appropriate provider
   * POST /api/chat/:provider
   */
  app.post('/api/chat/:provider', async (req, res) => {
    // Declare userAgentProvider outside try block for error handling
    let userAgentProvider = null;
    
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

      // For DigitalOcean provider, check if user has a specific agent
      if (provider === 'digitalocean' && cloudant && doClient) {
        const userId = req.session?.userId;
        
        if (userId) {
          const userDoc = await cloudant.getDocument('maia_users', userId);
          
          if (userDoc.assignedAgentId && userDoc.agentEndpoint && userDoc.assignedAgentName) {
            // Get or create agent API key
            const apiKey = await getOrCreateAgentApiKey(doClient, cloudant, userId, userDoc.assignedAgentId);
            
            // Create provider with agent-specific endpoint and key
            userAgentProvider = new DigitalOceanProvider(apiKey, {
              baseURL: userDoc.agentEndpoint
            });
            
            // Use the stored model name if available (from agent sync)
            // This should be the model's inference_name from the agent details
            if (userDoc.agentModelName) {
              options.model = userDoc.agentModelName;
            } else {
              // Fallback to agent name (may not work, but keeps old behavior)
              options.model = userDoc.assignedAgentName;
            }
          }
        }
      }

      const startTime = Date.now();

      // Check if streaming is requested
      const stream = options.stream || req.headers.accept === 'text/event-stream';

      // Use user-specific agent provider if available, otherwise use default
      if (stream) {
        // Setup SSE streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Handle streaming updates
        if (userAgentProvider) {
          // Log request details for debugging large requests
          const totalChars = messages.reduce((sum, msg) => sum + (typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content || '').length), 0);
          const estimatedTokens = Math.ceil(totalChars / 4); // Rough estimate
          const requestSizeKB = (JSON.stringify(messages).length / 1024).toFixed(2);
          console.log(`[AGENT REQUEST] Model: ${options.model || 'default'}, Messages: ${messages.length}, Chars: ${totalChars}, Est. tokens: ${estimatedTokens}, Size: ${requestSizeKB}KB`);
          
          await userAgentProvider.chat(messages, { ...options, stream: true }, 
            (update) => {
              res.write(`data: ${JSON.stringify(update)}\n\n`);
              
              if (update.isComplete) {
                res.end();
              }
            }
          );
        } else {
          await chatClient.chat(provider, messages, { ...options, stream: true }, 
            (update) => {
              res.write(`data: ${JSON.stringify(update)}\n\n`);
              
              if (update.isComplete) {
                res.end();
              }
            }
          );
        }
      } else {
        // Non-streaming response
        let response;
        if (userAgentProvider) {
          response = await userAgentProvider.chat(messages, options);
        } else {
          response = await chatClient.chat(provider, messages, options);
        }
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
      
      let errorMessage = error.message || 'Chat request failed';
      
      // Provide helpful error message for 401 on agent endpoints
      if (statusCode === 401 && userAgentProvider) {
        errorMessage = 'Authentication failed for your Private AI agent. The API key may need to be recreated.';
        console.error('401 Unauthorized on agent endpoint');
      }
      
      // Enhance error messages for token limit errors (400 status with token limit message)
      // IMPORTANT: Use req.body.messages directly (never reference try-block variables)
      // Wrap in try-catch to ensure error enhancement never crashes the error handler
      if (statusCode === 400 && errorMessage && errorMessage.toLowerCase().includes('token')) {
        try {
          // Extract token limit from error message if present
          const tokenLimitMatch = errorMessage.match(/(\d+)\s*tokens?/i);
          const tokenLimit = tokenLimitMatch ? tokenLimitMatch[1] : null;
          
          // Safely access messages from req.body (always available from request)
          const messages = req.body?.messages;
          let estimatedTokens = null;
          
          if (messages && Array.isArray(messages)) {
            try {
              const totalChars = messages.reduce((sum, msg) => {
                if (msg?.content) {
                  return sum + (typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length);
                }
                return sum;
              }, 0);
              estimatedTokens = Math.ceil(totalChars / 4);
            } catch (calcError) {
              // If calculation fails, just skip token count enhancement
              console.warn('Could not calculate token count for error enhancement:', calcError.message);
            }
          }
          
          // Build helpful error message only if we have the necessary data
          if (tokenLimit || estimatedTokens !== null) {
            let enhancedMessage = errorMessage;
            
            if (tokenLimit && estimatedTokens !== null) {
              enhancedMessage = `**Request too large**\n\n` +
                `Your request contains approximately ${estimatedTokens.toLocaleString()} tokens, which exceeds the model's maximum input limit of ${parseInt(tokenLimit).toLocaleString()} tokens.\n\n` +
                `**Suggestions:**\n` +
                `- Try reducing the size of attached files\n` +
                `- Split large documents into smaller sections\n` +
                `- Remove unnecessary context from your message\n` +
                `- Try asking more specific questions about smaller portions of your documents`;
            } else if (tokenLimit) {
              enhancedMessage = `**Request too large**\n\n` +
                `Your request exceeds the model's maximum input limit of ${parseInt(tokenLimit).toLocaleString()} tokens.\n\n` +
                `**Suggestions:**\n` +
                `- Try reducing the size of attached files\n` +
                `- Split large documents into smaller sections\n` +
                `- Remove unnecessary context from your message`;
            } else if (estimatedTokens !== null) {
              enhancedMessage = `**Request too large**\n\n` +
                `Your request contains approximately ${estimatedTokens.toLocaleString()} tokens, which exceeds the model's context limit.\n\n` +
                `**Suggestions:**\n` +
                `- Try reducing the size of attached files\n` +
                `- Split large documents into smaller sections\n` +
                `- Remove unnecessary context from your message`;
            }
            
            errorMessage = enhancedMessage;
          }
        } catch (enhancementError) {
          // If error enhancement fails, log it but don't crash - just use original error message
          console.warn('Error enhancement failed (non-critical):', enhancementError.message);
          // Continue with original errorMessage
        }
      }
      
      res.status(statusCode).json({ 
        error: errorMessage,
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
