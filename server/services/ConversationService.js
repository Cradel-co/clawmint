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

const MAX_HISTORY_MESSAGES = 30;
const MESSAGES_TO_SUMMARIZE = 20;
const SUMMARY_MARKER = '[resumen-conversacion]';

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
    this._rateLimits         = new Map(); // chatId → { count, resetAt }
    // Limpiar rate limits expirados cada 5 minutos
    this._rlCleanup = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this._rateLimits) {
        if (now > v.resetAt) this._rateLimits.delete(k);
      }
    }, 5 * 60 * 1000);
    if (this._rlCleanup.unref) this._rlCleanup.unref();
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
   * Construye system prompt con instrucciones de herramientas para providers API.
   */
  _buildToolSystemPrompt(channel, botKey, chatId, agentKey) {
    const parts = [
      'Sos un asistente útil. Respondé de forma concisa y clara, siempre en español.',
      '',
      'Tenés acceso a herramientas (tools/functions) que podés usar cuando sea necesario.',
      'Usá herramientas proactivamente para ejecutar comandos, leer/escribir archivos, enviar multimedia, y gestionar memoria.',
      '',
      '## Herramientas disponibles',
      '',
      '- **bash**: Ejecutar comandos shell. Usar session_id para aislar conversaciones.',
      '- **git**: Operaciones git seguras. Params: action (status|diff|log|add|commit|push|pull|branch|checkout|stash|blame|show), message?, files?, branch?, ref?, count?.',
      '- **read_file**: Leer archivo (límite 50KB).',
      '- **write_file**: Crear o sobreescribir archivo completo.',
      '- **edit_file**: Editar archivo con buscar/reemplazar (preferir sobre write_file para cambios parciales). Params: path, old_string, new_string, replace_all?.',
      '- **list_dir / search_files**: Navegar filesystem.',
      '- **pty_create**: Crear terminal interactiva persistente. Retorna session_id.',
      '- **pty_exec**: Ejecutar comando en PTY y esperar resultado (como bash pero en sesión persistente). Params: session_id, command, timeout_ms?, stable_ms?.',
      '- **pty_write / pty_read**: Para interacción manual con PTY (ssh, vim). write envía input, read lee output.',
      '- **memory_list / memory_read / memory_write / memory_append / memory_delete**: Memoria persistente del agente.',
    ];

    if (channel === 'telegram' && botKey && chatId) {
      parts.push(
        '',
        '## REGLA DE COMUNICACIÓN',
        '',
        'TODA tu comunicación con el usuario DEBE ser a través de herramientas.',
        'NO devuelvas texto plano como respuesta — el usuario NO lo verá.',
        '',
        `Para responder con texto: usá \`telegram_send_message\` con bot="${botKey}" y chat_id=${chatId}.`,
        'Para enviar imágenes: usá `telegram_send_photo`.',
        'Para enviar archivos: usá `telegram_send_document`.',
        'Para enviar audio: usá `telegram_send_voice`.',
        '',
        'Si tu respuesta es larga, dividila en múltiples llamadas a `telegram_send_message` (un párrafo por mensaje).',
        '',
        '## Telegram',
        `Contexto: bot="${botKey}", chat_id=${chatId}, agent="${agentKey || 'claude'}"`,
        '- **telegram_send_message**: Enviar texto al chat. Params: bot, chat_id, text, parse_mode?, reply_markup?.',
        '  Soporta botones inline: reply_markup=`{"inline_keyboard":[[{"text":"Opción","callback_data":"dato"}]]}`',
        '- **telegram_send_photo / telegram_send_document / telegram_send_voice / telegram_send_video**: Enviar multimedia. Params: bot, chat_id, file_path, caption?.',
        '- **telegram_edit_message / telegram_delete_message**: Editar/borrar mensajes.',
        '',
        'Usá botones proactivamente cuando ofrezcas opciones o alternativas.',
      );
    } else if (channel === 'webchat') {
      parts.push(
        '',
        '## REGLA DE COMUNICACIÓN',
        '',
        'TODA tu comunicación con el usuario DEBE ser a través de herramientas.',
        'NO devuelvas texto plano como respuesta — el usuario NO lo verá.',
        '',
        'Para responder: usá `webchat_send_message`.',
        'Si tu respuesta es larga, dividila en múltiples llamadas (un párrafo por mensaje).',
        '',
        '## WebChat',
        `Contexto: agent="${agentKey || 'claude'}"`,
        '- **webchat_send_message**: Enviar texto al chat. Params: session_id, text, buttons?, callbacks?.',
        '- **webchat_send_photo / webchat_send_document / webchat_send_voice / webchat_send_video**: Enviar multimedia.',
        '- **webchat_edit_message / webchat_delete_message**: Editar/borrar mensajes.',
      );
    }

    parts.push(
      '',
      '## Memoria',
      `Agente actual: "${agentKey || 'claude'}"`,
      'Guardá información importante proactivamente con memory_write (datos personales, preferencias, soluciones técnicas).',
      'Usá nombres descriptivos en español para los archivos (ej: preferencias-usuario.md).',
    );

    return parts.join('\n');
  }

  /**
   * Compacta el historial si excede MAX_HISTORY_MESSAGES.
   * Toma los mensajes más viejos, los resume con el provider, y los reemplaza con un solo mensaje.
   */
  async _compactHistory(history, provider, apiKey, model) {
    if (!history || history.length <= MAX_HISTORY_MESSAGES) return history;

    const provObj = this._providers?.get(provider);
    if (!provObj) return history;

    const toSummarize = history.slice(0, MESSAGES_TO_SUMMARIZE);
    const toKeep = history.slice(MESSAGES_TO_SUMMARIZE);

    try {
      csdbg('compact', `history=${history.length} → resumiendo ${toSummarize.length} mensajes, conservando ${toKeep.length}`);

      const gen = provObj.chat({
        systemPrompt: 'Sos un asistente que resume conversaciones. Generá un resumen conciso en español de la conversación. Incluí:\n- Datos personales mencionados del usuario\n- Decisiones tomadas y acuerdos\n- Contexto técnico relevante\n- Tareas pendientes o temas abiertos\n\nEl resumen debe ser breve (máx 500 palabras) y preservar lo importante.',
        history: [...toSummarize, { role: 'user', content: 'Resumí la conversación anterior en puntos clave.' }],
        apiKey,
        model,
      });

      let summary = '';
      for await (const event of gen) {
        if (event.type === 'text') summary += event.text;
        else if (event.type === 'done') summary = event.fullText || summary;
      }

      if (!summary.trim()) {
        csdbg('compact', 'resumen vacío, retornando history original');
        return history;
      }

      csdbg('compact', `resumen generado: ${summary.length} chars`);
      const summaryMsg = { role: 'user', content: `${SUMMARY_MARKER}\nResumen de conversación anterior:\n${summary}` };
      const ackMsg = { role: 'assistant', content: 'Entendido, tengo el contexto de la conversación anterior.' };
      return [summaryMsg, ackMsg, ...toKeep];
    } catch (err) {
      csdbg('compact', `error al resumir: ${err.message}`);
      return history; // fallback: no romper nada
    }
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
    files         = null,
    history       = [],
    claudeSession = null,
    claudeMode    = 'auto',
    onChunk       = null,
    onStatus      = null,
    onAskPermission = null,
    shellId       = null,
    botKey        = null,
    channel       = null,
  }) {
    // Procesar archivos no-imagen: extraer contenido como texto y adjuntarlo al mensaje
    if (files && files.length > 0) {
      text = await this._processFiles(text, files);
    }

    const resolvedShellId = shellId || String(chatId);
    csdbg('msg', `chatId=${chatId} provider=${provider} agent=${agentKey} model=${model} textLen=${text.length} images=${images?.length || 0} histLen=${history.length} hasSession=${!!claudeSession}`);

    // Rate limiting: 10 mensajes/minuto por chat (solo providers API)
    if (provider !== 'claude-code') {
      const MAX_PER_MIN = 10;
      const now = Date.now();
      const key = `${botKey || 'web'}:${chatId}`;
      let rl = this._rateLimits.get(key);
      if (!rl || now > rl.resetAt) {
        rl = { count: 0, resetAt: now + 60000 };
        this._rateLimits.set(key, rl);
      }
      rl.count++;
      if (rl.count > MAX_PER_MIN) {
        const waitSec = Math.ceil((rl.resetAt - now) / 1000);
        return { text: `⏳ Rate limit: máximo ${MAX_PER_MIN} mensajes por minuto. Esperá ${waitSec}s.`, history };
      }
      this._rateLimits.set(key, rl);
    }

    if (provider !== 'claude-code' && this._providers) {
      csdbg('msg', `→ _processApiProvider mode=${claudeMode}`);
      return this._processApiProvider({
        chatId, agentKey, provider, model, text, images, history, onChunk, onStatus, onAskPermission, claudeMode, shellId: resolvedShellId, botKey, channel,
      });
    }

    csdbg('msg', `→ _processClaudeCode mode=${claudeMode}`);
    return this._processClaudeCode({
      chatId, agentKey, text, images, claudeSession, claudeMode, onChunk, onStatus, botKey, channel,
    });
  }

  // ── Procesamiento de archivos no-imagen ──────────────────────────────────

  async _processFiles(text, files) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const descriptions = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const name = file.name || `archivo_${i + 1}`;
      const mediaType = file.mediaType || 'application/octet-stream';
      const buffer = Buffer.from(file.base64, 'base64');

      // Archivos de texto plano: leer contenido directamente
      const textTypes = ['text/', 'application/json', 'application/xml', 'application/csv'];
      const textExts = ['.txt', '.json', '.xml', '.csv', '.md', '.js', '.ts', '.py', '.html', '.css', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log', '.sh', '.bash', '.env'];
      const ext = path.extname(name).toLowerCase();
      const isText = textTypes.some(t => mediaType.startsWith(t)) || textExts.includes(ext);

      if (isText) {
        const content = buffer.toString('utf-8');
        const truncated = content.length > 50000 ? content.slice(0, 50000) + '\n...[truncado]' : content;
        descriptions.push(`[Archivo "${name}" (${mediaType})]\n\`\`\`\n${truncated}\n\`\`\``);
        csdbg('files', `archivo texto ${name}: ${content.length} chars`);
        continue;
      }

      // PDFs: intentar OCR con kheiron
      if (mediaType === 'application/pdf' || ext === '.pdf') {
        const tmpPath = path.join(os.tmpdir(), `clawmint_file_${Date.now()}_${i}${ext}`);
        try {
          fs.writeFileSync(tmpPath, buffer);
          const { execSync } = require('child_process');
          const raw = execSync(`kheiron ocr-pdf "${tmpPath}" -l spa 2>/dev/null`, { timeout: 60000, encoding: 'utf-8' });
          let pdfText = '';
          const startMark = raw.indexOf('--- Texto extraído ---');
          const endMark = raw.indexOf('--- Fin ---');
          if (startMark !== -1 && endMark !== -1) {
            pdfText = raw.slice(startMark + '--- Texto extraído ---'.length, endMark).trim();
          } else {
            pdfText = raw.replace(/╔[^╝]*╝/gs, '').replace(/[-─✔✖].*(OCR|Idioma|Confianza|Palabras|Líneas|Archivo).*/gi, '').trim();
          }
          if (pdfText && pdfText.length > 10) {
            descriptions.push(`[PDF "${name}" — texto extraído:]\n${pdfText}`);
            csdbg('files', `PDF OCR ${name}: ${pdfText.length} chars`);
          } else {
            descriptions.push(`[PDF "${name}": no se pudo extraer texto]`);
          }
        } catch (err) {
          csdbg('files', `PDF OCR falló para ${name}: ${err.message}`);
          descriptions.push(`[PDF "${name}": error extrayendo texto — ${err.message}]`);
        } finally {
          try { fs.unlinkSync(tmpPath); } catch {}
        }
        continue;
      }

      // Otros archivos: informar tipo y tamaño
      descriptions.push(`[Archivo "${name}" (${mediaType}, ${buffer.length} bytes): tipo no soportado para extracción de contenido]`);
    }

    if (descriptions.length > 0) {
      const fileContext = descriptions.join('\n\n');
      return `[El usuario adjuntó ${files.length} archivo(s):]\n\n${fileContext}\n\n[Mensaje del usuario: "${text}"]`;
    }
    return text;
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
    const isWebChannel = channel === 'web' || botKey === 'web';
    const mcpPrompt = isWebChannel ? null : getMcpSystemPrompt();
    const channelCtx = (botKey && chatId)
      ? `\n\n## Contexto del canal\n- Canal: ${channel || 'telegram'}\n- Bot key: ${botKey}\n- ${isWebChannel ? 'Session ID' : 'Chat ID'}: ${chatId}\n- Agente activo: ${agentKey || 'default'}\nUsa estos valores cuando necesites enviar fotos, documentos o mensajes al usuario.${isWebChannel ? `\nPara herramientas webchat_*, usa session_id="${chatId}".` : ''}\nPara herramientas de memoria (memory_list, memory_read, memory_write, etc.), usa agent="${agentKey || 'default'}".`
      : '';
    const webChannelPrompt = isWebChannel
      ? 'Estás respondiendo a un usuario a través del WebChat de Clawmint.\n' +
        'Responde siempre en texto plano (se renderiza como Markdown en el cliente).\n' +
        'NO uses herramientas de Telegram (telegram_send_message, telegram_send_photo, etc.) — usa las equivalentes de WebChat.\n' +
        'Responde siempre en español. Sé conciso y directo.\n' +
        'Tienes acceso a herramientas MCP de memoria (memory_list, memory_read, memory_write, memory_append, memory_delete), bash, read_file, write_file, y kheiron-tools.\n' +
        '\n' +
        '## Herramientas WebChat\n' +
        'Para enviar contenido multimedia o mensajes adicionales al usuario, usa estas herramientas:\n' +
        '- webchat_send_message(session_id, text, buttons?, callbacks?) — enviar texto adicional con botones opcionales\n' +
        '- webchat_send_photo(session_id, file_path, caption?) — enviar una imagen al chat (OBLIGATORIO cuando generes imágenes/screenshots)\n' +
        '- webchat_send_document(session_id, file_path, caption?) — enviar un archivo al chat\n' +
        '- webchat_send_voice(session_id, file_path, caption?) — enviar audio al chat\n' +
        '- webchat_send_video(session_id, file_path, caption?) — enviar video al chat\n' +
        '- webchat_edit_message(session_id, msg_id, text) — editar un mensaje enviado\n' +
        '- webchat_delete_message(session_id, msg_id) — borrar un mensaje\n' +
        '- webchat_list_sessions() — listar sesiones activas (para descubrir session_id)\n' +
        '\n' +
        'IMPORTANTE: Cuando generes archivos (screenshots, imágenes, PDFs, audio, video, etc.), SIEMPRE usa la herramienta webchat_send_* correspondiente para enviarlos al chat. NO te limites a guardarlos en disco — el usuario necesita verlos en el chat.\n' +
        'Para obtener el session_id, usa webchat_list_sessions o el valor del contexto del canal.\n' +
        '\n' +
        '## Botones Inline\n' +
        'Podés enviar botones inline en tus respuestas usando este formato al final del mensaje:\n' +
        '<!-- buttons: [{"text":"📋 Opción 1","callback_data":"opcion1"},{"text":"❓ Opción 2","callback_data":"opcion2"}] -->\n' +
        'Los botones se muestran debajo de tu mensaje.\n' +
        'callback_data es lo que se envía como mensaje cuando el usuario hace click.\n\n' +
        'IMPORTANTE: Usá botones proactivamente en estos casos:\n' +
        '- Cuando ofrezcas opciones o alternativas al usuario\n' +
        '- Cuando preguntes algo con respuestas predefinidas (sí/no, elegir entre opciones)\n' +
        '- Al finalizar una tarea, para ofrecer acciones de seguimiento\n' +
        '- Cuando el usuario pueda necesitar ejecutar comandos comunes\n' +
        'No abuses: no en cada mensaje, solo cuando las opciones sean claras y útiles.'
      : '';
    const fullSystemPrompt = isWebChannel
      ? (webChannelPrompt + channelCtx)
      : (mcpPrompt ? (mcpPrompt + channelCtx) : '');

    // Auto-reset: si la sesión tiene demasiados mensajes, crear una nueva
    // Antes de resetear, guardar resumen en memoria para continuidad
    if (session && session.messageCount >= MAX_SESSION_MESSAGES) {
      csdbg('claude', `auto-reset: session tiene ${session.messageCount} msgs (max ${MAX_SESSION_MESSAGES}), creando nueva`);
      console.log(`[ConvSvc] Auto-reset de sesión (${session.messageCount} mensajes)`);

      // Guardar resumen de sesión en memoria para continuidad
      if (agentKey && this._memory) {
        try {
          const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
          const summaryFile = 'last-session-summary.md';
          const existing = this._memory.read(agentKey, summaryFile);
          const summary = `---\nSesión anterior (${ts}, ${session.messageCount} mensajes, chatId: ${chatId})\n---\n` +
            `Último mensaje del usuario: ${text.slice(0, 500)}${text.length > 500 ? '...' : ''}\n` +
            (existing ? `\nContexto previo:\n${existing.slice(0, 1000)}` : '');
          this._memory.write(agentKey, summaryFile, summary);
          csdbg('claude', `saved session summary to ${summaryFile}`);
        } catch (err) {
          csdbg('claude', `error saving session summary: ${err.message}`);
        }
      }

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
        // Inyectar resumen de sesión anterior si existe (continuidad post-reset)
        let sessionSummary = '';
        try {
          const summary = this._memory.read(agentKey, 'last-session-summary.md');
          if (summary) sessionSummary = `## Resumen de sesión anterior\n${summary}`;
        } catch {}
        const parts = [sessionSummary, memCtx, toolInstr].filter(Boolean);
        if (parts.length > 0) messageText = `${parts.join('\n\n')}\n\n---\n\n${text}`;
        csdbg('claude', `memCtx injected: ${memCtx?.length || 0} chars, toolInstr: ${toolInstr?.length || 0} chars, sessionSummary: ${sessionSummary?.length || 0} chars`);
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

  async _processApiProvider({ chatId, agentKey, provider, model, text, images, history, onChunk, onStatus, onAskPermission, claudeMode, shellId, botKey, channel }) {
    const provObj   = this._providers.get(provider);
    const apiKey    = this._providerConfig ? this._providerConfig.getApiKey(provider) : '';
    const cfg       = this._providerConfig ? this._providerConfig.getConfig() : {};
    const useModel  = model || cfg.providers?.[provider]?.model || provObj.defaultModel;

    // Inyectar executor con contexto de shell para persistencia de cwd/env
    const mcpExec  = this._getExecuteTool();
    const rawExecFn = mcpExec
      ? (name, args) => mcpExec(name, args, { shellId, sessionManager: this._sessionManager })
      : undefined;

    // Wrappear execToolFn según modo
    const mode = claudeMode || 'auto';
    let execToolFn = rawExecFn;
    if (mode === 'plan' && rawExecFn) {
      execToolFn = async (name, args) =>
        `[Modo Plan] Se ejecutaría ${name}(${JSON.stringify(args)}). No ejecutado — describí qué harías.`;
    } else if (mode === 'ask' && rawExecFn && onAskPermission) {
      execToolFn = async (name, args) => {
        const approved = await onAskPermission(name, args);
        if (!approved) return 'Herramienta rechazada por el usuario.';
        return rawExecFn(name, args);
      };
    }

    // System prompt con instrucciones de herramientas según canal
    const toolPrompt = this._buildToolSystemPrompt(channel, botKey, chatId, agentKey);
    let basePrompt = toolPrompt || 'Sos un asistente útil. Respondé de forma concisa y clara.';
    if (mode === 'plan') {
      basePrompt += '\n\n## MODO PLAN\nEstás en modo planificación. Las herramientas NO se ejecutan realmente — retornan descripciones simuladas. Describí paso a paso qué harías para resolver el pedido del usuario, qué herramientas usarías y con qué argumentos. No ejecutes, solo planificá.';
    }
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

    // Compactar historial si excede el límite
    const compactedHistory = await this._compactHistory(history, provider, apiKey, useModel);
    const updatedHistory = [...compactedHistory, { role: 'user', content: userContent }];

    // Para Gemini y Ollama: adjuntar imágenes raw para conversión en el provider
    const extraOpts = {};
    if (images && images.length > 0 && (provider === 'gemini' || provider === 'ollama')) {
      extraOpts.images = images;
    }

    // Detectar channel para filtrar critter tools (p2p desde shellId, o el channel del caller)
    const toolChannel = shellId?.startsWith('p2p-') ? 'p2p' : channel || undefined;

    const MAX_RETRIES = 3;
    const GLOBAL_TIMEOUT_MS = 120000;
    let accumulated = '';
    let usedTools = false;
    let usedToolsEver = false;
    let usage = null;

    if (onStatus) onStatus('thinking');

    const chatArgs = { systemPrompt, history: updatedHistory, apiKey, model: useModel, executeTool: execToolFn, channel: toolChannel, ...extraOpts };

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // No reintentar si ya se ejecutaron tools (side effects no son idempotentes)
      if (attempt > 0 && usedToolsEver) break;

      accumulated = '';
      usedTools = false;
      usage = null;
      let timedOut = false;

      const gen = provObj.chat(chatArgs);
      const timeoutId = setTimeout(() => { timedOut = true; }, GLOBAL_TIMEOUT_MS);

      try {
        for await (const event of gen) {
          if (timedOut) {
            accumulated = 'Error: timeout — el provider no respondió en 120s.';
            break;
          }
          if (event.type === 'text') {
            accumulated += event.text;
            if (onChunk) onChunk(accumulated);
          } else if (event.type === 'tool_call') {
            usedTools = true;
            usedToolsEver = true;
            if (onStatus) onStatus('tool_use', event.name);
          } else if (event.type === 'usage') {
            usage = { promptTokens: event.promptTokens, completionTokens: event.completionTokens };
          } else if (event.type === 'done') {
            accumulated = event.fullText || accumulated;
          }
        }
      } catch (err) {
        accumulated = `Error ${provider}: ${err.message}`;
      } finally {
        clearTimeout(timeoutId);
      }

      // Verificar si es error transitorios que amerita retry
      const isError = accumulated.startsWith('Error');
      const isTransient = isError && /timeout|429|500|502|503|ECONNRESET|ETIMEDOUT|rate.limit/i.test(accumulated);

      if (!isError || !isTransient || attempt === MAX_RETRIES - 1) break;

      // Backoff exponencial con jitter
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      csdbg('retry', `attempt ${attempt + 1}/${MAX_RETRIES}, waiting ${Math.round(delay)}ms — ${accumulated.slice(0, 100)}`);
      if (onStatus) onStatus('thinking', `reintento ${attempt + 2}/${MAX_RETRIES}`);
      await new Promise(r => setTimeout(r, delay));
    }

    if (onStatus && usedTools) onStatus('done');

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
      usedMcpTools: usedToolsEver,
      usage,
    };
  }
}

module.exports = ConversationService;
