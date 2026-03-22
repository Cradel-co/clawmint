'use strict';

const path = require('path');
const fs = require('fs');

const MCP_SYSTEM_PROMPT_PATH = path.join(__dirname, '..', 'mcp-system-prompt.txt');
let _mcpSystemPrompt = null;
function getMcpSystemPrompt() {
  if (_mcpSystemPrompt === null) {
    try { _mcpSystemPrompt = fs.readFileSync(MCP_SYSTEM_PROMPT_PATH, 'utf-8'); } catch { _mcpSystemPrompt = ''; }
  }
  return _mcpSystemPrompt;
}

function _csDbg() { return process.env.DEBUG_TELEGRAM === '1'; }
function csdbg(scope, ...args) { if (_csDbg()) console.log(`[ConvSvc:DBG:${scope}]`, ...args); }

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
    images        = null,
    history       = [],
    claudeSession = null,
    claudeMode    = 'auto',
    onChunk       = null,
    onStatus      = null,
    shellId       = null,
    botKey        = null,
    channel       = null,
  }) {
    const resolvedShellId = shellId || String(chatId);
    csdbg('msg', `chatId=${chatId} provider=${provider} agent=${agentKey} model=${model} textLen=${text.length} images=${images?.length || 0} histLen=${history.length} hasSession=${!!claudeSession}`);

    if (provider !== 'claude-code' && this._providers) {
      csdbg('msg', `→ _processApiProvider`);
      return this._processApiProvider({
        chatId, agentKey, provider, model, text, images, history, onChunk, shellId: resolvedShellId,
      });
    }

    csdbg('msg', `→ _processClaudeCode mode=${claudeMode}`);
    return this._processClaudeCode({
      chatId, agentKey, text, images, claudeSession, claudeMode, onChunk, onStatus, botKey, channel,
    });
  }

  // ── Proveedor claude-code (ClaudePrintSession) ────────────────────────────

  async _processClaudeCode({ chatId, agentKey, text, images, claudeSession, claudeMode, onChunk, onStatus, botKey, channel }) {
    // Claude Code CLI no soporta imágenes — extraer texto con OCR (kheiron) + fallback Ollama visión
    if (images && images.length > 0) {
      const { execSync } = require('child_process');
      const fs = require('fs');
      const path = require('path');
      const descriptions = [];

      for (let i = 0; i < images.length; i++) {
        const tmpPath = path.join(require('os').tmpdir(), `clawmint_img_${Date.now()}_${i}.jpg`);
        try {
          // Guardar imagen en disco
          fs.writeFileSync(tmpPath, Buffer.from(images[i].base64, 'base64'));

          // 1. Intentar OCR con kheiron
          try {
            const rawOcr = execSync(`kheiron ocr "${tmpPath}" -l spa 2>/dev/null`, { timeout: 30000, encoding: 'utf-8' });
            // Extraer texto entre marcadores, o tomar las últimas líneas limpias
            let ocrText = '';
            const startMark = rawOcr.indexOf('--- Texto extraído ---');
            const endMark = rawOcr.indexOf('--- Fin ---');
            if (startMark !== -1 && endMark !== -1) {
              ocrText = rawOcr.slice(startMark + '--- Texto extraído ---'.length, endMark).trim();
            } else {
              // Fallback: limpiar banner y metadata
              ocrText = rawOcr.replace(/╔[^╝]*╝/gs, '').replace(/[-─✔✖].*(OCR|Idioma|Confianza|Palabras|Líneas|Archivo).*/gi, '').trim();
            }
            if (ocrText && ocrText.length > 10) {
              descriptions.push(`[OCR imagen ${i + 1}:]\n${ocrText}`);
              csdbg('claude', `images: OCR exitoso para imagen ${i + 1} (${ocrText.length} chars)`);
              continue;
            }
          } catch (ocrErr) {
            console.log(`[ConvSvc] OCR falló para imagen ${i + 1}: ${ocrErr.message || ocrErr.stderr || ocrErr}`);
          }

          // 2. Fallback: Ollama minicpm-v
          try {
            const ollama = require('../providers/ollama');
            console.log(`[ConvSvc] Imagen ${i + 1}: OCR sin texto, intentando minicpm-v...`);
            const desc = await ollama.describeImage([images[i]], text);
            descriptions.push(`[Descripción IA imagen ${i + 1}:]\n${desc}`);
            console.log(`[ConvSvc] minicpm-v OK para imagen ${i + 1} (${desc.length} chars)`);
          } catch (ollamaErr) {
            console.error(`[ConvSvc] minicpm-v falló para imagen ${i + 1}: ${ollamaErr.message || ollamaErr}`);
            descriptions.push(`[Imagen ${i + 1}: no se pudo analizar (OCR y visión fallaron)]`);
          }
        } finally {
          try { fs.unlinkSync(tmpPath); } catch {}
        }
      }

      const imgContext = descriptions.join('\n\n');
      text = `[El usuario envió ${images.length} imagen(es). Análisis:]\n\n${imgContext}\n\n[Mensaje original del usuario: "${text}"]`;
    }
    const MAX_SESSION_MESSAGES = 10;
    let session = claudeSession;
    let isNewSession = false;
    const mcpPrompt = getMcpSystemPrompt();
    const channelCtx = (botKey && chatId)
      ? `\n\n## Contexto del canal\n- Canal: ${channel || 'telegram'}\n- Bot key: ${botKey}\n- Chat ID: ${chatId}\nUsa estos valores cuando necesites enviar fotos, documentos o mensajes al usuario.`
      : '';
    const fullSystemPrompt = mcpPrompt ? (mcpPrompt + channelCtx) : '';

    // Auto-reset: si la sesión tiene demasiados mensajes, crear una nueva
    if (session && session.messageCount >= MAX_SESSION_MESSAGES) {
      csdbg('claude', `auto-reset: session tiene ${session.messageCount} msgs (max ${MAX_SESSION_MESSAGES}), creando nueva`);
      console.log(`[ConvSvc] Auto-reset de sesión (${session.messageCount} mensajes)`);
      session = null;
    }

    if (!session) {
      session = new this._ClaudePrintSession({
        permissionMode: claudeMode || 'auto',
        appendSystemPrompt: fullSystemPrompt || undefined,
      });
      isNewSession = true;
      csdbg('claude', `nueva ClaudePrintSession mode=${claudeMode} mcpPrompt=${!!mcpPrompt} botKey=${botKey}`);
    } else {
      if (fullSystemPrompt && !session.appendSystemPrompt) {
        session.appendSystemPrompt = fullSystemPrompt;
      }
      csdbg('claude', `reutilizando session msgCount=${session.messageCount}`);
    }

    // Detección de señales de memoria
    const { shouldNudge, signals } = (agentKey && this._memory)
      ? this._memory.detectSignals(agentKey, text)
      : { shouldNudge: false, signals: [] };
    csdbg('claude', `signals=${signals.length} shouldNudge=${shouldNudge}`);

    // Construir mensaje con contexto de memoria inyectado
    let messageText = text;
    if (agentKey && this._memory) {
      if (session.messageCount === 0) {
        const memCtx    = this._memory.buildMemoryContext(agentKey, text);
        const toolInstr = shouldNudge ? this._memory.TOOL_INSTRUCTIONS : '';
        const parts     = [memCtx, toolInstr].filter(Boolean);
        if (parts.length > 0) messageText = `${parts.join('\n\n')}\n\n---\n\n${text}`;
        csdbg('claude', `memCtx injected: ${memCtx?.length || 0} chars, toolInstr: ${toolInstr?.length || 0} chars`);
      }
    }
    if (shouldNudge && this._memory) messageText += this._memory.buildNudge(signals);

    csdbg('claude', `→ session.sendMessage() textLen=${messageText.length}`);
    const t0 = Date.now();
    let result;
    try {
      result = await session.sendMessage(messageText, onChunk, onStatus);
    } catch (err) {
      // Si falló con --resume (session_id viejo/inválido), reintentar como nueva sesión
      if (session.claudeSessionId && session.messageCount > 0) {
        csdbg('claude', `--resume falló (${err.message}), reintentando como nueva sesión`);
        console.log(`[ConvSvc] --resume falló (${err.message}), reintentando sin resume`);
        session.claudeSessionId = null;
        session.messageCount = 0;
        isNewSession = true;
        result = await session.sendMessage(messageText, onChunk, onStatus);
      } else {
        throw err;
      }
    }

    // sendMessage ahora devuelve { text, usedMcpTools } o string (backward compat)
    const rawResponse = typeof result === 'string' ? result : (result?.text || '');
    const usedMcpTools = typeof result === 'object' ? result.usedMcpTools : false;
    csdbg('claude', `← session.sendMessage() ${Date.now() - t0}ms responseLen=${rawResponse.length} usedMcpTools=${usedMcpTools}`);

    // Extraer y aplicar operaciones de memoria
    let response = rawResponse;
    const savedMemoryFiles = [];
    if (agentKey && rawResponse && this._memory) {
      const { clean, ops } = this._memory.extractMemoryOps(rawResponse);
      csdbg('claude', `memOps=${ops.length} cleanLen=${clean?.length || 0}`);
      if (ops.length > 0) {
        const saved = this._memory.applyOps(agentKey, ops);
        response = clean || rawResponse;
        savedMemoryFiles.push(...saved);
        csdbg('claude', `saved files: [${saved.join(', ')}]`);
      } else if (shouldNudge && this._consolidator) {
        csdbg('claude', `enqueuing to consolidator`);
        this._consolidator.enqueue(
          agentKey, chatId,
          [{ text, types: signals.map(s => s.type), ts: Date.now() }],
          'signal'
        );
      }
    }

    csdbg('claude', `DONE responseLen=${(response || '').length} savedFiles=${savedMemoryFiles.length} isNew=${isNewSession} usedMcpTools=${usedMcpTools}`);
    return {
      text: response || '',
      usedMcpTools,
      savedMemoryFiles,
      ...(isNewSession ? { newSession: session } : {}),
    };
  }

  // ── Proveedores API (Anthropic, Gemini, OpenAI, …) ───────────────────────

  async _processApiProvider({ chatId, agentKey, provider, model, text, images, history, onChunk, shellId }) {
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
    const userText = (shouldNudge && this._memory) ? text + this._memory.buildNudge(signals) : text;

    // Construir content con imágenes según el provider
    let userContent;
    if (images && images.length > 0) {
      if (provider === 'anthropic') {
        // Anthropic: { type: 'image', source: { type: 'base64', media_type, data } }
        userContent = images.map(img => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
        }));
        userContent.push({ type: 'text', text: userText });
      } else if (provider === 'gemini') {
        // Gemini: se pasa como _images en el último mensaje, se convierte en el provider
        userContent = userText;
      } else {
        // OpenAI / Grok: { type: 'image_url', image_url: { url: 'data:...' } }
        userContent = images.map(img => ({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
        }));
        userContent.push({ type: 'text', text: userText });
      }
    } else {
      userContent = userText;
    }

    const updatedHistory = [...history, { role: 'user', content: userContent }];

    // Para Gemini y Ollama: adjuntar imágenes raw para conversión en el provider
    const extraOpts = {};
    if (images && images.length > 0 && (provider === 'gemini' || provider === 'ollama')) {
      extraOpts.images = images;
    }

    const gen = provObj.chat({ systemPrompt, history: updatedHistory, apiKey, model: useModel, executeTool: execToolFn, ...extraOpts });
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
