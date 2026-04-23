'use strict';

/**
 * OpenAI provider v2 — streaming + cancelación.
 *
 * Delega a `base/openaiCompatChat.js` el grueso de la lógica; este archivo solo
 * aporta metadatos y config del cliente.
 *
 * Eventos emitidos (contrato v1 outward, por compat con ConversationService):
 *   { type: 'text', text: <chunk> }           — streaming progresivo
 *   { type: 'tool_call', name, args }
 *   { type: 'tool_result', name, result }
 *   { type: 'usage', promptTokens, completionTokens }
 *   { type: 'done', fullText }
 */

const OpenAI = require('openai');
const { openaiCompatChat } = require('./base/openaiCompatChat');

module.exports = {
  name: 'openai',
  label: 'OpenAI',
  defaultModel: 'gpt-4o',
  models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'],

  async *chat({ systemPrompt, history, apiKey, model, executeTool, channel, agentRole, signal }) {
    yield* openaiCompatChat({
      OpenAI,
      clientConfig: { apiKey },
      providerLabel: 'OpenAI',
      defaultModel: this.defaultModel,
      systemPrompt, history, model, executeTool, channel, agentRole, signal,
    });
  },
};
