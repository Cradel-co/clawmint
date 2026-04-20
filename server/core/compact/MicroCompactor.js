'use strict';

/**
 * MicroCompactor — reemplaza tool results viejos por placeholders.
 *
 * NO llama LLM. Es una pasada determinista sobre history:
 *   - Preserva el primer mensaje (normalmente system) intacto
 *   - Preserva los últimos K mensajes intactos (default K=4)
 *   - En los del medio, si es un tool_result de un tool compactable, reemplaza content
 *     por `[Old tool result cleared]` + metadata en un campo `meta`
 *
 * Tools compactables (de Claude Code v2.1.88): bash, read_file, grep, glob, edit_file,
 * write_file, webfetch, websearch. Los demás (memory_*, task_*) se preservan porque
 * son referenciales — el modelo puede volver a consultarlos.
 *
 * Emite hooks `pre_compact` / `post_compact` si hay hookRegistry en ctx.
 */

const ContextCompactor = require('./ContextCompactor');

const COMPACTABLE_TOOLS = new Set([
  'bash', 'read_file', 'grep', 'glob', 'edit_file', 'write_file',
  'webfetch', 'websearch', 'pty_read',
]);

const DEFAULTS = Object.freeze({
  everyTurns: 10,
  keepLastK:  4,
});

class MicroCompactor extends ContextCompactor {
  /**
   * @param {object} [opts]
   * @param {number} [opts.everyTurns=10]
   * @param {number} [opts.keepLastK=4]
   * @param {Set<string>} [opts.compactableTools]
   */
  constructor(opts = {}) {
    super();
    this._everyTurns = Number.isFinite(opts.everyTurns) ? opts.everyTurns : DEFAULTS.everyTurns;
    this._keepLastK  = Number.isFinite(opts.keepLastK)  ? opts.keepLastK  : DEFAULTS.keepLastK;
    this._compactableTools = opts.compactableTools instanceof Set
      ? opts.compactableTools
      : COMPACTABLE_TOOLS;
  }

  shouldCompact(state) {
    if (!state) return false;
    const turnCount = Number.isFinite(state.turnCount) ? state.turnCount : 0;
    const lastMicroAt = Number.isFinite(state.lastMicroAt) ? state.lastMicroAt : 0;
    // Disparar cada N turns.
    if (turnCount - lastMicroAt < this._everyTurns) return false;
    // No tiene sentido si el history es más corto que keepLastK + 1 (system)
    const size = Number.isFinite(state.historySize)
      ? state.historySize
      : (Array.isArray(state.history) ? state.history.length : 0);
    return size > this._keepLastK + 1;
  }

  async compact(history, ctx = {}) {
    if (!Array.isArray(history) || history.length <= this._keepLastK + 1) return history;

    const hookRegistry = ctx && ctx.hookRegistry;
    if (hookRegistry && hookRegistry.enabled) {
      try { await hookRegistry.emit('pre_compact', { kind: 'micro', historySize: history.length }); } catch {}
    }

    const first = history[0];
    const middle = history.slice(1, history.length - this._keepLastK);
    const tail = history.slice(history.length - this._keepLastK);

    const compactedMiddle = middle.map(msg => this._compactMessage(msg));

    const newHistory = [first, ...compactedMiddle, ...tail];

    if (hookRegistry && hookRegistry.enabled) {
      try { await hookRegistry.emit('post_compact', { kind: 'micro', before: history.length, after: newHistory.length }); } catch {}
    }

    return newHistory;
  }

  _compactMessage(msg) {
    if (!msg || typeof msg !== 'object') return msg;
    // Formato 1: msg.role === 'tool' con toolName
    if (msg.role === 'tool' && msg.toolName && this._compactableTools.has(msg.toolName)) {
      return this._placeholder(msg);
    }
    // Formato 2: content array con tool_result blocks (Anthropic-like)
    if (Array.isArray(msg.content)) {
      const hasCompactableToolResult = msg.content.some(block =>
        block && block.type === 'tool_result' && this._shouldCompactByName(block.name || block.tool_name)
      );
      if (hasCompactableToolResult) {
        return {
          ...msg,
          content: msg.content.map(block => {
            if (block && block.type === 'tool_result' && this._shouldCompactByName(block.name || block.tool_name)) {
              return {
                ...block,
                content: '[Old tool result cleared]',
                _meta: {
                  toolName: block.name || block.tool_name || 'unknown',
                  originalSize: typeof block.content === 'string' ? block.content.length : undefined,
                  compactedAt: Date.now(),
                },
              };
            }
            return block;
          }),
        };
      }
    }
    return msg;
  }

  _shouldCompactByName(name) {
    return name && this._compactableTools.has(String(name));
  }

  _placeholder(msg) {
    const originalSize = typeof msg.content === 'string' ? msg.content.length : undefined;
    return {
      ...msg,
      content: '[Old tool result cleared]',
      _meta: {
        toolName: msg.toolName,
        originalSize,
        compactedAt: Date.now(),
      },
    };
  }
}

MicroCompactor.COMPACTABLE_TOOLS = COMPACTABLE_TOOLS;
MicroCompactor.DEFAULTS = DEFAULTS;
module.exports = MicroCompactor;
