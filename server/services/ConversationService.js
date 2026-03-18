'use strict';

/**
 * ConversationService — orquesta el envío de un mensaje al agente correcto.
 *
 * Extrae la lógica central de _sendToSession() y _sendToApiProvider()
 * de TelegramBot, desacoplándola del canal de transporte.
 *
 * El callback `onChunk` recibe texto parcial para animaciones
 * progresivas (específicas de cada canal; este servicio no sabe de
 * mensajes editables ni de la API de Telegram).
 *
 * Fase 3: creado como servicio inyectable.
 * La integración completa con TelegramChannel queda para una iteración futura.
 */
class ConversationService {
  constructor({
    sessionManager,
    providers      = null,
    providerConfig = null,
    memory         = null,
    agents         = null,
    skills         = null,
    ClaudePrintSession,
    consolidator   = null,
    logger         = console,
  }) {
    this._sessionManager     = sessionManager;
    this._providers          = providers;
    this._providerConfig     = providerConfig;
    this._memory             = memory;
    this._agents             = agents;
    this._skills             = skills;
    this._ClaudePrintSession = ClaudePrintSession;
    this._consolidator       = consolidator;
    this._logger             = logger;

    // Lazy-load para evitar dependencias circulares
    this._mcpExecuteTool = null;
  }

  _getExecuteTool() {
    if (!this._mcpExecuteTool) {
      try { this._mcpExecuteTool = require('../mcp').executeTool; } catch {}
    }
    return this._mcpExecuteTool;
  }

  /**
   * Procesa un mensaje del usuario y devuelve la respuesta del agente.
   *
   * @param {object}   opts
   * @param {number}   opts.chatId
   * @param {string}   opts.agentKey       - clave del agente activo
   * @param {string}   opts.provider       - 'claude-code' | 'anthropic' | 'gemini' | ...
   * @param {string}   [opts.model]        - modelo explícito (null = default del provider)
   * @param {string}   opts.text           - mensaje del usuario
   * @param {object[]} [opts.history]      - historial de conversación (providers API)
   * @param {object}   [opts.claudeSession] - instancia de ClaudePrintSession activa
   * @param {string}   [opts.claudeMode]   - 'auto' | 'ask' | 'plan'
   * @param {function} [opts.onChunk]      - callback(partialText) para streaming
   *
   * @returns {Promise<{
   *   text: string,
   *   history?: object[],
   *   savedMemoryFiles?: string[],
   *   newSession?: object
   * }>}
   */
  async processMessage({
    chatId,
    agentKey,
    provider      = 'claude-code',
    model         = null,
    text,
    history       = [],
    claudeSession = null,
    claudeMode    = 'ask',
    onChunk       = null,
    shellId       = null,
  }) {
    const resolvedShellId = shellId || String(chatId);

    if (provider !== 'claude-code' && this._providers) {
      return this._processApiProvider({
        chatId, agentKey, provider, model, text, history, onChunk, shellId: resolvedShellId,
      });
    }

    return this._processClaudeCode({
      chatId, agentKey, text, claudeSession, claudeMode, onChunk,
    });
  }

  // ── Proveedor claude-code (ClaudePrintSession) ────────────────────────────

