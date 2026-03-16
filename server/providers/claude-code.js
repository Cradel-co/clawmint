'use strict';

/**
 * Provider: Claude Code (claude -p CLI)
 * Wrapper sobre ClaudePrintSession — Claude Code maneja tools internamente.
 */
module.exports = {
  name: 'claude-code',
  label: 'Claude Code',
  defaultModel: null,
  models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],

  /**
   * @param {{ systemPrompt, history, apiKey, model, workDir, claudeSession, onChunk }} opts
   * claudeSession: instancia de ClaudePrintSession (requerida para este provider)
   * onChunk: callback(partialText) para streaming progresivo
   */
  async *chat({ systemPrompt, history, model, claudeSession, onChunk }) {
    if (!claudeSession) {
      yield { type: 'done', fullText: 'Error: claudeSession requerida para claude-code provider' };
      return;
    }

    // El último elemento del history es el mensaje del usuario
    const lastMsg = history[history.length - 1];
    let messageText = lastMsg?.content || '';

    // Si es el primer mensaje y hay systemPrompt, prependerlo
    if (claudeSession.messageCount === 0 && systemPrompt) {
      messageText = `${systemPrompt}\n\n---\n\n${messageText}`;
    }

    try {
      const fullText = await claudeSession.sendMessage(messageText, onChunk);
      yield { type: 'done', fullText };
    } catch (err) {
      yield { type: 'done', fullText: `Error: ${err.message}` };
    }
  },
};
