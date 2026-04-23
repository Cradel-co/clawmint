'use strict';

/**
 * DeepSeek provider v2 — streaming + cancelación.
 * API-compatible con OpenAI; delega la lógica a `base/openaiCompatChat.js`.
 */

const OpenAI = require('openai');
const { openaiCompatChat } = require('./base/openaiCompatChat');

const DEEPSEEK_TIMEOUT_MS = 60_000;

module.exports = {
  name: 'deepseek',
  label: 'DeepSeek',
  defaultModel: 'deepseek-chat',
  models: ['deepseek-chat', 'deepseek-reasoner'],

  async *chat({ systemPrompt, history, apiKey, model, executeTool, channel, agentRole, signal }) {
    yield* openaiCompatChat({
      OpenAI,
      clientConfig: { apiKey, baseURL: 'https://api.deepseek.com', timeout: DEEPSEEK_TIMEOUT_MS },
      providerLabel: 'DeepSeek',
      defaultModel: this.defaultModel,
      systemPrompt, history, model, executeTool, channel, agentRole, signal,
    });
  },
};