  async _processClaudeCode({ chatId, agentKey, text, claudeSession, claudeMode, onChunk }) {
    let session = claudeSession;
    let isNewSession = false;
    if (!session) {
      session = new this._ClaudePrintSession({ permissionMode: claudeMode || 'ask' });
      isNewSession = true;
    }

    // Detección de señales de memoria
    const { shouldNudge, signals } = (agentKey && this._memory)
      ? this._memory.detectSignals(agentKey, text)
      : { shouldNudge: false, signals: [] };

    // Construir mensaje con contexto de memoria inyectado
    let messageText = text;
    if (agentKey && this._memory) {
      if (session.messageCount === 0) {
        const memCtx    = this._memory.buildMemoryContext(agentKey, text);
        const toolInstr = shouldNudge ? this._memory.TOOL_INSTRUCTIONS : '';
        const parts     = [memCtx, toolInstr].filter(Boolean);
        if (parts.length > 0) messageText = `${parts.join('\n\n')}\n\n---\n\n${text}`;
      }
    }
    if (shouldNudge && this._memory) messageText += this._memory.buildNudge(signals);

    const rawResponse = await session.sendMessage(messageText, onChunk);

    // Extraer y aplicar operaciones de memoria
    let response = rawResponse;
    const savedMemoryFiles = [];
    if (agentKey && rawResponse && this._memory) {
      const { clean, ops } = this._memory.extractMemoryOps(rawResponse);
      if (ops.length > 0) {
        const saved = this._memory.applyOps(agentKey, ops);
        response = clean || rawResponse;
        savedMemoryFiles.push(...saved);
      } else if (shouldNudge && this._consolidator) {
        this._consolidator.enqueue(
          agentKey, chatId,
          [{ text, types: signals.map(s => s.type), ts: Date.now() }],
          'signal'
        );
      }
    }

    return {
      text: response || '',
      savedMemoryFiles,
      ...(isNewSession ? { newSession: session } : {}),
    };
  }

  // ── Proveedores API (Anthropic, Gemini, OpenAI, …) ───────────────────────

  async _processApiProvider({ chatId, agentKey, provider, model, text, history, onChunk, shellId }) {
    const provObj   = this._providers.get(provider);
    const apiKey    = this._providerConfig ? this._providerConfig.getApiKey(provider) : '';
    const cfg       = this._providerConfig ? this._providerConfig.getConfig() : {};
    const useModel  = model || cfg.providers?.[provider]?.model || provObj.defaultModel;

    // Inyectar executor con contexto de shell para persistencia de cwd/env
    const mcpExec  = this._getExecuteTool();
    const execToolFn = mcpExec
      ? (name, args) => mcpExec(name, args, { shellId, sessionManager: this._sessionManager })
      : undefined;

    const basePrompt = 'Sos un asistente útil. Respondé de forma concisa y clara.';
    const memCtxRaw  = (agentKey && this._memory)
      ? this._memory.buildMemoryContext(agentKey, text, { provider, apiKey })
      : '';
    const memoryCtx  = (memCtxRaw && typeof memCtxRaw.then === 'function')
      ? await memCtxRaw.catch(() => '')
      : (memCtxRaw || '');

    const { shouldNudge, signals } = (agentKey && this._memory)
      ? this._memory.detectSignals(agentKey, text)
      : { shouldNudge: false, signals: [] };

    const toolInstr    = (agentKey && shouldNudge && this._memory) ? this._memory.TOOL_INSTRUCTIONS : '';
    const systemPrompt = [basePrompt, memoryCtx, toolInstr].filter(Boolean).join('\n\n');
    const userContent  = (shouldNudge && this._memory) ? text + this._memory.buildNudge(signals) : text;

    const updatedHistory = [...history, { role: 'user', content: userContent }];

    const gen = provObj.chat({ systemPrompt, history: updatedHistory, apiKey, model: useModel, executeTool: execToolFn });
    let accumulated = '';

    for await (const event of gen) {
      if (event.type === 'text') {
        accumulated += event.text;
        if (onChunk) onChunk(accumulated);
      } else if (event.type === 'done') {
        accumulated = event.fullText || accumulated;
      }
    }

    // Extraer y aplicar operaciones de memoria
    let finalText = accumulated;
    const savedMemoryFiles = [];
    if (agentKey && finalText && this._memory) {
      const { clean, ops } = this._memory.extractMemoryOps(finalText);
      if (ops.length > 0) {
        const saved = this._memory.applyOps(agentKey, ops);
        finalText = clean || finalText;
        savedMemoryFiles.push(...saved);
      } else if (shouldNudge && this._consolidator) {
        this._consolidator.enqueue(
          agentKey, chatId,
          [{ text, types: signals.map(s => s.type), ts: Date.now() }],
          'signal'
        );
      }
    }

    updatedHistory.push({ role: 'assistant', content: finalText });

    return {
      text:    finalText || '',
      history: updatedHistory,
      savedMemoryFiles,
    };
  }
}

module.exports = ConversationService;
