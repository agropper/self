/**
 * lib-maia-chat
 * Unified chat interface for multiple AI providers
 */

import { BaseChatProvider } from './providers/base-provider.js';
import { DigitalOceanProvider } from './providers/digitalocean.js';
import { AnthropicProvider } from './providers/anthropic.js';

/**
 * Main ChatClient class
 */
export class ChatClient {
  constructor(config = {}) {
    this.config = config;
    this.providers = new Map();

    // Initialize providers based on config
    this.initializeProviders();
  }

  /**
   * Initialize available providers
   */
  initializeProviders() {
    // DigitalOcean Personal AI (first/priority)
    if (this.config.digitalocean?.apiKey) {
      this.providers.set('digitalocean', new DigitalOceanProvider(
        this.config.digitalocean.apiKey,
        {
          baseURL: this.config.digitalocean.baseURL
        }
      ));
    }

    // Anthropic
    if (this.config.anthropic?.apiKey) {
      this.providers.set('anthropic', new AnthropicProvider(
        this.config.anthropic.apiKey,
        {}
      ));
    }

    // TODO: Add other providers
    // - OpenAI/ChatGPT
    // - Google Gemini
    // - DeepSeek
  }

  /**
   * Get a provider by name
   */
  getProvider(name) {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider '${name}' not available`);
    }
    return provider;
  }

  /**
   * Chat with a specific provider
   */
  async chat(providerName, messages, options = {}, onUpdate = null) {
    const provider = this.getProvider(providerName);
    return await provider.chat(messages, options, onUpdate);
  }

  /**
   * List available providers
   */
  getAvailableProviders() {
    return Array.from(this.providers.keys());
  }

  /**
   * Check if a provider is available
   */
  isProviderAvailable(name) {
    return this.providers.has(name);
  }
}

// Export provider classes
export { BaseChatProvider, DigitalOceanProvider, AnthropicProvider };
export { SSEParser, DelimitedParser } from './streaming/stream-parser.js';
export { StreamingMessageBuilder } from './streaming/message-builder.js';

