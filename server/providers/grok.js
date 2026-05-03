'use strict';

/**
 * Grok (xAI) provider v2 — streaming + cancelación.
 * API-compatible con OpenAI; delega la lógica a `base/openaiCompatChat.js`.
 */

const OpenAI = require('openai');
const { openaiCompatChat } = require('./base/openaiCompatChat');

module.exports = {
  name: 'grok',
  label: 'Grok (xAI)',
  defaultModel: 'grok-3-fast',
  models: ['grok-3', 'grok-3-mini', 'grok-3-fast'],

  async *chat({ systemPrompt, history, apiKey, model, executeTool, channel, agentRole, signal }) {
    yield* openaiCompatChat({
      OpenAI,
      clientConfig: { apiKey, baseURL: 'https://api.x.ai/v1' },
      providerLabel: 'Grok',
      defaultModel: this.defaultModel,
      systemPrompt, history, model, executeTool, channel, agentRole, signal,
    });
  },
};
