'use strict';

/**
 * Provider: Gemini CLI (gemini -p)
 * Wrapper sobre GeminiCliSession — análogo a claude-code.js.
 * Gemini gestiona sus herramientas MCP internamente via ~/.gemini/settings.json.
 */
module.exports = {
  name: 'gemini-cli',
  label: 'Gemini CLI',
  defaultModel: null,
  models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],

  /**
   * @param {{ systemPrompt, history, model, geminiSession, onChunk }} opts
   * geminiSession: instancia de GeminiCliSession (requerida)
   * onChunk: callback(partialText) para streaming progresivo
   */
  async *chat({ systemPrompt, history, model, geminiSession, onChunk }) {
    if (!geminiSession) {
      yield { type: 'done', fullText: 'Error: geminiSession requerida para gemini-cli provider' };
      return;
    }

    const lastMsg = history[history.length - 1];
    let messageText = lastMsg?.content || '';

    // Primer mensaje: inyectar system prompt al inicio
    if (geminiSession.messageCount === 0 && systemPrompt) {
      messageText = `${systemPrompt}\n\n---\n\n${messageText}`;
    }

    if (model && !geminiSession.model) geminiSession.model = model;

    try {
      const { text } = await geminiSession.sendMessage(messageText, onChunk);
      yield {
        type: 'usage',
        promptTokens:     geminiSession.totalInputTokens,
        completionTokens: geminiSession.totalOutputTokens,
      };
      yield { type: 'done', fullText: text };
    } catch (err) {
      yield { type: 'done', fullText: `Error Gemini CLI: ${err.message}` };
    }
  },
};
