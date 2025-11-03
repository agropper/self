/**
 * DigitalOcean Personal AI provider with streaming support
 * Uses OpenAI SDK with custom baseURL for DO GenAI endpoint
 */

import { BaseChatProvider } from './base-provider.js';
import OpenAI from 'openai';
import { StreamingMessageBuilder } from '../streaming/message-builder.js';

export class DigitalOceanProvider extends BaseChatProvider {
  constructor(apiKey, config = {}) {
    super('digitalocean', config);
    this.apiKey = apiKey;
    this.baseURL = config.baseURL || 'https://vzfujeetn2dkj4d5awhvvibo.agents.do-ai.run/api/v1';
    this.client = null;
    
    if (apiKey) {
      this.client = new OpenAI({
        apiKey: apiKey,
        baseURL: this.baseURL
      });
    }
  }

  validateConfig() {
    if (!this.apiKey) {
      throw new Error('DigitalOcean Personal API key is required');
    }
    return true;
  }

  /**
   * Chat with DigitalOcean Personal AI
   */
  async chat(messages, options = {}, onUpdate = null) {
    if (!this.client) {
      throw new Error('DigitalOcean client not initialized');
    }

    const formattedMessages = this.formatMessages(messages);
    const model = options.model || 'deepseek-r1';
    const temperature = options.temperature || 0.7;
    const maxTokens = options.maxTokens || 4096;
    const system = options.system;

    // OpenAI format expects messages with name field
    const openAIMessages = formattedMessages.map(msg => {
      const formatted = {
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      };
      if (msg.name) {
        formatted.name = msg.name;
      }
      return formatted;
    });

    // Add system message if provided
    if (system) {
      openAIMessages.unshift({ role: 'system', content: system });
    }

    try {
      // If streaming requested and callback provided
      if (options.stream && onUpdate) {
        return await this.streamChat(openAIMessages, {
          model,
          temperature,
          max_tokens: maxTokens
        }, onUpdate);
      }

      // Non-streaming request
      const response = await this.client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: openAIMessages
      });

      const content = response.choices[0]?.message?.content || '';

      return {
        role: 'assistant',
        content,
        model: model,
        usage: response.usage
      };

    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Stream chat response
   */
  async streamChat(messages, params, onUpdate) {
    const streamBuilder = new StreamingMessageBuilder(onUpdate);

    try {
      // Log request details for debugging large requests
      const totalChars = messages.reduce((sum, msg) => sum + (typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length), 0);
      const estimatedTokens = Math.ceil(totalChars / 4); // Rough estimate: ~4 chars per token
      console.log(`[DO STREAM] Model: ${params.model || 'default'}, Messages: ${messages.length}, Total chars: ${totalChars}, Est. tokens: ${estimatedTokens}`);
      
      // For large requests, check if we're exceeding likely limits
      if (estimatedTokens > 50000) {
        console.warn(`[DO STREAM] WARNING: Request is very large (${estimatedTokens} tokens). This may exceed model context limits.`);
      }
      
      const stream = await this.client.chat.completions.create({
        ...params,
        messages,
        stream: true
      });

      // Handle OpenAI streaming format
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          streamBuilder.addChunk({ type: 'text', text: delta });
        }
      }

      streamBuilder.complete({
        model: params.model
      });

      return {
        role: 'assistant',
        content: streamBuilder.getContent(),
        model: params.model
      };
    } catch (error) {
      // Enhanced error logging for 400 errors
      const status = error.status || error.statusCode || 500;
      const errorInfo = {
        status,
        message: error.message,
        type: error.constructor?.name || 'Error'
      };
      
      // Try to extract response body from various places the OpenAI SDK might store it
      // For streaming requests, the body might already be consumed, but we'll try
      if (error.response) {
        // Try to clone the response if it hasn't been consumed yet
        try {
          if (error.response.clone) {
            const clonedResponse = error.response.clone();
            const errorText = await clonedResponse.text();
            if (errorText) {
              errorInfo.responseBody = errorText;
              try {
                errorInfo.parsedBody = JSON.parse(errorText);
                if (errorInfo.parsedBody.error?.message) {
                  errorInfo.errorMessage = errorInfo.parsedBody.error.message;
                } else if (errorInfo.parsedBody.message) {
                  errorInfo.errorMessage = errorInfo.parsedBody.message;
                }
              } catch (e) {
                // Not JSON, keep as text
              }
            }
          } else if (error.response.body && typeof error.response.body.getReader === 'function') {
            // Try to read from the body stream
            const reader = error.response.body.getReader();
            const { value } = await reader.read();
            if (value) {
              const errorText = new TextDecoder().decode(value);
              errorInfo.responseBody = errorText;
              try {
                errorInfo.parsedBody = JSON.parse(errorText);
                if (errorInfo.parsedBody.error?.message) {
                  errorInfo.errorMessage = errorInfo.parsedBody.error.message;
                } else if (errorInfo.parsedBody.message) {
                  errorInfo.errorMessage = errorInfo.parsedBody.message;
                }
              } catch (e) {
                // Not JSON, keep as text
              }
            }
          }
        } catch (e) {
          // Body already consumed or not readable
          errorInfo.bodyReadError = e.message;
        }
        
        // Check other possible locations
        if (error.response.data) {
          errorInfo.responseData = error.response.data;
        }
        if (error.response.headers) {
          errorInfo.responseHeaders = Object.fromEntries(error.response.headers.entries?.() || []);
          // Check content-length to see if there should be a body
          const contentLength = error.response.headers.get?.('content-length') || 
                               (error.response.headers['content-length'] instanceof Headers ? error.response.headers.get('content-length') : error.response.headers['content-length']);
          if (contentLength && contentLength !== '0') {
            errorInfo.expectedBodySize = contentLength;
          }
        }
      }
      
      // Check if error has body property directly (some SDK versions)
      if (error.body) {
        try {
          if (typeof error.body === 'string') {
            errorInfo.errorBody = error.body;
            errorInfo.parsedBody = JSON.parse(error.body);
          } else if (error.body.getReader) {
            const reader = error.body.getReader();
            const { value } = await reader.read();
            if (value) {
              errorInfo.errorBody = new TextDecoder().decode(value);
              errorInfo.parsedBody = JSON.parse(errorInfo.errorBody);
            }
          }
        } catch (e) {
          // Couldn't read body
        }
      }
      
      // Also check error.error (OpenAI SDK sometimes puts details here)
      if (error.error) {
        errorInfo.errorObject = error.error;
      }
      
      // Log detailed error info
      console.error('[DO STREAM ERROR]', JSON.stringify(errorInfo, null, 2));
      console.error('[DO STREAM ERROR - Full]', error);
      
      // Re-throw with proper error formatting
      throw this.handleError(error);
    }
  }

  /**
   * Mock chat for testing
   */
  async mockChat(messages, options, onUpdate) {
    const streamBuilder = new StreamingMessageBuilder(onUpdate);
    const mockResponse = "I'm your Private AI Assistant. I'm powered by DigitalOcean's GenAI platform.";
    
    // Simulate streaming
    for (let i = 0; i < mockResponse.length; i += 5) {
      const chunk = mockResponse.slice(i, i + 5);
      streamBuilder.addChunk({ type: 'text', text: chunk });
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    streamBuilder.complete({ model: 'deepseek-r1' });

    return {
      role: 'assistant',
      content: streamBuilder.getContent(),
      model: 'deepseek-r1',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    };
  }
}

