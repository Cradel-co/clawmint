'use strict';

/**
 * Provider: Claude Code (claude -p CLI)
 * Wrapper sobre ClaudePrintSession — Claude Code maneja tools internamente.
 *
 * D4 — Este provider ahora emite eventos enriquecidos (tool_call, tool_result,
 * thinking, usage) parseados desde el stream-json del CLI, en paridad con
 * anthropic.js. Antes solo emitía `{ type: 'done', fullText }`.
 */
module.exports = {
  name: 'claude-code',
  label: 'Claude Code',
  defaultModel: 'claude-haiku-4-5-20251001',
  models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],

  /**
   * @param {object} opts
   * @param {string|Array} opts.systemPrompt
   * @param {Array} opts.history
   * @param {string} [opts.model]
   * @param {object} opts.claudeSession — instancia de ClaudePrintSession (requerida)
   * @param {Function} [opts.onChunk]   — streaming parcial
   */
  async *chat({ systemPrompt, history, model, claudeSession, onChunk }) {
    if (!claudeSession) {
      yield { type: 'done', fullText: 'Error: claudeSession requerida para claude-code provider' };
      return;
    }

    // El último elemento del history es el mensaje del usuario
    const lastMsg = history[history.length - 1];
    let messageText = lastMsg?.content || '';
    // Si system llega como array (D3), lo join-eamos a string para pasarlo via --append-system-prompt
    // del CLI en turno 0. El CLI internamente maneja cache, pero aceptamos una degradación aquí
    // porque `claudeSession.appendSystemPrompt` ya se setea en bootstrap.
    const systemStr = Array.isArray(systemPrompt)
      ? systemPrompt.map(b => (typeof b === 'string' ? b : b.text || '')).filter(Boolean).join('\n\n')
      : systemPrompt;

    if (claudeSession.messageCount === 0 && systemStr) {
      messageText = `${systemStr}\n\n---\n\n${messageText}`;
    }

    // D4 — buffer de eventos recibidos del CLI para yield-earlos aquí
    // (sendMessage es asíncrono completo, no un generador — buffer + drenamos tras resolve).
    const pendingEvents = [];
    const onEvent = (ev) => { pendingEvents.push(ev); };

    try {
      const raw = await claudeSession.sendMessage(messageText, onChunk, null, onEvent);
      // sendMessage puede retornar string (mocks/legacy) o { text, usedMcpTools }
      const fullText = typeof raw === 'string' ? raw : (raw?.text || '');

      // D4 — drenar eventos capturados en orden
      let usage = null;
      for (const ev of pendingEvents) {
        if (ev.type === 'tool_call') {
          yield { type: 'tool_call', name: ev.name, args: ev.args || {}, id: ev.id };
        } else if (ev.type === 'tool_result') {
          yield { type: 'tool_result', tool_use_id: ev.tool_use_id, result: ev.content, isError: !!ev.isError };
        } else if (ev.type === 'thinking') {
          yield { type: 'thinking', text: ev.text };
        } else if (ev.type === 'usage') {
          // Último usage gana (el `result` event trae el agregado con cost)
          usage = ev;
        }
      }
      if (usage) {
        yield {
          type: 'usage',
          promptTokens: usage.promptTokens || 0,
          completionTokens: usage.completionTokens || 0,
        };
        if (usage.cacheCreation || usage.cacheRead) {
          yield { type: 'cache_stats', creation: usage.cacheCreation || 0, read: usage.cacheRead || 0 };
        }
      }
      yield { type: 'done', fullText };
    } catch (err) {
      yield { type: 'done', fullText: `Error: ${err.message}` };
    }
  },
};
