'use strict';

const path = require('path');
const fs = require('fs');
const { CONFIG_FILES } = require('../paths');

// mcp-system-prompt.txt es asset bundleado con el código (read-only).
// mcp-config.json es user-data (se regenera runtime, va a CONFIG_DIR).
const MCP_SYSTEM_PROMPT_PATH = path.join(__dirname, '..', 'mcp-system-prompt.txt');
const MCP_CONFIG_PATH = CONFIG_FILES.mcpConfig;
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
    GeminiCliSession = null,
    consolidator   = null,
    limitsRepo     = null,
    tasksRepo      = null,
    permissionService = null,
    hookRegistry   = null,
    compactorPipeline = null,
    toolCatalog    = null,
    typedMemoryService = null,
    planModeService = null,
    jobQuotaService = null,
    mcpAuthService  = null,
    lspServerManager = null,
    resumableSessionsRepo = null,
    workspaceRegistry = null,
    loopRunner     = null,
    eventBus       = null,
    locationService = null,
    userPreferencesRepo = null,
    reminders      = null,
    householdRepo  = null,
    instructionsLoader = null,
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
    this._limitsRepo         = limitsRepo;
    this._tasksRepo          = tasksRepo;
    this._permissionService  = permissionService;
    this._hookRegistry       = hookRegistry;
    this._compactorPipeline  = compactorPipeline;
    this._toolCatalog        = toolCatalog;
    this._typedMemoryService = typedMemoryService;
    this._planModeService    = planModeService;
    this._jobQuotaService    = jobQuotaService;
    this._mcpAuthService     = mcpAuthService;
    this._lspServerManager   = lspServerManager;
    this._resumableSessionsRepo = resumableSessionsRepo;
    this._workspaceRegistry  = workspaceRegistry;
    this._eventBus           = eventBus;
    this._locationService    = locationService;
    this._userPreferencesRepo = userPreferencesRepo;
    this._reminders          = reminders;
    this._householdRepo      = householdRepo;
    this._instructionsLoader = instructionsLoader;
    // LoopRunner opcional: si no se inyecta, fallback a path legacy
    this._loopRunner         = loopRunner;
    this._useLoopRunner      = loopRunner && process.env.USE_LOOP_RUNNER !== 'false';
    this._ClaudePrintSession = ClaudePrintSession;
    this._GeminiCliSession   = GeminiCliSession || (() => {
      try { return require('../core/GeminiCliSession'); } catch { return null; }
    })();
    this._consolidator       = consolidator;
    this._logger             = logger;

    // Lazy-load para evitar dependencias circulares
    this._mcpExecuteTool = null;

    // Inyectados vía setter (evita dependencias circulares)
    this._scheduler  = null;
    this._usersRepo  = null;
  }

  /** Inyecta scheduler y usersRepo para que las MCP tools los reciban en ctx */
  setSchedulerDeps({ scheduler, usersRepo }) {
    this._scheduler = scheduler;
    this._usersRepo = usersRepo;
  }

  /** Inyecta orchestrator para orquestación multi-agente */
  setOrchestrator(orchestrator) {
    this._orchestrator = orchestrator;
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
      '',
      '## Acciones Programadas',
      '- **schedule_action**: Programar acción futura. Tipos: "notification" (texto directo) o "ai_task" (despierta al agente para ejecutar tarea compleja).',
      '  Triggers: "once" (fecha/hora o delay "30m","2h") o "cron" ("0 8 * * *" = todos los días a las 8).',
      '  Destinos: "self" (al usuario), "users" (lista de IDs), "whitelist", "all".',
      '- **list_scheduled**: Ver acciones programadas.',
      '- **cancel_scheduled**: Cancelar por ID.',
      '- **update_scheduled**: Modificar acción existente.',
      '',
      'Usá schedule_action proactivamente cuando el usuario mencione fechas, horas, recordatorios o tareas recurrentes.',
      '',
      '## Usuarios',
      '- **user_list**: Lista usuarios registrados con sus canales (Telegram, WebChat, P2P).',
      '- **user_info**: Info detallada de un usuario por ID o nombre.',
      '- **user_link**: Vincular identidad de otro canal a un usuario.',
      '',
      'Usá user_list cuando necesites saber a quién enviar mensajes o programar acciones para otros usuarios.',
      '',
      '## Agenda de Contactos',
      '- **contact_add**: Agregar contacto (nombre, teléfono, email, notas, telegram_id para vincular).',
      '- **contact_list**: Listar contactos (filtro: favorites).',
      '- **contact_info**: Detalle por ID o nombre.',
      '- **contact_update**: Modificar datos.',
      '- **contact_delete**: Eliminar contacto.',
      '- **contact_link**: Vincular contacto con usuario del sistema (por telegram_id, user_id o nombre).',
      '',
      'Usá contact_add proactivamente cuando el usuario mencione personas, teléfonos o emails.',
      'Los contactos favoritos pueden ser destino de acciones programadas (target_type="favorites").',
    );

    // Sección de orquestación (solo para coordinadores)
    const agentDef = agentKey && this._agents ? this._agents.get(agentKey) : null;
    if (agentDef?.role === 'coordinator') {
      parts.push(
        '',
        '## Orquestación Multi-Agente',
        'Sos un agente coordinador. Podés delegar tareas a otros agentes especializados.',
        '- **delegate_task**: Delegar tarea a otro agente. Esperá el resultado. Máx 5 delegaciones.',
        '- **ask_agent**: Pregunta rápida a otro agente.',
        '- **list_agents**: Ver agentes disponibles.',
        '',
        'Usá list_agents primero para saber quién puede ayudar. Delegá subtareas específicas y sintetizá los resultados.',
      );
    }

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
    geminiSession = null,
    claudeMode    = 'auto',
    onChunk       = null,
    onStatus      = null,
    onAskPermission = null,
    shellId       = null,
    botKey        = null,
    channel       = null,
    userId        = null,
    // Delegación (Fase 5): cuando este mensaje viene de AgentOrchestrator
    _isDelegated     = false,
    _delegationDepth = 0,
    _subagentConfig  = null,
    _parentPrefix    = null,   // Fase 7.5.7 — system prompt del coordinador para cache share
    _workspace       = null,   // Fase 8.4 — handle del workspace acquired por el orchestrator
  } = {}) {
    // Bloquear delegaciones que exceden la profundidad permitida. Tope = 3 (MAX_DELEGATION_DEPTH)
    if (_isDelegated && _delegationDepth > 3) {
      return { text: `Error: profundidad de delegación excedida (${_delegationDepth}). Sintetizá con lo que tenés.`, history };
    }
    // Un subagente con maxDelegationDepth=0 no puede re-delegar.
    if (_isDelegated && _subagentConfig && _subagentConfig.maxDelegationDepth === 0 && _delegationDepth > 1) {
      return { text: `Error: subagente de tipo "${_subagentConfig.type}" no puede re-delegar.`, history };
    }
    // Procesar archivos no-imagen: extraer contenido como texto y adjuntarlo al mensaje
    if (files && files.length > 0) {
      text = await this._processFiles(text, files);
    }

    // Fase 4 extra — si hay un suspended prompt pendiente para este chat, el
    // próximo mensaje se interpreta como respuesta a esa pregunta. El tool
    // `ask_user_question` que originó el suspend recibe el texto y el loop
    // que lo invocó continúa.
    if (chatId && this._loopRunner && typeof this._loopRunner.hasSuspended === 'function'
        && this._loopRunner.hasSuspended(String(chatId)) && !_isDelegated) {
      const resumed = this._loopRunner.resume(String(chatId), text);
      if (resumed) {
        csdbg('suspend', `resumed suspended prompt for chat=${chatId}`);
        return { text: '(respuesta entregada al loop pausado)', history, _resumed: true };
      }
    }

    // Fase 11.2 — slash commands: detectar "/slug [resto]" y resolver contra skills.
    // Una sola impl para todos los canales. No toca CommandHandler de telegram (que maneja /help etc).
    if (this._skills && typeof text === 'string' && text.trimStart().startsWith('/')) {
      try {
        const { parseSlashCommand } = require('../core/slashCommandParser');
        const parsed = parseSlashCommand(text, { skills: this._skills });
        if (parsed.slug) {
          csdbg('slash', `slug=${parsed.slug} resolved → injecting system-reminder`);
          text = parsed.injected + '\n\n' + parsed.text;
        }
      } catch (err) {
        csdbg('slash', `parse falló: ${err.message}`);
      }
    }

    const resolvedShellId = shellId || String(chatId);
    csdbg('msg', `chatId=${chatId} provider=${provider} agent=${agentKey} model=${model} textLen=${text.length} images=${images?.length || 0} histLen=${history.length} hasSession=${!!claudeSession}`);

    // Rate limiting configurable (solo providers API, no CLI)
    const CLI_PROVIDERS = new Set(['claude-code', 'gemini-cli']);
    if (!CLI_PROVIDERS.has(provider)) {
      const rateRule = this._limitsRepo
        ? this._limitsRepo.resolve('rate', { provider, agentKey, userId, botKey, channel })
        : { max_count: 10, window_ms: 60000 };
      const now = Date.now();
      const key = `${botKey || 'web'}:${chatId}`;
      let rl = this._rateLimits.get(key);
      if (!rl || now > rl.resetAt) {
        rl = { count: 0, resetAt: now + rateRule.window_ms };
        this._rateLimits.set(key, rl);
      }
      rl.count++;
      if (rl.count > rateRule.max_count) {
        const waitSec = Math.ceil((rl.resetAt - now) / 1000);
        return { text: `⏳ Rate limit: máximo ${rateRule.max_count} mensajes por ${Math.round(rateRule.window_ms / 1000)}s. Esperá ${waitSec}s.`, history };
      }
      this._rateLimits.set(key, rl);
    }

    if (!CLI_PROVIDERS.has(provider) && this._providers) {
      csdbg('msg', `→ _processApiProvider mode=${claudeMode} delegated=${_isDelegated} depth=${_delegationDepth}`);
      return this._processApiProvider({
        chatId, agentKey, provider, model, text, images, history, onChunk, onStatus, onAskPermission,
        claudeMode, shellId: resolvedShellId, botKey, channel, userId,
        _isDelegated, _delegationDepth, _subagentConfig, _parentPrefix, _workspace,
      });
    }

    if (provider === 'gemini-cli') {
      csdbg('msg', `→ _processGeminiCli mode=${claudeMode} model=${model}`);
      return this._processGeminiCli({
        chatId, agentKey, text, model, geminiSession, claudeMode, onChunk, onStatus, botKey, channel,
      });
    }

    csdbg('msg', `→ _processClaudeCode mode=${claudeMode}`);
    return this._processClaudeCode({
      chatId, agentKey, text, images, model, claudeSession, claudeMode, onChunk, onStatus, botKey, channel,
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

  // ── Helper: instrucciones de canal/tools para CLI providers ──────────────
  // Devuelve el bloque que le explica al modelo CÓMO usar las tools MCP en el
  // canal actual (WebChat vs Telegram). Reutilizable entre _processClaudeCode
  // y _processGeminiCli para mantener paridad de instrucciones.
  _buildCliChannelPrompt({ isWebChannel, channel, botKey, chatId, agentKey }) {
    const channelCtx = (botKey && chatId)
      ? `\n\n## Contexto del canal\n- Canal: ${channel || 'telegram'}\n- Bot key: ${botKey}\n- ${isWebChannel ? 'Session ID' : 'Chat ID'}: ${chatId}\n- Agente activo: ${agentKey || 'default'}\nUsa estos valores cuando necesites enviar fotos, documentos o mensajes al usuario.${isWebChannel ? `\nPara herramientas webchat_*, usa session_id="${chatId}".` : ''}\nPara herramientas de memoria (memory_list, memory_read, memory_write, etc.), usa agent="${agentKey || 'default'}".`
      : '';

    if (isWebChannel) {
      const webChannelPrompt =
        'Estás respondiendo a un usuario a través del WebChat de Clawmint.\n' +
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
        'No abuses: no en cada mensaje, solo cuando las opciones sean claras y útiles.';
      return webChannelPrompt + channelCtx;
    }

    // Telegram / otros canales: usar el prompt MCP de sistema (cargado de archivo)
    const mcpPrompt = getMcpSystemPrompt();
    return (mcpPrompt ? (mcpPrompt + channelCtx) : channelCtx);
  }

  // ── Proveedor gemini-cli (GeminiCliSession) ───────────────────────────────

  async _processGeminiCli({ chatId, agentKey, text, model, geminiSession, claudeMode, onChunk, onStatus, botKey, channel }) {
    const sessionRule = this._limitsRepo
      ? this._limitsRepo.resolve('session', { provider: 'gemini-cli', agentKey, botKey, channel })
      : { max_count: 10 };
    let session = geminiSession;
    let isNewSession = false;

    // Si el modelo cambió respecto a la sesión existente, descartarla para que se cree una
    // nueva con el modelo nuevo (gemini --resume con otro modelo no es seguro).
    if (session && model && session.model !== model) {
      csdbg('gemini', `model cambió (${session.model} → ${model}), descartando sesión`);
      session = null;
    }

    const isWebChannel = channel === 'web' || botKey === 'web';
    // Instrucciones completas de canal + tools (paridad con _processClaudeCode)
    const fullChannelPrompt = this._buildCliChannelPrompt({ isWebChannel, channel, botKey, chatId, agentKey });

    // Auto-reset de sesión y guardado de resumen en memoria
    if (session && session.messageCount >= sessionRule.max_count) {
      csdbg('gemini', `auto-reset: session tiene ${session.messageCount} msgs`);
      if (agentKey && this._memory) {
        try {
          const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
          const summary = `---\nSesión anterior (${ts}, ${session.messageCount} mensajes, chatId: ${chatId})\n---\n` +
            `Último mensaje del usuario: ${text.slice(0, 500)}`;
          this._memory.write(agentKey, 'last-session-summary.md', summary);
        } catch {}
      }
      session = null;
    }

    if (!session) {
      if (!this._GeminiCliSession) {
        return { text: 'Error: GeminiCliSession no disponible. Instalá gemini CLI.' };
      }
      const provObj = this._providers ? this._providers.get('gemini-cli') : null;
      const effectiveModel = model || provObj?.defaultModel || null;
      session = new this._GeminiCliSession({
        permissionMode: claudeMode || 'auto',
        model: effectiveModel,
      });
      isNewSession = true;
      csdbg('gemini', `nueva GeminiCliSession mode=${claudeMode} model=${effectiveModel || '(default CLI)'}`);
    }

    // Detección de señales de memoria e inyección de contexto
    const { shouldNudge, signals } = (agentKey && this._memory)
      ? this._memory.detectSignals(agentKey, text)
      : { shouldNudge: false, signals: [] };

    let messageText = text;
    // Inyección de contexto inicial: agent prompt + memoria + channel ctx (sólo en sesión nueva o primer mensaje)
    if (isNewSession || (session.messageCount <= 1)) {
      const agentDef = (agentKey && this._agents) ? this._agents.get(agentKey) : null;
      let agentPrompt = '';
      if (agentDef) {
        try {
          agentPrompt = this._skills && typeof this._skills.buildAgentPrompt === 'function'
            ? this._skills.buildAgentPrompt(agentDef)
            : (agentDef.prompt || '');
        } catch { agentPrompt = agentDef.prompt || ''; }
      }

      let memCtx = '';
      let toolInstr = '';
      let sessionSummary = '';
      if (agentKey && this._memory) {
        let memCtxRaw = this._memory.buildMemoryContext(agentKey, text, { provider: 'local' });
        if (memCtxRaw && typeof memCtxRaw.then === 'function') {
          memCtxRaw = await memCtxRaw.catch(() => '');
        }
        memCtx = memCtxRaw || '';
        // En primer mensaje de sesión nueva siempre inyectar las instrucciones de memoria,
        // así el agente conoce la sintaxis <save_memory>/<append_memory> y puede empezar
        // a recordar. Después solo si hay señales (para no engordar cada turno).
        toolInstr = (isNewSession || shouldNudge) ? this._memory.TOOL_INSTRUCTIONS : '';
        try {
          const summary = this._memory.read(agentKey, 'last-session-summary.md');
          if (summary) sessionSummary = `## Resumen de sesión anterior\n${summary}`;
        } catch {}
      }

      const parts = [agentPrompt, fullChannelPrompt, sessionSummary, memCtx, toolInstr].filter(Boolean);
      if (parts.length > 0) messageText = `${parts.join('\n\n')}\n\n---\n\n${text}`;
    }
    if (shouldNudge && this._memory) messageText += this._memory.buildNudge(signals);

    csdbg('gemini', `→ session.sendMessage() textLen=${messageText.length}`);
    let result;
    try {
      result = await session.sendMessage(messageText, onChunk, onStatus);
    } catch (err) {
      // Reintentar como nueva sesión si --resume falló
      if (session.geminiSessionId && session.messageCount > 0) {
        csdbg('gemini', `--resume falló (${err.message}), reintentando sin resume`);
        session.geminiSessionId = null;
        session.messageCount    = 0;
        isNewSession = true;
        try {
          result = await session.sendMessage(messageText, onChunk, onStatus);
        } catch (retryErr) {
          if (retryErr.message.includes('ENOENT')) {
            return { text: 'gemini CLI no está instalado o no está en el PATH. Instalalo con: `npm install -g @google/gemini-cli`' };
          }
          throw retryErr;
        }
      } else if (err.message.includes('ENOENT')) {
        return { text: 'gemini CLI no está instalado o no está en el PATH. Instalalo con: `npm install -g @google/gemini-cli`' };
      } else {
        throw err;
      }
    }

    const rawResponse = typeof result === 'string' ? result : (result?.text || '');

    // Extraer y aplicar operaciones de memoria
    let response = rawResponse;
    const savedMemoryFiles = [];
    if (agentKey && rawResponse && this._memory) {
      const { clean, ops } = this._memory.extractMemoryOps(rawResponse);
      if (ops.length > 0) {
        const saved = this._memory.applyOps(agentKey, ops);
        response = clean || rawResponse;
        savedMemoryFiles.push(...saved);
      }
    }

    return {
      text: response || '',
      usedMcpTools: false,
      savedMemoryFiles,
      ...(isNewSession ? { newGeminiSession: session } : {}),
    };
  }

  // ── Proveedor claude-code (ClaudePrintSession) ────────────────────────────

  async _processClaudeCode({ chatId, agentKey, text, images, model, claudeSession, claudeMode, onChunk, onStatus, botKey, channel }) {
    // Resolver modelo efectivo: explícito del chat → defaultModel del provider (haiku) → null (default del CLI)
    const provObj = this._providers ? this._providers.get('claude-code') : null;
    const effectiveModel = model || provObj?.defaultModel || null;
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
    const sessionRule = this._limitsRepo
      ? this._limitsRepo.resolve('session', { provider: 'claude-code', agentKey, botKey, channel })
      : { max_count: 10 };
    let session = claudeSession;
    let isNewSession = false;

    // Defensa: si llega como string (claude_session_id rehidratado de SQLite por WebChannel),
    // construir una ClaudePrintSession real con ese ID para que `--resume` funcione y evitar
    // el `TypeError: Cannot create property 'appendSystemPrompt' on string`.
    if (typeof session === 'string' && session.length > 0) {
      session = new this._ClaudePrintSession({
        permissionMode: claudeMode || 'auto',
        claudeSessionId: session,
        messageCount: 1,
        mcpConfig: MCP_CONFIG_PATH,
        model: effectiveModel,
      });
      csdbg('claude', `hidratada session string → objeto (id=${session.claudeSessionId} model=${effectiveModel})`);
    }

    const isWebChannel = channel === 'web' || botKey === 'web';
    // Mismo bloque que usa _processGeminiCli — paridad de instrucciones de tools entre CLI providers.
    const fullSystemPrompt = this._buildCliChannelPrompt({ isWebChannel, channel, botKey, chatId, agentKey });

    // Auto-reset: si la sesión tiene demasiados mensajes, crear una nueva
    // Antes de resetear, guardar resumen en memoria para continuidad
    if (session && session.messageCount >= sessionRule.max_count) {
      csdbg('claude', `auto-reset: session tiene ${session.messageCount} msgs (max ${sessionRule.max_count}), creando nueva`);
      console.log(`[ConvSvc] Auto-reset de sesión (${session.messageCount}/${sessionRule.max_count} mensajes)`);

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
        mcpConfig: MCP_CONFIG_PATH,
        model: effectiveModel,
      });
      isNewSession = true;
      csdbg('claude', `nueva ClaudePrintSession mode=${claudeMode} model=${effectiveModel} botKey=${botKey}`);
    } else {
      // Siempre actualizar el system prompt (puede haber cambiado entre reinicios)
      if (fullSystemPrompt) {
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
    csdbg('claude', `messageCount=${session.messageCount} agentKey=${agentKey} hasMemory=${!!this._memory}`);
    if (agentKey && this._memory) {
      if (session.messageCount <= 1 || isNewSession) {
        // buildMemoryContext puede retornar string o Promise (si usa embeddings locales)
        let memCtxRaw = this._memory.buildMemoryContext(agentKey, text, { provider: 'local' });
        if (memCtxRaw && typeof memCtxRaw.then === 'function') {
          memCtxRaw = await memCtxRaw.catch(() => '');
        }
        const memCtx = memCtxRaw || '';
        const toolInstr = shouldNudge ? this._memory.TOOL_INSTRUCTIONS : '';
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
    // D4 — capturar eventos estructurados del CLI (tool_call, tool_result, usage).
    // Permite observabilidad + hooks pre/post_tool_use (observacionales, el CLI ejecuta internamente).
    let cliUsage = null;
    const hookCtx = { chatId, userId: null, agentKey, channel: channel || 'telegram', botKey };
    const onEvent = (ev) => {
      try {
        if (ev.type === 'usage') {
          cliUsage = {
            promptTokens: ev.promptTokens,
            completionTokens: ev.completionTokens,
            cacheCreation: ev.cacheCreation,
            cacheRead: ev.cacheRead,
            costUsd: ev.costUsd,
          };
        }
        // Emitir al eventBus para UI/metrics (no bloquea)
        if (this._eventBus) {
          if (ev.type === 'tool_call') {
            this._eventBus.emit('cli:tool_call', { chatId, agentKey, name: ev.name, args: ev.args });
          } else if (ev.type === 'tool_result') {
            this._eventBus.emit('cli:tool_result', { chatId, agentKey, tool_use_id: ev.tool_use_id, isError: ev.isError });
          }
        }
        // Hooks observacionales (no pueden bloquear porque el CLI ya ejecutó)
        if (this._hookRegistry && this._hookRegistry.enabled && ev.type === 'tool_call') {
          this._hookRegistry.emit('pre_tool_use',
            { name: ev.name, args: ev.args || {}, agentKey, userId: null, _observational: true },
            hookCtx
          ).catch(() => {});
        }
        if (this._hookRegistry && this._hookRegistry.enabled && ev.type === 'tool_result') {
          this._hookRegistry.emit('post_tool_use',
            { name: ev.tool_use_id, result: ev.content, agentKey, userId: null, _observational: true, isError: ev.isError },
            hookCtx
          ).catch(() => {});
        }
      } catch { /* fire-and-forget */ }
    };

    let result;
    try {
      result = await session.sendMessage(messageText, onChunk, onStatus, onEvent);
    } catch (err) {
      // Si falló con --resume (session_id viejo/inválido), reintentar como nueva sesión
      if (session.claudeSessionId && session.messageCount > 0) {
        csdbg('claude', `--resume falló (${err.message}), reintentando como nueva sesión`);
        console.log(`[ConvSvc] --resume falló (${err.message}), reintentando sin resume`);
        session.claudeSessionId = null;
        session.messageCount = 0;
        isNewSession = true;
        result = await session.sendMessage(messageText, onChunk, onStatus, onEvent);
      } else {
        throw err;
      }
    }

    // sendMessage ahora devuelve { text, usedMcpTools } o string (backward compat)
    const rawResponse = typeof result === 'string' ? result : (result?.text || '');
    const usedMcpTools = typeof result === 'object' ? result.usedMcpTools : false;
    csdbg('claude', `← session.sendMessage() ${Date.now() - t0}ms responseLen=${rawResponse.length} usedMcpTools=${usedMcpTools} usage=${cliUsage ? 'yes' : 'no'}`);

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
      usage: cliUsage, // D4 — usage del CLI disponible (antes siempre null)
      ...(isNewSession ? { newSession: session } : {}),
    };
  }

  // ── Proveedores API (Anthropic, Gemini, OpenAI, …) ───────────────────────

  async _processApiProvider({ chatId, agentKey, provider, model, text, images, history, onChunk, onStatus, onAskPermission, claudeMode, shellId, botKey, channel, userId, _isDelegated = false, _delegationDepth = 0, _subagentConfig = null, _parentPrefix = null, _workspace = null }) {
    const provObj   = this._providers.get(provider);
    const apiKey    = this._providerConfig ? this._providerConfig.getApiKey(provider) : '';
    const cfg       = this._providerConfig ? this._providerConfig.getConfig() : {};
    const useModel  = model || cfg.providers?.[provider]?.model || provObj.defaultModel;

    // Inyectar executor con contexto de shell para persistencia de cwd/env
    const mcpExec  = this._getExecuteTool();
    // Resolver role del agente para filtrado de tools
    const agentDef  = agentKey && this._agents ? this._agents.get(agentKey) : null;
    const agentRole = agentDef?.role || undefined;

    const rawExecFn = mcpExec
      ? (name, args) => mcpExec(name, args, {
          shellId,
          sessionManager: this._sessionManager,
          memory: this._memory,
          scheduler: this._scheduler,
          usersRepo: this._usersRepo,
          orchestrator: this._orchestrator,
          limitsRepo: this._limitsRepo,
          tasksRepo: this._tasksRepo,
          permissionService: this._permissionService,
          toolCatalog: this._toolCatalog,
          typedMemoryService: this._typedMemoryService,
          planModeService: this._planModeService,
          jobQuotaService: this._jobQuotaService,
          mcpAuthService: this._mcpAuthService,
          lspServerManager: this._lspServerManager,
          resumableSessionsRepo: this._resumableSessionsRepo,
          workspaceRegistry: this._workspaceRegistry,
          loopRunner: this._loopRunner,
          eventBus: this._eventBus,
          locationService: this._locationService,
          userPreferencesRepo: this._userPreferencesRepo,
          reminders: this._reminders,
          householdRepo: this._householdRepo,
          hookRegistry: this._hookRegistry,
          _convSvc: this,
          agents: this._agents,
          chatId,
          channel: channel || 'telegram',
          agentKey,
          botKey,
          userId,
          _isDelegated,
          _delegationDepth,
          _subagentConfig,
          allowedToolPatterns: _subagentConfig ? _subagentConfig.allowedToolPatterns : null,
        })
      : undefined;

    // Wrappear execToolFn: hooks → permission → mode → execute
    const mode = claudeMode || 'auto';
    let execToolFn = rawExecFn;

    const hookCtx = { chatId, userId, channel: channel || 'telegram', agentKey, botKey };
    const hookRegistry = this._hookRegistry;
    const permSvc = this._permissionService;
    const permCtx = { chatId, userId, channel: channel || 'telegram', usersRepo: this._usersRepo };

    if (rawExecFn) {
      const innerExec = rawExecFn;
      execToolFn = async (name, args) => {
        // 1. pre_tool_use hook
        let currentArgs = args;
        if (hookRegistry && hookRegistry.enabled) {
          const preResult = await hookRegistry.emit('pre_tool_use',
            { name, args: currentArgs, agentKey, userId },
            hookCtx
          );
          if (preResult.block) {
            return `Herramienta "${name}" bloqueada por hook: ${preResult.block}`;
          }
          currentArgs = preResult.args;
        }

        // 2. permission gate (palabra final sobre hooks)
        if (permSvc) {
          const action = permSvc.resolve(name, permCtx);
          if (action === 'deny') {
            return `Herramienta "${name}" rechazada por política de permisos.`;
          }
          if (action === 'ask') {
            if (!onAskPermission) return `Herramienta "${name}" requiere aprobación del usuario (canal no soporta prompts).`;
            const ok = await onAskPermission(name, currentArgs);
            if (!ok) return 'Herramienta rechazada por el usuario.';
          }
        }

        // 3. ejecutar
        const result = await innerExec(name, currentArgs);

        // 4. post_tool_use hook (observación; no muta result)
        if (hookRegistry && hookRegistry.enabled) {
          try {
            await hookRegistry.emit('post_tool_use',
              { name, args: currentArgs, result, agentKey, userId },
              hookCtx
            );
          } catch { /* post hook errors no rompen el result */ }
        }

        return result;
      };
    }

    // Mode wrapper se aplica al final (por encima de hooks+permission)
    if (mode === 'plan' && execToolFn) {
      execToolFn = async (name, args) =>
        `[Modo Plan] Se ejecutaría ${name}(${JSON.stringify(args)}). No ejecutado — describí qué harías.`;
    } else if (mode === 'ask' && execToolFn && onAskPermission && !this._permissionService?.enabled) {
      // Solo aplicar modo ask legacy si permissions está deshabilitado (evitar doble prompt)
      const inner = execToolFn;
      execToolFn = async (name, args) => {
        const approved = await onAskPermission(name, args);
        if (!approved) return 'Herramienta rechazada por el usuario.';
        return inner(name, args);
      };
    }

    // System prompt con instrucciones de herramientas según canal
    const toolPrompt = this._buildToolSystemPrompt(channel, botKey, chatId, agentKey);
    // A2 — instrucciones desde CLAUDE.md/GLOBAL.md/AGENTS.md (si el loader está inyectado y habilitado)
    let instructionsBlock = '';
    if (this._instructionsLoader && this._instructionsLoader.enabled) {
      try {
        instructionsBlock = this._instructionsLoader.build({
          cwd: shellId ? undefined : undefined, // cwd del chat se podría inferir de ShellSession
          chatId, userId, agentKey, channel: channel || 'telegram',
        });
      } catch (err) {
        this._logger.warn && this._logger.warn(`[ConversationService] InstructionsLoader falló: ${err.message}`);
      }
    }
    let basePrompt = toolPrompt || 'Sos un asistente útil. Respondé de forma concisa y clara.';
    if (instructionsBlock) basePrompt = `${instructionsBlock}\n\n${basePrompt}`;
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

    // D3 — Cache-optimized system prompt: bloques estables (toolPrompt + InstructionsLoader)
    // llevan el cache breakpoint; bloques dinámicos (memoryCtx cambia por spreading activation,
    // toolInstr depende de signals) van DESPUÉS y no rompen el cache prefix.
    // Si el provider soporta cache (Anthropic), emitimos array; si no, join-eamos a string.
    const providerSupportsArraySystem = (provObj && provObj.name === 'anthropic');
    let systemPrompt;
    if (providerSupportsArraySystem && basePrompt) {
      const blocks = [{ type: 'text', text: basePrompt, _cacheable: true }];
      if (memoryCtx) blocks.push({ type: 'text', text: memoryCtx });
      if (toolInstr) blocks.push({ type: 'text', text: toolInstr });
      systemPrompt = blocks;
    } else {
      systemPrompt = [basePrompt, memoryCtx, toolInstr].filter(Boolean).join('\n\n');
    }

    // Fase 7.5.7 — prefix cache share: si el orchestrator pasó el system prompt
    // del coordinador, lo usamos para que el provider haga cache hit. Solo aplica
    // cuando el subagente comparte cache (skipCacheWrite=false).
    if (_parentPrefix && _parentPrefix.systemPrompt && _isDelegated
        && (!_subagentConfig || _subagentConfig.skipCacheWrite === false)) {
      systemPrompt = _parentPrefix.systemPrompt;
      const len = typeof systemPrompt === 'string' ? systemPrompt.length : JSON.stringify(systemPrompt).length;
      csdbg('prefix-share', `usando system prompt del coordinador (len=${len})`);
    } else if (this._orchestrator && !_isDelegated && chatId) {
      // Capturar el system prompt del coordinador para futuras delegaciones del workflow.
      // workflowId se infiere desde el orchestrator's chat→workflow map si existe.
      try {
        const wfId = this._orchestrator.getActiveWorkflowId && this._orchestrator.getActiveWorkflowId(chatId);
        if (wfId && typeof this._orchestrator.captureCoordinatorPrefix === 'function') {
          this._orchestrator.captureCoordinatorPrefix(wfId, { systemPrompt, provider, model });
        }
      } catch { /* no-op */ }
    }
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

    // Compactar historial vía CompactorPipeline (Fase 7). Si no está inyectado, fallback legacy.
    let compactedHistory;
    if (this._compactorPipeline && this._compactorPipeline.enabled) {
      let piped = null;
      let circuitOpen = false;
      try {
        piped = await this._compactorPipeline.maybeCompact(history, {
          turnCount:    history.length,
          historySize:  history.length,
          ctx: { chatId, agentKey, provider, apiKey, model: useModel, hookRegistry: this._hookRegistry },
        });
      } catch (err) {
        // Fase 7.5.5: circuit breaker abierto → abortar turn con mensaje claro al usuario
        if (err && err.name === 'CompactCircuitOpenError') {
          csdbg('compact', `circuit breaker abierto para chat ${chatId}; abortando turn`);
          circuitOpen = true;
        } else {
          csdbg('compact', `pipeline falló: ${err.message}; fallback legacy`);
        }
      }
      if (circuitOpen) {
        return {
          text: 'Error: la compactación de contexto falló 3 veces seguidas para este chat. Empezá una conversación nueva o aumentá el contexto manualmente para continuar.',
          history,
        };
      }
      compactedHistory = piped && Array.isArray(piped.history)
        ? piped.history
        : await this._compactHistory(history, provider, apiKey, useModel);
    } else {
      compactedHistory = await this._compactHistory(history, provider, apiKey, useModel);
    }
    const updatedHistory = [...compactedHistory, { role: 'user', content: userContent }];

    // Para Gemini y Ollama: adjuntar imágenes raw para conversión en el provider
    const extraOpts = {};
    if (images && images.length > 0 && (provider === 'gemini' || provider === 'ollama')) {
      extraOpts.images = images;
    }

    // Detectar channel para filtrar critter tools (p2p desde shellId, o el channel del caller)
    const toolChannel = shellId?.startsWith('p2p-') ? 'p2p' : channel || undefined;

    let accumulated = '';
    let usedToolsEver = false;
    let usage = null;
    // D2 — mensajes internos del turno preservados por el provider (array de content blocks con
    // thinking/tool_use). Si el provider no los emite, queda null y se usa el fallback string.
    let turnMessages = null;

    // Ajuste 6.6: hook 'chat.params' permite mutar temperature/topP/topK/maxTokens antes del provider.
    // Default params vacío — cada provider mantiene sus defaults si no se mutan acá.
    let chatParams = {};
    if (this._hookRegistry && this._hookRegistry.enabled) {
      const paramsResult = await this._hookRegistry.emit('chat.params',
        { params: chatParams, provider, model: useModel, agentKey },
        { chatId, userId, channel: channel || 'telegram', agentKey }
      );
      if (paramsResult.block) {
        return { text: `Error: turn bloqueado por hook chat.params: ${paramsResult.block}`, history };
      }
      if (paramsResult.params) chatParams = paramsResult.params;
    }

    const chatArgs = { systemPrompt, history: updatedHistory, apiKey, model: useModel, executeTool: execToolFn, channel: toolChannel, agentRole, userId, ...chatParams, ...extraOpts };

    if (this._useLoopRunner && this._loopRunner) {
      const result = await this._loopRunner.run({
        chatId, agentKey, provider, model: useModel,
        chatArgs,
        provObj,
        onChunk, onStatus,
        timeoutMs: 120_000,
      });
      accumulated   = result.text;
      usage         = result.usage;
      usedToolsEver = result.usedTools;
      turnMessages  = result.turnMessages || null; // D2
      csdbg('loop', `runner done stopReason=${result.stopReason} usedTools=${result.usedTools}`);
    } else {
      // ── Path legacy (rollback via USE_LOOP_RUNNER=false) ───────────────────
      const MAX_RETRIES = 3;
      const GLOBAL_TIMEOUT_MS = 120000;
      let usedTools = false;

      if (onStatus) onStatus('thinking');

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
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
              if (Array.isArray(event.turnMessages)) turnMessages = event.turnMessages; // D2
            }
          }
        } catch (err) {
          accumulated = `Error ${provider}: ${err.message}`;
        } finally {
          clearTimeout(timeoutId);
        }

        const isError = accumulated.startsWith('Error');
        const isTransient = isError && /timeout|429|500|502|503|ECONNRESET|ETIMEDOUT|rate.limit/i.test(accumulated);
        if (!isError || !isTransient || attempt === MAX_RETRIES - 1) break;

        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        csdbg('retry', `attempt ${attempt + 1}/${MAX_RETRIES}, waiting ${Math.round(delay)}ms — ${accumulated.slice(0, 100)}`);
        if (onStatus) onStatus('thinking', `reintento ${attempt + 2}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, delay));
      }

      if (onStatus && usedTools) onStatus('done');
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

    // D2 — si el provider emitió `turnMessages` (array de content blocks preservados con
    // thinking/tool_use), lo usamos en lugar del fallback `{role:'assistant', content:finalText}`.
    // Esto mantiene la trayectoria completa en el history persistido (SQLite `ai_history`).
    // Providers que no lo emiten (gemini/ollama/etc.) siguen con el path string — zero breaking.
    if (Array.isArray(turnMessages) && turnMessages.length > 0) {
      for (const m of turnMessages) {
        if (m && typeof m === 'object' && m.role && m.content !== undefined) {
          updatedHistory.push(m);
        }
      }
      // Si memoryOps limpió el texto (<save_memory> tags), actualizamos el último text block
      // del último assistant para que el history persista la versión limpia.
      if (finalText !== accumulated) {
        const lastAssistant = [...updatedHistory].reverse().find(m => m.role === 'assistant');
        if (lastAssistant && Array.isArray(lastAssistant.content)) {
          const textBlock = lastAssistant.content.find(b => b && b.type === 'text');
          if (textBlock) textBlock.text = finalText;
        }
      }
    } else {
      updatedHistory.push({ role: 'assistant', content: finalText });
    }

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
