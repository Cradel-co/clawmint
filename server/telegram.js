'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const sessionManager = require('./sessionManager');
const agentsModule = require('./agents');
const skillsModule = require('./skills');
const memoryModule = require('./memory');
const events = require('./events');

// Cargar providers y config (pueden no estar disponibles en versiones viejas)
let providersModule, providerConfig;
try { providersModule = require('./providers'); } catch {}
try { providerConfig  = require('./provider-config'); } catch {}

const BOTS_FILE = path.join(__dirname, 'bots.json');
const TELEGRAM_HOST = 'api.telegram.org';
const POLL_TIMEOUT = 25; // segundos
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hora

// ─── Utilidades ───────────────────────────────────────────────────────────────

/**
 * Limpia output de PTY para enviarlo como texto plano a Telegram.
 * Simula comportamiento básico del terminal:
 * - Convierte cursor-right a espacios
 * - Simula carriage return (sobrescritura desde col 0)
 * - Filtra líneas decorativas del TUI
 */
function cleanPtyOutput(raw) {
  // 1. Cursor-right → espacios (evita que las palabras se junten)
  let s = raw.replace(/\x1B\[(\d*)C/g, (_, n) => ' '.repeat(Number(n) || 1));

  // 2. Eliminar todas las demás secuencias ANSI (colores, cursor up/down, etc.)
  s = s
    .replace(/\x1B\[[0-9;?]*[A-Za-z@]/g, '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[A-Z\\]/g, '')
    .replace(/[\x00-\x08\x0E-\x1F\x7F]/g, '');

  // 3. Simular carriage return: dividir por \n, luego dentro de cada línea
  //    cada \r "vuelve al inicio" — el segmento más largo gana
  const lines = s.split('\n').map(line => {
    const segs = line.split('\r');
    let rendered = segs[0] || '';
    for (let i = 1; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.length >= rendered.length) {
        rendered = seg;
      } else if (seg.length > 0) {
        rendered = seg + rendered.slice(seg.length);
      }
    }
    return rendered.trimEnd();
  });

  // 4. Filtrar líneas decorativas del TUI de Claude Code
  const filtered = lines.filter(line => {
    const t = line.trim();
    if (!t) return false;
    if (/^[─━═\-─]{4,}$/.test(t)) return false;       // separadores
    if (/^[▐▛▜▌▝▘█▙▟▄▀■]+/.test(t)) return false;     // logo art
    if (/^\?.*shortcuts/.test(t)) return false;          // "? for shortcuts"
    if (/^ctrl\+/.test(t)) return false;                 // hints del teclado
    if (/^❯\s*$/.test(t)) return false;                  // prompt vacío
    return true;
  });

  return filtered
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Alias para compatibilidad
function stripAnsi(str) {
  return cleanPtyOutput(str);
}

function chunkText(text, size = 4096) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks.length > 0 ? chunks : [''];
}

// ─── Monitor helpers ──────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(0)   + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

function getSystemStats() {
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedMem  = totalMem - freeMem;
  const memPct   = Math.round((usedMem / totalMem) * 100);

  const [l1, l5, l15] = os.loadavg();
  const cpuCount = os.cpus().length;
  const cpuPct   = Math.min(100, Math.round((l1 / cpuCount) * 100));

  const uptimeSecs = os.uptime();
  const days  = Math.floor(uptimeSecs / 86400);
  const hours = Math.floor((uptimeSecs % 86400) / 3600);
  const mins  = Math.floor((uptimeSecs % 3600) / 60);

  let disk = 'N/A';
  try {
    const df  = execSync('df -h /', { encoding: 'utf8', timeout: 3000 });
    const row = df.trim().split('\n')[1]?.split(/\s+/);
    if (row) disk = `${row[2]} / ${row[1]} (${row[4]})`;
  } catch {}

  return {
    cpu:    `${cpuPct}% (load: ${l1.toFixed(1)}, ${l5.toFixed(1)}, ${l15.toFixed(1)})`,
    ram:    `${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memPct}%)`,
    disk,
    uptime: `${days}d ${hours}h ${mins}m`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function httpsPost(urlPath, body, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: TELEGRAM_HOST,
      path: urlPath,
      method: 'POST',
      family: 4, // forzar IPv4 (evita ENETUNREACH en WSL2)
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Respuesta no es JSON: ' + raw.slice(0, 200))); }
      });
    });

    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Timeout')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Audio: descarga + transcripción ─────────────────────────────────────────

/**
 * Descarga un archivo binario por HTTPS y lo guarda en disco.
 * Retorna la ruta local del archivo descargado.
 */
function httpsDownload(url, destPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      family: 4,
    };
    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsDownload(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(destPath); });
      ws.on('error', reject);
    });
    req.setTimeout(30000, () => { req.destroy(new Error('Download timeout')); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Transcribe un archivo de audio usando faster-whisper (CTranslate2).
 * @param {string} filePath - ruta al archivo OGG/MP3/WAV
 * @returns {Promise<string>} texto transcrito
 */
function transcribeAudio(filePath) {
  return new Promise((resolve, reject) => {
    const pythonBin = path.join(process.env.HOME, '.venvs', 'whisper', 'bin', 'python3');
    const script = `
import sys
from faster_whisper import WhisperModel
model = WhisperModel("medium", device="cpu", compute_type="int8")
segments, _ = model.transcribe(sys.argv[1], language="es", beam_size=5)
print(" ".join(s.text.strip() for s in segments))
`;
    const child = spawn(pythonBin, ['-c', script, filePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('close', (exitCode) => {
      if (exitCode !== 0) {
        return reject(new Error(`faster-whisper salió con código ${exitCode}: ${stderr.slice(0, 300)}`));
      }
      const text = stdout.trim();
      if (!text) {
        return reject(new Error('No se pudo extraer texto del audio'));
      }
      resolve(text);
    });

    child.on('error', reject);
  });
}

// ─── ClaudePrintSession (modo no-interactivo via `claude -p`) ─────────────────

class ClaudePrintSession {
  constructor({ model = null, permissionMode = 'ask' } = {}) {
    this.id = crypto.randomUUID();
    this.createdAt = Date.now();
    this.active = true;
    this.messageCount = 0;
    this.title = 'claude';
    this.model = model;                    // modelo explícito (null = default)
    this.permissionMode = permissionMode;  // 'auto' | 'ask' | 'plan'
    this.totalCostUsd = 0;        // costo acumulado de la sesión
    this.lastCostUsd = 0;         // costo del último mensaje
    this.claudeSessionId = null;  // session_id interno de claude
    this.cwd = process.env.HOME;  // directorio de trabajo de la sesión
  }

  async sendMessage(text, onChunk = null) {
    const claudeArgs = [
      '-p', text,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];
    if (this.permissionMode === 'auto') {
      claudeArgs.unshift('--dangerously-skip-permissions');
    } else {
      const modeMap = { ask: 'default', plan: 'plan' };
      claudeArgs.unshift('--permission-mode', modeMap[this.permissionMode] || 'default');
    }
    if (this.model) claudeArgs.push('--model', this.model);
    if (this.messageCount > 0) claudeArgs.push('--continue');

    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;

      // Usar spawn con stdin: 'ignore' para evitar hang y crash de node-pty en WSL2
      const child = spawn('claude', claudeArgs, {
        cwd: process.env.HOME,
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      let lineBuffer = '';
      let fullText = '';
      let killed = false;
      let exited = false;

      const killTimer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGTERM'); } catch {}
      }, 1080000); // 18 minutos

      const processLine = (line) => {
        const jsonStr = line.trim();
        if (!jsonStr || jsonStr === '[DONE]') return;

        try {
          const event = JSON.parse(jsonStr);

          // stream_event envuelve los eventos reales de la API (content_block_delta, etc.)
          if (event.type === 'stream_event' && event.event) {
            const raw = event.event;
            const inner = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
              fullText += inner.delta.text;
              if (onChunk) onChunk(fullText);
            }
          }
          // assistant event con texto acumulado (fallback solo si streaming no dio nada)
          else if (event.type === 'assistant') {
            const content = event.message?.content;
            if (Array.isArray(content)) {
              const textBlock = content.find(b => b.type === 'text');
              // Solo usar si los deltas no produjeron nada (evita mezclar turnos anteriores)
              if (textBlock?.text && !fullText) {
                fullText = textBlock.text;
                if (onChunk) onChunk(fullText);
              }
            }
          }
          // system event: capturar modelo activo y cwd
          else if (event.type === 'system') {
            if (event.model) this.model = this.model || event.model;
            if (event.cwd) this.cwd = event.cwd;
          }
          // result event: texto final definitivo + metadatos
          else if (event.type === 'result') {
            // Solo usar como fallback; el streaming acumulado es más confiable
            if (event.result && !fullText) fullText = event.result;
            if (event.session_id) this.claudeSessionId = event.session_id;
            if (event.cwd) this.cwd = event.cwd;
            if (event.total_cost_usd != null) {
              this.lastCostUsd = event.total_cost_usd - this.totalCostUsd;
              this.totalCostUsd = event.total_cost_usd;
            }
          }
        } catch { /* ignorar líneas no-JSON */ }
      };

      child.stdout.on('data', (chunk) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) processLine(line);
      });

      child.on('close', (exitCode) => {
        if (exited) return;
        exited = true;
        clearTimeout(killTimer);
        // Procesar cualquier dato residual en el buffer
        if (lineBuffer.trim()) processLine(lineBuffer);
        if (killed) return reject(new Error('Timeout: claude -p no respondió en 18 min'));
        if (exitCode !== 0 && !fullText) {
          console.error('[ClaudePrintSession] exitCode:', exitCode);
          return reject(new Error(`claude salió con código ${exitCode}`));
        }
        this.messageCount++;
        resolve(fullText.trim());
      });
    });
  }
}

// ─── Clase TelegramBot (una instancia por bot) ────────────────────────────────

class TelegramBot {
  constructor(key, token, { initialOffset = 0, onOffsetSave = null } = {}) {
    this.key = key;
    this.token = token;
    this.running = false;
    this.offset = initialOffset;
    this._onOffsetSave = onOffsetSave;
    this.botInfo = null;
    this.defaultAgent = 'claude'; // key del agente por defecto
    this.whitelist = [];          // array de chatIds permitidos (vacío = todos)
    this.rateLimit = 30;          // mensajes por hora (0 = sin límite)
    this.rateLimitKeyword = '';   // palabra clave para resetear rate limit ('' = deshabilitado)
    this.rateCounts = new Map();  // chatId → { count, windowStart }
    /** @type {Map<number, object>} */
    this.chats = new Map();
  }

  setDefaultAgent(agentKey) {
    this.defaultAgent = agentKey;
  }

  setWhitelist(ids) { this.whitelist = ids.map(Number).filter(Boolean); }
  setRateLimit(n)   { this.rateLimit = Math.max(0, parseInt(n, 10) || 0); }
  setRateLimitKeyword(kw) { this.rateLimitKeyword = (kw || '').trim(); }


  _isAllowed(chatId) {
    if (this.whitelist.length === 0) return true;
    return this.whitelist.includes(chatId);
  }

  _checkRateLimit(chatId) {
    if (this.rateLimit === 0) return true;
    const now = Date.now();
    let entry = this.rateCounts.get(chatId);
    if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
      entry = { count: 0, windowStart: now };
      this.rateCounts.set(chatId, entry);
    }
    if (entry.count >= this.rateLimit) return false;
    entry.count++;
    return true;
  }

  _isClaudeBased(agentKey = this.defaultAgent) {
    if (agentKey === 'claude') return true;
    const def = agentsModule.get(agentKey);
    return !!(def && def.command && def.command.includes('claude'));
  }

  async _apiCall(method, body = {}) {
    const urlPath = `/bot${this.token}/${method}`;
    const data = await httpsPost(urlPath, body);
    if (!data.ok) throw new Error(data.description || `Telegram error: ${method}`);
    return data.result;
  }

  async _getUpdates() {
    const urlPath = `/bot${this.token}/getUpdates`;
    const data = await httpsPost(urlPath, {
      offset: this.offset,
      timeout: POLL_TIMEOUT,
      allowed_updates: ['message', 'callback_query'],
    }, (POLL_TIMEOUT + 10) * 1000);
    if (!data.ok) throw new Error(data.description || 'getUpdates error');
    return data.result;
  }

  async start() {
    if (this.running) return { username: this.botInfo?.username };

    const me = await this._apiCall('getMe');
    this.botInfo = { id: me.id, username: me.username, firstName: me.first_name };
    this.running = true;
    this._poll();
    console.log(`[Telegram] Bot "${this.key}" iniciado: @${me.username}`);
    return { username: me.username };
  }

  async stop() {
    this.running = false;
    console.log(`[Telegram] Bot "${this.key}" detenido`);
  }

  async _answerCallback(id, text = '') {
    try { await this._apiCall('answerCallbackQuery', { callback_query_id: id, text }); } catch {}
  }

  async _poll() {
    while (this.running) {
      try {
        const updates = await this._getUpdates();
        for (const update of updates) {
          this.offset = update.update_id + 1;
          try { await this._handleUpdate(update); } catch (err) {
            console.error(`[Telegram:${this.key}] Error en update:`, err.message);
          }
        }
        // Persistir offset tras cada batch para sobrevivir reinicios
        if (updates.length > 0 && this._onOffsetSave) this._onOffsetSave();
      } catch (err) {
        if (!this.running) break;
        console.error(`[Telegram:${this.key}] Error en polling:`, err.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  async _handleUpdate(update) {
    if (update.callback_query) {
      await this._handleCallbackQuery(update.callback_query);
      return;
    }
    const msg = update.message;
    if (!msg) return;

    // Voice/audio message → transcribir y tratar como texto
    if (msg.voice || msg.audio) {
      await this._handleVoiceMessage(msg);
      return;
    }

    if (!msg.text) return;
    await this._handleMessage(msg);
  }

  async _handleVoiceMessage(msg) {
    const chatId = msg.chat.id;

    if (!this._isAllowed(chatId)) {
      await this.sendText(chatId, '⛔ No tenés acceso a este bot.');
      return;
    }

    const fileId = msg.voice?.file_id || msg.audio?.file_id;
    const duration = msg.voice?.duration || msg.audio?.duration || 0;

    if (duration > 300) {
      await this.sendText(chatId, '⚠️ El audio es muy largo (máx 5 min).');
      return;
    }

    try {
      // 1. Obtener ruta del archivo en Telegram
      const fileInfo = await this._apiCall('getFile', { file_id: fileId });
      const fileUrl = `https://api.telegram.org/file/bot${this.token}/${fileInfo.file_path}`;

      // 2. Descargar a /tmp
      const tmpFile = path.join(os.tmpdir(), `clawmint_voice_${Date.now()}.ogg`);
      await httpsDownload(fileUrl, tmpFile);

      // 3. Transcribir con Whisper local
      await this.sendText(chatId, '🎙️ Transcribiendo audio...');
      const text = await transcribeAudio(tmpFile);

      // 4. Limpiar archivo temporal
      try { fs.unlinkSync(tmpFile); } catch {}

      if (!text || !text.trim()) {
        await this.sendText(chatId, '⚠️ No se pudo extraer texto del audio.');
        return;
      }

      console.log(`[Telegram:${this.key}] Audio transcrito de ${chatId}: ${text.slice(0, 60)}`);

      // 5. Inyectar como mensaje de texto normal
      msg.text = text;
      await this._handleMessage(msg);
    } catch (err) {
      console.error(`[Telegram:${this.key}] Error procesando audio:`, err.message);
      await this.sendText(chatId, `❌ Error al procesar audio: ${err.message}`);
    }
  }

  async _handleMessage(msg) {
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // /id siempre disponible, incluso sin whitelist
    if (text === '/id') {
      await this.sendText(chatId, `🪪 Tu chat ID es: \`${chatId}\``);
      return;
    }

    if (!this._isAllowed(chatId)) {
      await this.sendText(chatId, '⛔ No tenés acceso a este bot.');
      return;
    }

    // Inicializar chat ANTES del rate-limit (necesario para el flag rateLimited)
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = {
        chatId,
        username: msg.from?.username || null,
        firstName: msg.from?.first_name || 'Usuario',
        sessionId: null,
        claudeSession: null,
        activeAgent: null,  // { key, prompt } cuando hay agente de rol activo
        pendingAction: null, // { type, results? } para flujos multi-paso
        lastMessageAt: Date.now(),
        lastPreview: '',
        rateLimited: false,
        rateLimitedUntil: 0,
        monitorCwd: process.env.HOME,
        busy: false,
        provider: 'claude-code', // provider activo
        aiHistory: [],           // historial para providers no-claude-code
        claudeMode: 'ask',       // 'auto' | 'ask' | 'plan' — default: 'ask'
        consoleMode: false,      // modo consola: mensajes van directo a bash
      };
      this.chats.set(chatId, chat);
    }

    // Manejo del estado rate-limited
    if (chat.rateLimited) {
      if (Date.now() >= chat.rateLimitedUntil) {
        // Ventana expiró naturalmente → desbloquear
        chat.rateLimited = false;
        this.rateCounts.delete(chatId);
        // continúa hacia procesamiento normal
      } else if (this.rateLimitKeyword && text === this.rateLimitKeyword) {
        // Keyword correcto → resetear contador
        this.rateCounts.delete(chatId);
        chat.rateLimited = false;
        await this.sendText(chatId, '✅ Límite reseteado. Podés seguir hablando.');
        return;
      } else {
        // En modo rate-limited → ignorar silenciosamente (no llamar al agente)
        return;
      }
    }

    // Chequeo normal de rate limit
    if (!this._checkRateLimit(chatId)) {
      chat.rateLimited = true;
      const entry = this.rateCounts.get(chatId);
      chat.rateLimitedUntil = entry
        ? entry.windowStart + RATE_WINDOW_MS
        : Date.now() + RATE_WINDOW_MS;
      const kwHint = this.rateLimitKeyword
        ? ` Enviá \`${this.rateLimitKeyword}\` para continuar antes de que expire.`
        : '';
      await this.sendText(chatId,
        `⏳ Límite alcanzado (${this.rateLimit} msg/hora).${kwHint}`
      );
      return;
    }

    console.log(`[Telegram:${this.key}] Mensaje de ${chatId}: ${text.slice(0, 60)}`);
    chat.lastMessageAt = Date.now();
    chat.lastPreview = text.slice(0, 60);

    // Modo consola: mensajes de texto plano van directo a bash
    if (chat.consoleMode && !text.startsWith('/')) {
      return await this._handleConsoleInput(chatId, text, chat);
    }

    // Si hay acción pendiente y el mensaje no es un comando → manejar el flujo
    if (chat.pendingAction && !text.startsWith('/')) {
      return await this._handlePendingAction(msg, text, chat);
    }

    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);
      await this._handleCommand(msg, cmd, args, chat);
    } else {
      await this._sendToSession(chatId, text, chat);
    }
  }

  async _handleCommand(msg, cmd, args, chat) {
    const chatId = msg.chat.id;
    switch (cmd) {

      // ── Sesión ────────────────────────────────────────────────────────────
      case 'start': {
        const name = chat.firstName || 'usuario';
        if (!this._isClaudeBased()) await this.getOrCreateSession(chatId, chat);
        await this.sendText(chatId, `Hola ${name}! 👋 Soy @${this.botInfo?.username}.`);
        await this._sendMenu(chatId);
        break;
      }

      case 'nueva':
      case 'reset':
      case 'clear': {
        if (this._isClaudeBased()) {
          const model = chat.claudeSession?.model || null;
          chat.claudeSession = new ClaudePrintSession({ model, permissionMode: chat.claudeMode || 'ask' });
          await this.sendWithButtons(chatId,
            `✅ Nueva conversación *${this.defaultAgent}* iniciada (\`${chat.claudeSession.id.slice(0,8)}…\`)`,
            [[{ text: '🤖 Menú', callback_data: 'menu' }]]
          );
        } else {
          const s = await this.getOrCreateSession(chatId, chat, true);
          await this.sendWithButtons(chatId,
            `✅ Nueva sesión *${s.title}* creada (\`${s.id.slice(0,8)}…\`)`,
            [[{ text: '🤖 Menú', callback_data: 'menu' }]]
          );
        }
        break;
      }

      case 'compact': {
        if (!this._isClaudeBased() || !chat.claudeSession) {
          await this.sendText(chatId, '❌ Sin sesión Claude activa.');
          return;
        }
        // Envía /compact como mensaje — Claude Code lo procesa en modo -p
        await this._sendToSession(chatId, '/compact', chat);
        break;
      }

      case 'bash': {
        const s = await this.getOrCreateSession(chatId, chat, true, 'bash');
        await this.sendText(chatId, `✅ Sesión *bash* creada (\`${s.id.slice(0,8)}…\`)`);
        break;
      }

      // ── Modelo ────────────────────────────────────────────────────────────
      case 'modelo':
      case 'model': {
        if (!this._isClaudeBased()) {
          await this.sendText(chatId, '❌ Solo disponible en agentes Claude.');
          return;
        }
        if (args.length === 0) {
          const modelo = chat.claudeSession?.model || '(default)';
          await this.sendText(chatId,
            `🧠 *Modelo actual*: \`${modelo}\`\n\n` +
            `Modelos disponibles:\n` +
            `• \`claude-opus-4-6\` — más potente\n` +
            `• \`claude-sonnet-4-6\` — balanceado (default)\n` +
            `• \`claude-haiku-4-5-20251001\` — más rápido\n\n` +
            `Usá /modelo <nombre> para cambiar.\n_Nota: crea nueva sesión._`
          );
        } else {
          const nuevoModelo = args[0];
          chat.claudeSession = new ClaudePrintSession({ model: nuevoModelo, permissionMode: chat.claudeMode || 'ask' });
          await this.sendText(chatId, `✅ Modelo cambiado a \`${nuevoModelo}\`\nNueva sesión iniciada (\`${chat.claudeSession.id.slice(0,8)}…\`).`);
        }
        break;
      }

      // ── Costo ─────────────────────────────────────────────────────────────
      case 'costo':
      case 'cost': {
        if (!this._isClaudeBased() || !chat.claudeSession) {
          await this.sendText(chatId, '❌ Sin sesión Claude activa.');
          return;
        }
        const cs = chat.claudeSession;
        const total = cs.totalCostUsd.toFixed(4);
        const ultimo = cs.lastCostUsd.toFixed(4);
        await this.sendText(chatId,
          `💰 *Costo de sesión*\n\n` +
          `Último mensaje: $${ultimo} USD\n` +
          `Total sesión: $${total} USD\n` +
          `Mensajes: ${cs.messageCount}`
        );
        break;
      }

      // ── Estado ────────────────────────────────────────────────────────────
      case 'estado':
      case 'status':
      case 'sesion': {
        if (this._isClaudeBased()) {
          if (!chat.claudeSession) {
            await this.sendText(chatId, `❌ Sin sesión *${this.defaultAgent}* activa. Enviá un mensaje para iniciar una.`);
            return;
          }
          const cs = chat.claudeSession;
          const uptime = Math.round((Date.now() - cs.createdAt) / 1000);
          await this.sendText(chatId,
            `📊 *Estado de sesión*\n\n` +
            `ID: \`${cs.id.slice(0,8)}…\`\n` +
            `Agente: ${this.defaultAgent}\n` +
            `Agente activo: ${chat.activeAgent?.key || 'ninguno'}\n` +
            `Modelo: \`${cs.model || 'default'}\`\n` +
            `Modo permisos: \`${chat.claudeMode || 'ask'}\`\n` +
            `Mensajes: ${cs.messageCount}\n` +
            `Uptime: ${Math.floor(uptime/60)}m ${uptime%60}s\n` +
            `Costo total: $${cs.totalCostUsd.toFixed(4)} USD\n` +
            `Session ID Claude: \`${cs.claudeSessionId ? cs.claudeSessionId.slice(0,12) + '…' : 'pendiente'}\``
          );
          return;
        }
        if (!chat.sessionId) {
          await this.sendText(chatId, '❌ Sin sesión activa. Usá /start para crear una.');
          return;
        }
        const session = sessionManager.get(chat.sessionId);
        if (!session) {
          chat.sessionId = null;
          await this.sendText(chatId, '❌ La sesión expiró. Usá /start para crear una nueva.');
          return;
        }
        const uptime2 = Math.round((Date.now() - session.createdAt) / 1000);
        await this.sendText(chatId,
          `📊 *Sesión actual*\nID: \`${session.id.slice(0,8)}…\`\nAgente: ${session.title}\n` +
          `Activa: ${session.active ? 'Sí' : 'No'}\nUptime: ${Math.floor(uptime2/60)}m ${uptime2%60}s`
        );
        break;
      }

      // ── Memoria ───────────────────────────────────────────────────────────
      case 'memoria':
      case 'memory': {
        const memFiles = [
          path.join(process.env.HOME, '.claude', 'CLAUDE.md'),
          path.join(process.env.HOME, '.claude', 'projects', '-home-kheiron', 'memory', 'MEMORY.md'),
        ];
        let memText = '';
        for (const f of memFiles) {
          try {
            const content = fs.readFileSync(f, 'utf8').slice(0, 1500);
            memText += `*${path.basename(path.dirname(f))}/${path.basename(f)}*:\n\`\`\`\n${content}\n\`\`\`\n\n`;
          } catch { /* archivo no existe */ }
        }
        await this.sendText(chatId, memText || '📭 No hay archivos de memoria encontrados.');
        break;
      }

      // ── Directorio ────────────────────────────────────────────────────────
      case 'dir':
      case 'pwd':
      case 'cwd':
      case 'directorio': {
        const sessionCwd = this._isClaudeBased() && chat.claudeSession
          ? chat.claudeSession.cwd
          : null;
        const monitorCwd = chat.monitorCwd || process.env.HOME;
        let lines = `📁 *Directorio de trabajo*\n\n`;
        lines += `Sesión Claude: \`${sessionCwd || 'sin sesión activa'}\`\n`;
        lines += `Monitor: \`${monitorCwd}\``;
        await this.sendText(chatId, lines);
        break;
      }

      // ── Agentes con prompt (roles) ────────────────────────────────────────
      case 'agentes': {
        const roleAgents = agentsModule.list().filter(a => a.prompt);
        if (roleAgents.length === 0) {
          await this.sendText(chatId,
            `🎭 *Agentes de rol disponibles*\n\n` +
            `No hay agentes con prompt configurado.\n` +
            `Creá uno desde el panel web (botón 🎭) y usalo aquí.`
          );
        } else {
          const lines = roleAgents.map(a =>
            `• /${a.key} — ${a.description || a.key}` +
            (a.prompt ? `\n  _"${a.prompt.slice(0, 60)}${a.prompt.length > 60 ? '…' : ''}"_` : '')
          ).join('\n');
          const agentButtons = roleAgents.map(a => [{ text: `🎭 ${a.key}`, callback_data: `agent:${a.key}` }]);
          await this.sendWithButtons(chatId,
            `🎭 *Agentes de rol disponibles*\n\n${lines}\n\nActivá un agente tocando el botón:`,
            agentButtons
          );
        }
        break;
      }

      // ── Desactivar agente de rol ──────────────────────────────────────────
      case 'basta': {
        const prevKey = chat.activeAgent?.key;
        chat.activeAgent = null;
        chat.claudeSession = new ClaudePrintSession({ permissionMode: chat.claudeMode || 'ask' });
        await this.sendText(chatId, prevKey
          ? `✅ Agente *${prevKey}* desactivado. Claude normal restaurado.`
          : 'No había agente activo.');
        break;
      }

      // ── Agente ────────────────────────────────────────────────────────────
      case 'agente': {
        if (args.length === 0) {
          const available = agentsModule.list().map(a => `• ${a.key} — ${a.description || a.command || 'bash'}`).join('\n');
          await this.sendText(chatId,
            `⚙️ *Agente actual*: ${this.defaultAgent}\n\n*Disponibles:*\n${available}\n\n` +
            `Usá /agente <key> para cambiar.`
          );
        } else {
          const agentKey = args[0].toLowerCase();
          const agent = agentsModule.get(agentKey);
          if (!agent) {
            await this.sendText(chatId, `❌ Agente "${agentKey}" no encontrado. Usá /agente para ver la lista.`);
          } else {
            this.defaultAgent = agentKey;
            await this.sendText(chatId, `✅ Agente cambiado a *${agentKey}* (${agent.description || agent.command || 'bash'})`);
          }
        }
        break;
      }

      // ── Ayuda ─────────────────────────────────────────────────────────────
      case 'ayuda':
      case 'help':
        await this.sendText(chatId,
          `🤖 *Comandos disponibles*\n\n` +
          `*Sesión:*\n` +
          `/start — saludo e inicio\n` +
          `/nueva — nueva conversación\n` +
          `/reset — reiniciar sesión\n` +
          `/compact — compactar contexto\n` +
          `/bash — nueva sesión bash\n\n` +
          `*Claude Code:*\n` +
          `/modelo [nombre] — ver/cambiar modelo\n` +
          `/permisos [modo] — ver/cambiar modo (auto/ask/plan)\n` +
          `/costo — costo de la sesión\n` +
          `/estado — estado detallado\n` +
          `/memoria — ver archivos de memoria\n` +
          `/dir — directorio de trabajo (alias: /pwd)\n\n` +
          `*Agentes de rol:*\n` +
          `/agentes — listar agentes con prompt\n` +
          `/<key> — activar agente de rol\n` +
          `/basta — desactivar agente de rol\n\n` +
          `*Skills:*\n` +
          `/skills — ver skills instalados\n` +
          `/buscar-skill — buscar e instalar skills de ClawHub\n` +
          `/mcps — ver MCPs configurados\n` +
          `/buscar-mcp [query] — buscar e instalar MCPs de Smithery\n\n` +
          `*Monitor:*\n` +
          `/consola — modo consola bash (toggle)\n` +
          `/status-vps — CPU, RAM y disco\n\n` +
          `*Audio:*\n` +
          `🎙️ Enviá un audio de voz y se transcribe automáticamente\n\n` +
          `*Bot:*\n` +
          `/agente [key] — ver/cambiar agente\n` +
          `/ayuda — esta ayuda`
        );
        break;

      case 'buscar-skill': {
        chat.pendingAction = { type: 'skill-search' };
        await this.sendText(chatId,
          '🔍 *Buscar skill en ClawHub*\n\n' +
          '¿Para qué necesitás el skill? Describí tu necesidad en pocas palabras.\n' +
          '_Ejemplos: "crear PDFs", "buscar en Google", "enviar emails"_\n\n' +
          'Usá /cancelar para cancelar.'
        );
        break;
      }

      // ── MCPs ──────────────────────────────────────────────────────────────
      case 'mcps': {
        let mcpsModule;
        try { mcpsModule = require('./mcps'); } catch { await this.sendText(chatId, '❌ Módulo MCPs no disponible.'); break; }
        const mcpList = mcpsModule.list();
        if (!mcpList.length) {
          await this.sendText(chatId, '🔌 *MCPs configurados*\n\nNo hay MCPs configurados.\nUsá /buscar-mcp para buscar en el registry.');
          break;
        }
        const mcpLines = mcpList.map(m =>
          `• \`${m.name}\` — ${m.type === 'http' ? '🌐' : '📦'} ${m.description ? m.description.slice(0, 60) : m.command || m.url || ''} ${m.enabled ? '✅' : '⏸'}`
        ).join('\n');
        await this.sendText(chatId, `🔌 *MCPs configurados* (${mcpList.length})\n\n${mcpLines}`);
        break;
      }

      case 'buscar-mcp': {
        let mcpsModule;
        try { mcpsModule = require('./mcps'); } catch { await this.sendText(chatId, '❌ Módulo MCPs no disponible.'); break; }
        if (args.length > 0) {
          // Búsqueda directa con argumento: /buscar-mcp github
          const query = args.join(' ');
          await this.sendText(chatId, `🔍 Buscando MCPs para "${query}"...`);
          try {
            const results = await mcpsModule.searchSmithery(query);
            if (!results.length) {
              await this.sendText(chatId, `😕 No encontré MCPs para "${query}".\n\nProbá con otras palabras o visitá smithery.ai`);
              break;
            }
            const lines = results.map((r, i) =>
              `${i + 1}. \`${r.qualifiedName}\` — *${r.displayName}*\n   _${r.description.slice(0, 80)}_\n   ${r.remote ? '🌐 HTTP' : '📦 local'}`
            ).join('\n\n');
            await this.sendText(chatId,
              `🔍 *Encontré ${results.length} MCP(s) para "${query}":*\n\n${lines}\n\n` +
              `Respondé con el *número* para instalar, o /cancelar.`
            );
            chat.pendingAction = { type: 'mcp-select', results };
          } catch (err) {
            await this.sendText(chatId, `⚠️ Error buscando en Smithery: ${err.message}`);
          }
        } else {
          chat.pendingAction = { type: 'mcp-search' };
          await this.sendText(chatId,
            '🔌 *Buscar MCP en Smithery Registry*\n\n' +
            '¿Qué tipo de MCP necesitás? Describí la integración en pocas palabras.\n' +
            '_Ejemplos: "github", "base de datos postgres", "búsqueda web", "memoria"_\n\n' +
            'Usá /cancelar para cancelar.'
          );
        }
        break;
      }

      case 'consola': {
        if (chat.consoleMode) {
          chat.consoleMode = false;
          await this.sendWithButtons(chatId, '🖥️ Modo consola *desactivado*.',
            [[{ text: '🖥️ Monitor', callback_data: 'menu:monitor' },
              { text: '🤖 Menú',    callback_data: 'menu' }]]);
        } else {
          chat.consoleMode = true;
          await this._sendConsolePrompt(chatId,
            `🖥️ *Modo consola activado*\n\nEscribí comandos directamente.\n\`exit\` o /consola para salir.`,
            chat);
        }
        break;
      }

      case 'cancelar': {
        if (chat.pendingAction) {
          chat.pendingAction = null;
          await this.sendText(chatId, '✅ Búsqueda cancelada.');
        } else {
          await this.sendText(chatId, 'No había ninguna acción pendiente.');
        }
        break;
      }

      case 'skills': {
        const list = skillsModule.listSkills();
        if (!list.length) {
          await this.sendText(chatId, '🔧 *Skills instalados*\n\nNo hay skills instalados.\nInstalá uno desde el panel web o la API.');
          return;
        }
        const lines = list.map(s => `• \`${s.slug}\` — ${s.name}${s.description ? `\n  _${s.description.slice(0, 80)}_` : ''}`).join('\n');
        await this.sendText(chatId, `🔧 *Skills instalados* (${list.length})\n\n${lines}`);
        break;
      }

      // ── Monitor ───────────────────────────────────────────────────────────
      case 'monitor': {
        const cwd = chat.monitorCwd || process.env.HOME;
        await this.sendText(chatId,
          `🖥️ *Monitor VPS*\n\n` +
          `Directorio: \`${cwd}\`\n\n` +
          `*Navegación:*\n` +
          `/ls — listar directorio actual\n` +
          `/dir — ver ruta actual (alias: /pwd)\n` +
          `/cat archivo — ver contenido\n` +
          `/mkdir nombre — crear carpeta\n\n` +
          `*Sistema:*\n` +
          `/status-vps — CPU, RAM y disco`
        );
        break;
      }

      case 'ls': {
        let dir = chat.monitorCwd || process.env.HOME;
        if (args.length > 0) dir = path.resolve(dir, args.join(' '));
        try {
          const stat = fs.statSync(dir);
          if (!stat.isDirectory()) {
            let content;
            try { content = fs.readFileSync(dir, 'utf8'); }
            catch { await this.sendText(chatId, `⚠️ Archivo binario o sin permisos: ${path.basename(dir)}`); break; }
            const note = content.length > 3500 ? `\n[...truncado, ${content.length} chars total]` : '';
            await this.sendText(chatId, `📄 ${path.basename(dir)}\n\n${content.slice(0, 3500)}${note}`);
          } else {
            chat.monitorCwd = dir;
            await this.sendText(chatId, buildLsText(dir));
          }
        } catch (err) {
          await this.sendText(chatId, `❌ Error: ${err.message}`);
        }
        break;
      }

      case 'cat': {
        const filename = args.join(' ');
        if (!filename) { await this.sendText(chatId, '❌ Usá /cat <nombre-archivo>'); break; }
        const base     = chat.monitorCwd || process.env.HOME;
        const filePath = path.resolve(base, filename);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            chat.monitorCwd = filePath;
            await this.sendText(chatId, buildLsText(filePath));
          } else {
            let content;
            try { content = fs.readFileSync(filePath, 'utf8'); }
            catch { await this.sendText(chatId, `⚠️ Archivo binario o sin permisos: ${filename}`); break; }
            const note = content.length > 3500 ? `\n[...truncado, ${content.length} chars total]` : '';
            await this.sendText(chatId, `📄 ${filename}\n\n${content.slice(0, 3500)}${note}`);
          }
        } catch (err) {
          await this.sendText(chatId, `❌ Error: ${err.message}`);
        }
        break;
      }

      case 'mkdir': {
        const dirname = args.join(' ');
        if (!dirname) { await this.sendText(chatId, '❌ Usá /mkdir <nombre>'); break; }
        const base    = chat.monitorCwd || process.env.HOME;
        const newPath = path.resolve(base, dirname);
        try {
          fs.mkdirSync(newPath, { recursive: true });
          await this.sendText(chatId, `✅ Carpeta creada: \`${newPath}\``);
        } catch (err) {
          await this.sendText(chatId, `❌ Error: ${err.message}`);
        }
        break;
      }

      case 'status-vps': {
        try {
          const s = getSystemStats();
          await this.sendWithButtons(chatId,
            `📊 *Estado del VPS*\n\n` +
            `🖥️ CPU: ${s.cpu}\n` +
            `🧠 RAM: ${s.ram}\n` +
            `💾 Disco: ${s.disk}\n` +
            `⏱️ Uptime: ${s.uptime}`,
            [[{ text: '🔄 Actualizar', callback_data: 'status_vps' }]]
          );
        } catch (err) {
          await this.sendText(chatId, `❌ Error: ${err.message}`);
        }
        break;
      }

      // ── Modo / Provider ───────────────────────────────────────────────────
      case 'modo':
      case 'mode':
      case 'provider': {
        if (!providersModule) {
          await this.sendText(chatId, '❌ Módulo de providers no disponible.');
          break;
        }
        if (args.length === 0) {
          const current = chat.provider || 'claude-code';
          const list = providersModule.list();
          const buttons = list.map(p => [{
            text: `${current === p.name ? '✅ ' : ''}${p.label}`,
            callback_data: `provider:${p.name}`,
          }]);
          await this.sendWithButtons(chatId,
            `🤖 *Provider actual*: \`${current}\`\n\nElegí un provider:`,
            buttons
          );
        } else {
          const newProvider = args[0].toLowerCase();
          const available = providersModule.list().map(p => p.name);
          if (!available.includes(newProvider)) {
            await this.sendText(chatId,
              `❌ Provider desconocido: \`${newProvider}\`\n\nDisponibles: ${available.join(', ')}`
            );
            break;
          }
          chat.provider = newProvider;
          if (newProvider === 'claude-code') {
            chat.claudeSession = null;
          } else {
            chat.aiHistory = [];
          }
          const label = providersModule.get(newProvider).label;
          await this.sendText(chatId, `✅ Provider cambiado a *${label}*`);
        }
        break;
      }

      // ── Permisos Claude ───────────────────────────────────────────────────
      case 'permisos':
      case 'modo-permisos': {
        if (!this._isClaudeBased(chat.provider)) {
          await this.sendText(chatId, '❌ Solo disponible con Claude Code.');
          break;
        }
        if (args.length === 0) {
          const current = chat.claudeMode || 'ask';
          await this.sendWithButtons(chatId,
            `🔐 *Modo de permisos actual*: \`${current}\`\n\n` +
            `• \`ask\` — describe herramientas sin ejecutarlas (por defecto)\n` +
            `• \`auto\` — ejecuta todo sin pedir (rápido, puede ser peligroso)\n` +
            `• \`plan\` — solo planifica, no ejecuta nada`,
            [[
              { text: current === 'ask'  ? '✅ ask'  : 'ask',   callback_data: 'claudemode:ask'  },
              { text: current === 'auto' ? '✅ auto' : 'auto',  callback_data: 'claudemode:auto' },
              { text: current === 'plan' ? '✅ plan' : 'plan',  callback_data: 'claudemode:plan' },
            ]]
          );
        } else {
          const newMode = args[0].toLowerCase();
          if (!['auto', 'ask', 'plan'].includes(newMode)) {
            await this.sendText(chatId, '❌ Modo inválido. Opciones: `ask`, `auto`, `plan`');
            break;
          }
          chat.claudeMode = newMode;
          // Actualizar sesión existente SIN nullificarla → preserva contexto/--continue
          if (chat.claudeSession) chat.claudeSession.permissionMode = newMode;
          const labels = { auto: '⚡ auto-accept', ask: '❓ ask', plan: '📋 plan' };
          await this.sendText(chatId,
            `✅ Modo cambiado a *${labels[newMode]}*\n` +
            `_El contexto de conversación se mantiene._`
          );
        }
        break;
      }

      default: {
        // Detectar /{key} de agente con prompt de rol
        const agentDef = agentsModule.get(cmd);
        if (agentDef?.prompt) {
          chat.claudeSession = new ClaudePrintSession({ permissionMode: chat.claudeMode || 'ask' });
          chat.activeAgent = { key: agentDef.key, prompt: agentDef.prompt };
          // Primer mensaje establece el rol en la sesión, incluyendo todos los skills
          const fullPrompt = skillsModule.buildAgentPrompt(agentDef);
          await this._sendToSession(chatId, fullPrompt, chat);
          return;
        }
        await this.sendText(chatId, `❓ Comando desconocido: /${cmd}\nUsá /ayuda o /agentes.`);
        break;
      }
    }
  }

  async _handlePendingAction(msg, text, chat) {
    const chatId = msg.chat.id;
    const action = chat.pendingAction;

    // Paso 1: usuario describió su necesidad → buscar en ClawHub
    if (action.type === 'skill-search') {
      chat.pendingAction = null;
      await this.sendText(chatId, '🔍 Buscando en ClawHub...');
      try {
        const results = await skillsModule.searchClawHub(text);
        if (!results.length) {
          await this.sendText(chatId,
            `😕 No encontré skills para "${text}".\n\nProbá con otras palabras o visitá clawhub.ai`
          );
          return;
        }
        const lines = results.map((r, i) =>
          `${i + 1}. \`${r.slug}\` — *${r.name}*\n   _${r.description.slice(0, 90)}_`
        ).join('\n\n');
        await this.sendText(chatId,
          `🔍 *Encontré ${results.length} skill(s) para "${text}":*\n\n${lines}\n\n` +
          `Respondé con el *número* para instalar, o /cancelar.`
        );
        chat.pendingAction = { type: 'skill-select', results };
      } catch (err) {
        await this.sendText(chatId, `⚠️ Error buscando en ClawHub: ${err.message}`);
      }
      return;
    }

    // Paso 2: usuario eligió un número → instalar
    if (action.type === 'skill-select') {
      const n = parseInt(text.trim(), 10);
      const results = action.results || [];
      if (isNaN(n) || n < 1 || n > results.length) {
        await this.sendText(chatId,
          `❌ Número inválido. Respondé entre 1 y ${results.length}, o usá /cancelar.`
        );
        return; // mantener pendingAction para que el usuario pueda reintentar
      }
      const chosen = results[n - 1];
      chat.pendingAction = null;
      await this.sendText(chatId, `📦 Instalando \`${chosen.slug}\`...`);
      try {
        const dir = path.join(skillsModule.SKILLS_DIR, chosen.slug);
        const resp = await fetch(
          `https://clawhub.ai/api/v1/skills/${chosen.slug}/file?path=SKILL.md`
        );
        if (!resp.ok) throw new Error(`ClawHub respondió ${resp.status}`);
        const content = await resp.text();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
        await this.sendText(chatId,
          `✅ Skill *${chosen.name}* instalado correctamente.\n` +
          `Slug: \`${chosen.slug}\`\n\n` +
          `Se inyectará en todos los agentes. Usá /skills para ver los instalados.`
        );
      } catch (err) {
        await this.sendText(chatId, `⚠️ Error instalando \`${chosen.slug}\`: ${err.message}`);
      }
      return;
    }

    // ── MCP: paso 1 → buscar en smithery
    if (action.type === 'mcp-search') {
      chat.pendingAction = null;
      await this.sendText(chatId, `🔍 Buscando MCPs para "${text}"...`);
      let mcpsModule;
      try { mcpsModule = require('./mcps'); } catch {
        await this.sendText(chatId, '❌ Módulo MCPs no disponible.'); return;
      }
      try {
        const results = await mcpsModule.searchSmithery(text);
        if (!results.length) {
          await this.sendText(chatId,
            `😕 No encontré MCPs para "${text}".\n\nProbá con otras palabras o visitá smithery.ai`
          );
          return;
        }
        const lines = results.map((r, i) =>
          `${i + 1}. \`${r.qualifiedName}\` — *${r.displayName}*\n   _${r.description.slice(0, 90)}_\n   ${r.remote ? '🌐 HTTP/remoto' : '📦 local (stdio)'}`
        ).join('\n\n');
        await this.sendText(chatId,
          `🔌 *Encontré ${results.length} MCP(s) para "${text}":*\n\n${lines}\n\n` +
          `Respondé con el *número* para instalar, o /cancelar.`
        );
        chat.pendingAction = { type: 'mcp-select', results };
      } catch (err) {
        await this.sendText(chatId, `⚠️ Error buscando en Smithery: ${err.message}`);
      }
      return;
    }

    // ── MCP: paso 2 → instalar el elegido
    if (action.type === 'mcp-select') {
      const n = parseInt(text.trim(), 10);
      const results = action.results || [];
      if (isNaN(n) || n < 1 || n > results.length) {
        await this.sendText(chatId,
          `❌ Número inválido. Respondé entre 1 y ${results.length}, o usá /cancelar.`
        );
        return; // mantener pendingAction para reintentar
      }
      const chosen = results[n - 1];
      chat.pendingAction = null;
      await this.sendText(chatId, `🔌 Instalando *${chosen.displayName}* (\`${chosen.qualifiedName}\`)...`);
      let mcpsModule;
      try { mcpsModule = require('./mcps'); } catch {
        await this.sendText(chatId, '❌ Módulo MCPs no disponible.'); return;
      }
      try {
        const { mcp, envVarsRequired } = await mcpsModule.installFromRegistry(chosen.qualifiedName);
        let msg = `✅ *${chosen.displayName}* instalado y activado.\n` +
          `Nombre: \`${mcp.name}\`\n` +
          `Tipo: \`${mcp.type}\`\n`;
        if (mcp.url) msg += `URL: \`${mcp.url.slice(0, 60)}\`\n`;
        if (envVarsRequired.length) {
          msg += `\n⚠️ *Variables de entorno necesarias:*\n` +
            envVarsRequired.map(v => `• \`${v}\``).join('\n') +
            `\n\nConfiguralas en el MCP desde el panel web.`;
        }
        msg += `\n\nUsá /mcps para ver los MCPs instalados.`;
        await this.sendText(chatId, msg);
      } catch (err) {
        await this.sendText(chatId, `⚠️ Error instalando \`${chosen.qualifiedName}\`: ${err.message}`);
      }
      return;
    }
  }

  async _sendToSession(chatId, text, chat) {
    if (chat.busy) {
      try { await this._apiCall('sendMessage', { chat_id: chatId, text: '⏳ Procesando tu mensaje anterior, aguardá un momento...' }); } catch {}
      return;
    }
    chat.busy = true;
    try {
      // Providers API (Anthropic/Gemini/OpenAI con agentic loop)
      const chatProvider = chat.provider || chat.activeAgent?.provider || 'claude-code';
      if (chatProvider !== 'claude-code' && providersModule) {
        await this._sendToApiProvider(chatId, text, chat, chatProvider);
        return;
      }

      // Agentes claude-based → ClaudePrintSession (modo no-interactivo con streaming)
      if (this._isClaudeBased()) {
        if (!chat.claudeSession) {
          chat.claudeSession = new ClaudePrintSession({
            permissionMode: chat.claudeMode || 'ask',
          });
        }

        // Resolver agente activo para memoria
        const agentKey = chat.activeAgent?.key || this.defaultAgent;
        const agentDef = agentsModule.get(agentKey);
        const memoryFiles = agentDef?.memoryFiles || [];

        // En el primer mensaje de la sesión: inyectar contexto de memoria + instrucciones
        let messageText = text;
        if (chat.claudeSession.messageCount === 0 && memoryFiles.length > 0) {
          const memCtx = memoryModule.buildMemoryContext(agentKey, memoryFiles);
          const parts = [memCtx, memoryModule.TOOL_INSTRUCTIONS].filter(Boolean);
          if (parts.length > 0) {
            messageText = `${parts.join('\n\n')}\n\n---\n\n${text}`;
          }
        }

        // Enviar placeholder inmediato → obtener message_id para editar progresivamente
        const mode = chat.claudeMode || 'ask';
        let dotCount = 1;
        let sentMsg = null;
        try {
          sentMsg = await this._apiCall('sendMessage', { chat_id: chatId, text: `${mode}.` });
        } catch { /* continuar sin edición progresiva si falla */ }

        let animStopped = false;
        let dotDir = 1;
        const animInterval = setInterval(async () => {
          if (animStopped || !sentMsg) return;
          dotCount += dotDir;
          if (dotCount >= 3) { dotCount = 3; dotDir = -1; }
          else if (dotCount <= 1) { dotCount = 1; dotDir = 1; }
          try {
            await this._apiCall('editMessageText', {
              chat_id: chatId,
              message_id: sentMsg.message_id,
              text: `${mode}${'.'.repeat(dotCount)}`,
            });
          } catch {}
        }, 1000);

        let lastEditAt = 0;
        const THROTTLE_MS = 1500; // Telegram permite ~1 edit/s por chat

        const onChunk = async (partial) => {
          if (!partial.trim() || !sentMsg) return;
          if (!animStopped) { animStopped = true; clearInterval(animInterval); }
          const now = Date.now();
          if (now - lastEditAt < THROTTLE_MS) return;
          lastEditAt = now;
          console.error('[onChunk] edit at', new Date().toISOString(), '| chars:', partial.length);
          try {
            // En chunks parciales no extraemos ops para no cortar etiquetas a mitad
            const preview = cleanPtyOutput(partial).slice(0, 4000) || partial.slice(0, 4000);
            await this._apiCall('editMessageText', {
              chat_id: chatId,
              message_id: sentMsg.message_id,
              text: preview,
            });
          } catch (e) { console.error('[onChunk] edit failed:', e.message); }
        };

        try {
          const rawResponse = await chat.claudeSession.sendMessage(messageText, onChunk);
          animStopped = true; clearInterval(animInterval);

          // Extraer y aplicar operaciones de memoria
          let response = rawResponse;
          if (memoryFiles.length > 0 && rawResponse) {
            const { clean, ops } = memoryModule.extractMemoryOps(rawResponse);
            if (ops.length > 0) {
              const saved = memoryModule.applyOps(agentKey, ops);
              response = clean || rawResponse;
              console.log(`[Memory:Telegram] ${agentKey} → guardado en: ${saved.join(', ')}`);
            }
          }

          const finalText = cleanPtyOutput(response || '');

          // Enviar respuesta final: partir en bloques de 4096 si es necesario
          if (finalText) {
            const chunks = [];
            for (let i = 0; i < finalText.length; i += 4096) {
              chunks.push(finalText.slice(i, i + 4096));
            }

            if (sentMsg) {
              // Primer bloque: editar el placeholder
              try {
                await this._apiCall('editMessageText', {
                  chat_id: chatId,
                  message_id: sentMsg.message_id,
                  text: chunks[0],
                });
              } catch {
                await this.sendText(chatId, chunks[0]);
              }
              // Bloques restantes: mensajes nuevos
              for (let i = 1; i < chunks.length; i++) {
                await this.sendText(chatId, chunks[i]);
              }
            } else {
              for (const chunk of chunks) {
                await this.sendText(chatId, chunk);
              }
            }
          }
        } catch (err) {
          animStopped = true; clearInterval(animInterval);
          console.error(`[Telegram:${this.key}] Error en sesión para chat ${chatId}:`, err.message);
          const errMsg = `⚠️ Error: ${err.message}`;
          try {
            if (sentMsg) {
              await this._apiCall('editMessageText', {
                chat_id: chatId, message_id: sentMsg.message_id, text: errMsg,
              });
            } else {
              await this.sendText(chatId, errMsg);
            }
          } catch {}
        }
        return;
      }

      // Otros agentes (bash, python, etc.) → PTY con cleanPtyOutput
      const session = await this.getOrCreateSession(chatId, chat);
      const fromName = chat.firstName || chat.username || `chat${chatId}`;
      // Notificar a todos los frontends web (abre pestaña automáticamente)
      events.emit('telegram:session', { sessionId: session.id, from: fromName, text });
      // Header visual en la terminal (solo display, no va al PTY)
      session.injectOutput(`\r\n\x1b[34m┌─ 📨 Telegram: ${fromName}\x1b[0m\r\n`);
      try { await this._apiCall('sendChatAction', { chat_id: chatId, action: 'typing' }); } catch {}
      const result = await session.sendMessage(text, { timeout: 1080000, stableMs: 3000 });
      const response = cleanPtyOutput(result.raw || '');
      if (response) await this.sendText(chatId, response);
    } catch (err) {
      console.error(`[Telegram:${this.key}] Error en sesión para chat ${chatId}:`, err.message);
      try { await this.sendText(chatId, `⚠️ Error: ${err.message}`); } catch {}
    } finally {
      chat.busy = false;
    }
  }

  async _sendToApiProvider(chatId, text, chat, providerName) {
    const provider = providersModule.get(providerName);
    const apiKey   = providerConfig ? providerConfig.getApiKey(providerName) : '';
    const cfg      = providerConfig ? providerConfig.getConfig() : {};
    const model    = cfg.providers?.[providerName]?.model || provider.defaultModel;

    // Resolver agente activo para memoria
    const agentKey    = chat.activeAgent?.key || this.defaultAgent;
    const agentDef    = agentsModule.get(agentKey);
    const memoryFiles = agentDef?.memoryFiles || [];

    // Construir system prompt
    const basePrompt  = 'Sos un asistente útil. Respondé de forma concisa y clara.';
    const memoryCtx   = memoryModule.buildMemoryContext(agentKey, memoryFiles);
    const toolInstr   = memoryFiles.length > 0 ? memoryModule.TOOL_INSTRUCTIONS : '';
    const systemPrompt = [basePrompt, memoryCtx, toolInstr].filter(Boolean).join('\n\n');

    // Agregar mensaje del usuario al historial
    if (!chat.aiHistory) chat.aiHistory = [];
    chat.aiHistory.push({ role: 'user', content: text });

    // Enviar placeholder animado
    let dotCount = 1;
    let sentMsg = null;
    try { sentMsg = await this._apiCall('sendMessage', { chat_id: chatId, text: '.' }); } catch {}

    let animStopped = false;
    let dotDir = 1;
    const animInterval = setInterval(async () => {
      if (animStopped || !sentMsg) return;
      dotCount += dotDir;
      if (dotCount >= 3) { dotCount = 3; dotDir = -1; }
      else if (dotCount <= 1) { dotCount = 1; dotDir = 1; }
      try {
        await this._apiCall('editMessageText', {
          chat_id: chatId,
          message_id: sentMsg.message_id,
          text: '.'.repeat(dotCount),
        });
      } catch {}
    }, 1000);

    let lastEditAt = 0;
    const THROTTLE_MS = 1500;
    let accumulated = '';

    try {
      const gen = provider.chat({ systemPrompt, history: chat.aiHistory, apiKey, model });

      for await (const event of gen) {
        if (event.type === 'text') {
          accumulated += event.text;
          if (!animStopped) { animStopped = true; clearInterval(animInterval); }
          const now = Date.now();
          if (sentMsg && now - lastEditAt >= THROTTLE_MS) {
            lastEditAt = now;
            try {
              await this._apiCall('editMessageText', {
                chat_id: chatId,
                message_id: sentMsg.message_id,
                text: accumulated.slice(0, 4000) || '...',
              });
            } catch {}
          }
        } else if (event.type === 'tool_call') {
          const preview = `🔧 ${event.name}(${JSON.stringify(event.args).slice(0, 100)})`;
          if (sentMsg) {
            try {
              await this._apiCall('editMessageText', {
                chat_id: chatId, message_id: sentMsg.message_id, text: preview,
              });
            } catch {}
          }
        } else if (event.type === 'done') {
          accumulated = event.fullText || accumulated;
        }
      }

      // Extraer y aplicar operaciones de memoria
      let finalText = accumulated;
      if (memoryFiles.length > 0 && finalText) {
        const { clean, ops } = memoryModule.extractMemoryOps(finalText);
        if (ops.length > 0) {
          const saved = memoryModule.applyOps(agentKey, ops);
          finalText = clean || finalText;
          console.log(`[Memory:Telegram:${providerName}] ${agentKey} → guardado en: ${saved.join(', ')}`);
        }
      }

      chat.aiHistory.push({ role: 'assistant', content: finalText });

      // Edición final
      if (sentMsg && finalText) {
        try {
          await this._apiCall('editMessageText', {
            chat_id: chatId,
            message_id: sentMsg.message_id,
            text: finalText.slice(0, 4096),
          });
        } catch {
          await this.sendText(chatId, finalText);
        }
      } else if (!sentMsg && finalText) {
        await this.sendText(chatId, finalText);
      }
    } catch (err) {
      animStopped = true; clearInterval(animInterval);
      console.error(`[Telegram:${this.key}:${providerName}] Error:`, err.message);
      const errMsg = `⚠️ Error ${provider.label}: ${err.message}`;
      try {
        if (sentMsg) {
          await this._apiCall('editMessageText', {
            chat_id: chatId, message_id: sentMsg.message_id, text: errMsg,
          });
        } else {
          await this.sendText(chatId, errMsg);
        }
      } catch {}
    } finally {
      chat.busy = false;
    }
  }

  async getOrCreateSession(chatId, chat, forceNew = false, agentKeyOverride = null) {
    if (!forceNew && chat.sessionId) {
      const existing = sessionManager.get(chat.sessionId);
      if (existing && existing.active) return existing;
    }

    const agentKey = agentKeyOverride || this.defaultAgent;
    const agent = agentsModule.get(agentKey);
    const command = agent ? agent.command : agentKey === 'bash' ? null : agentKey;

    const session = sessionManager.create({
      type: 'pty',
      command,
      cols: 80,
      rows: 24,
    });
    chat.sessionId = session.id;
    return session;
  }

  async sendWithButtons(chatId, text, buttons, editMsgId = null) {
    const body = { chat_id: chatId, text: text.slice(0, 4096), parse_mode: 'Markdown',
                   reply_markup: { inline_keyboard: buttons } };
    if (editMsgId) {
      try { return await this._apiCall('editMessageText', { ...body, message_id: editMsgId }); }
      catch (e) { if (!e.message?.includes('not modified')) throw e; }
      return;
    }
    try { return await this._apiCall('sendMessage', body); }
    catch { body.parse_mode = undefined; return this._apiCall('sendMessage', body); }
  }

  // ── Modo consola ───────────────────────────────────────────────────────────

  _runShellCommand(command, cwd, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', command], {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        resolve({ stdout, stderr: stderr + '\n[timeout]', code: 124 });
      }, timeoutMs);
      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
      child.on('error', err => { clearTimeout(timer); reject(err); });
    });
  }

  async _sendConsolePrompt(chatId, output, chat) {
    const cwd = chat.monitorCwd || process.env.HOME;
    const cwdShort = cwd.replace(process.env.HOME, '~');
    const text = `${output ? output + '\n\n' : ''}📁 \`${cwdShort}\``;
    const buttons = [
      [{ text: '📋 ls',     callback_data: 'console:ls'          },
       { text: '📋 ls -la', callback_data: 'console:ls -la'      },
       { text: '⬆️ cd ..',   callback_data: 'console:cd ..'       }],
      [{ text: '📊 df -h',  callback_data: 'console:df -h'       },
       { text: '⚙️ ps',     callback_data: 'console:ps aux|head -20' },
       { text: '🚪 Salir',  callback_data: 'console:exit'        }],
    ];
    await this.sendWithButtons(chatId, text.slice(0, 4090), buttons);
  }

  async _handleConsoleInput(chatId, command, chat) {
    const trimmed = command.trim();
    if (!trimmed) return;

    // Salir del modo consola
    if (trimmed === 'exit' || trimmed === 'salir' || trimmed === 'quit') {
      chat.consoleMode = false;
      await this.sendWithButtons(chatId, '🖥️ Modo consola *desactivado*.',
        [[{ text: '🖥️ Monitor', callback_data: 'menu:monitor' },
          { text: '🤖 Menú',    callback_data: 'menu' }]]);
      return;
    }

    // cd especial (no se puede con exec)
    if (/^cd(\s|$)/.test(trimmed)) {
      const target = trimmed.slice(2).trim() || process.env.HOME;
      const resolved = target === '~' ? process.env.HOME
        : target.startsWith('/') ? target
        : path.resolve(chat.monitorCwd || process.env.HOME, target);
      try {
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) throw new Error('no es un directorio');
        chat.monitorCwd = resolved;
        await this._sendConsolePrompt(chatId, '', chat);
      } catch (err) {
        await this._sendConsolePrompt(chatId, `❌ cd: ${err.message}`, chat);
      }
      return;
    }

    const cwd = chat.monitorCwd || process.env.HOME;
    try {
      const { stdout, stderr, code } = await this._runShellCommand(trimmed, cwd);
      const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n').trim();
      const cleaned = stripAnsi(combined) || '(sin salida)';
      const prefix = code !== 0 ? `⚠️ [exit ${code}]\n` : '';
      let out = `\`$ ${trimmed}\`\n${prefix}${cleaned}`;
      if (out.length > 3800) out = out.slice(0, 3800) + `\n…[+${combined.length - 3800} chars]`;
      await this._sendConsolePrompt(chatId, out, chat);
    } catch (err) {
      await this._sendConsolePrompt(chatId, `❌ Error: ${err.message}`, chat);
    }
  }

  _resolveButtons(rawRows, back = null) {
    const rows = (rawRows || []).map(row =>
      row.map(btn => ({ text: btn.text, callback_data: btn.id }))
    );
    if (back) rows.push([{ text: '← Atrás', callback_data: back }]);
    return rows;
  }

  _getMenuDef(id) {
    const defs = {

      // ── Raíz ──────────────────────────────────────────────────────────────
      'menu': {
        text: '🤖 *Menú principal*\n\nElegí una sección:',
        buttons: () => [
          [{ text: '💬 Sesión',   id: 'menu:sesion'  },
           { text: '🔌 MCPs',     id: 'menu:mcps'    }],
          [{ text: '🔧 Skills',   id: 'menu:skills'  },
           { text: '🎭 Agentes',  id: 'menu:agentes' }],
          [{ text: '🖥️ Monitor',  id: 'menu:monitor' },
           { text: '⚙️ Config',   id: 'menu:config'  }],
        ],
      },

      // ── Sesión ────────────────────────────────────────────────────────────
      'menu:sesion': {
        text: (chat) => {
          const cs = chat?.claudeSession;
          return `💬 *Sesión*\nAgente: \`${this.defaultAgent}\` | Modo: \`${chat?.claudeMode||'ask'}\`` +
            (cs ? `\nMensajes: ${cs.messageCount} | Costo: $${cs.totalCostUsd.toFixed(4)}` : '');
        },
        buttons: () => [
          [{ text: '💬 Nueva conv.',  id: 'nueva'               },
           { text: '📊 Estado',       id: 'menu:sesion:estado'  }],
          [{ text: '💰 Costo',        id: 'menu:sesion:costo'   },
           { text: '🔁 Compact',      id: 'compact_action'      }],
          [{ text: '← Menú',          id: 'menu'                }],
        ],
      },
      'menu:sesion:estado': {
        action: async ({ chatId, msgId, chat, bot }) => {
          const cs = chat.claudeSession;
          const uptime = cs ? Math.round((Date.now() - cs.createdAt) / 1000) : 0;
          const text = cs
            ? `📊 *Estado de sesión*\n\nID: \`${cs.id.slice(0,8)}…\`\n` +
              `Agente: ${bot.defaultAgent}\nModelo: \`${cs.model||'default'}\`\n` +
              `Modo permisos: \`${chat.claudeMode||'ask'}\`\nMensajes: ${cs.messageCount}\n` +
              `Uptime: ${Math.floor(uptime/60)}m ${uptime%60}s\n` +
              `Costo: $${cs.totalCostUsd.toFixed(4)} USD`
            : '📊 Sin sesión activa.';
          await bot.sendWithButtons(chatId, text,
            [[{ text: '← Sesión', callback_data: 'menu:sesion' }]], msgId);
        },
      },
      'menu:sesion:costo': {
        action: async ({ chatId, msgId, chat, bot }) => {
          const cs = chat.claudeSession;
          const text = cs
            ? `💰 *Costo de sesión*\n\nÚltimo: $${cs.lastCostUsd.toFixed(4)} USD\n` +
              `Total: $${cs.totalCostUsd.toFixed(4)} USD\nMensajes: ${cs.messageCount}`
            : '💰 Sin sesión activa.';
          await bot.sendWithButtons(chatId, text,
            [[{ text: '← Sesión', callback_data: 'menu:sesion' }]], msgId);
        },
      },

      // ── MCPs ──────────────────────────────────────────────────────────────
      'menu:mcps': {
        text: () => {
          let count = 0;
          try { count = require('./mcps').list().length; } catch {}
          return `🔌 *MCPs* — ${count} configurado${count !== 1 ? 's' : ''}`;
        },
        buttons: () => [
          [{ text: '📋 Listar',  id: 'menu:mcps:list'   },
           { text: '🔍 Buscar',  id: 'menu:mcps:buscar' }],
          [{ text: '← Menú',     id: 'menu'             }],
        ],
      },
      'menu:mcps:list': {
        action: async ({ chatId, msgId, bot }) => {
          let list = [];
          try { list = require('./mcps').list(); } catch {}
          const text = list.length
            ? `🔌 *MCPs (${list.length})*\n\n` + list.map(m =>
                `${m.enabled ? '✅' : '⏸'} \`${m.name}\` ${m.type==='http'?'🌐':'📦'}\n` +
                `  _${(m.description||m.url||m.command||'').slice(0,50)}_`
              ).join('\n')
            : '🔌 No hay MCPs configurados.';
          await bot.sendWithButtons(chatId, text,
            [[{ text: '🔍 Buscar', callback_data: 'menu:mcps:buscar' },
              { text: '← MCPs',   callback_data: 'menu:mcps' }]], msgId);
        },
      },
      'menu:mcps:buscar': {
        action: async ({ chatId, chat, bot }) => {
          chat.pendingAction = { type: 'mcp-search' };
          await bot.sendText(chatId,
            '🔌 *Buscar MCP en Smithery*\n\n¿Qué tipo de MCP necesitás?\n' +
            '_Ejemplos: "github", "postgres", "búsqueda web"_\n\nUsá /cancelar para cancelar.'
          );
        },
      },

      // ── Skills ────────────────────────────────────────────────────────────
      'menu:skills': {
        text: () => {
          const count = require('./skills').listSkills().length;
          return `🔧 *Skills* — ${count} instalado${count !== 1 ? 's' : ''}`;
        },
        buttons: () => [
          [{ text: '📋 Listar',  id: 'menu:skills:list'   },
           { text: '🔍 Buscar',  id: 'menu:skills:buscar' }],
          [{ text: '← Menú',     id: 'menu'               }],
        ],
      },
      'menu:skills:list': {
        action: async ({ chatId, msgId, bot }) => {
          const list = require('./skills').listSkills();
          const text = list.length
            ? `🔧 *Skills (${list.length})*\n\n` + list.map(s =>
                `• \`${s.slug}\` — ${s.name}\n  _${(s.description||'').slice(0,60)}_`
              ).join('\n')
            : '🔧 No hay skills instalados.';
          await bot.sendWithButtons(chatId, text,
            [[{ text: '🔍 Buscar', callback_data: 'menu:skills:buscar' },
              { text: '← Skills',  callback_data: 'menu:skills' }]], msgId);
        },
      },
      'menu:skills:buscar': {
        action: async ({ chatId, chat, bot }) => {
          chat.pendingAction = { type: 'skill-search' };
          await bot.sendText(chatId,
            '🔍 *Buscar skill en ClawHub*\n\n¿Para qué necesitás el skill?\n' +
            '_Ejemplos: "crear PDFs", "enviar emails"_\n\nUsá /cancelar para cancelar.'
          );
        },
      },

      // ── Agentes ───────────────────────────────────────────────────────────
      'menu:agentes': {
        text: (chat) => `🎭 *Agentes de rol*${chat?.activeAgent ? `\nActivo: \`${chat.activeAgent.key}\`` : ''}`,
        buttons: (chat) => {
          const roleAgents = agentsModule.list().filter(a => a.prompt);
          if (!roleAgents.length) return [[{ text: '← Menú', id: 'menu' }]];
          const agentRows = roleAgents.map(a => [{
            text: (chat?.activeAgent?.key === a.key ? '✅ ' : '') + a.key,
            id: `agent:${a.key}`,
          }]);
          const navRow = [];
          if (chat?.activeAgent) navRow.push({ text: '🚫 Basta', id: 'basta_action' });
          navRow.push({ text: '← Menú', id: 'menu' });
          return [...agentRows, navRow];
        },
      },

      // ── Monitor ───────────────────────────────────────────────────────────
      'menu:monitor': {
        text: (chat) => `🖥️ *Monitor*\nDirectorio: \`${chat?.monitorCwd || process.env.HOME}\``,
        buttons: () => [
          [{ text: '📁 ls',          id: 'menu:monitor:ls'      },
           { text: '🖥️ Consola',      id: 'menu:monitor:consola' }],
          [{ text: '📊 Status VPS',   id: 'status_vps'           },
           { text: '← Menú',          id: 'menu'                 }],
        ],
      },
      'menu:monitor:consola': {
        action: async ({ chatId, chat, bot }) => {
          chat.consoleMode = true;
          const cwd = chat.monitorCwd || process.env.HOME;
          const cwdShort = cwd.replace(process.env.HOME, '~');
          await bot._sendConsolePrompt(chatId,
            `🖥️ *Modo consola activado*\n📁 \`${cwdShort}\`\n\nEscribí comandos directamente.\n\`exit\` o /consola para salir.`,
            chat);
        },
      },
      // ── Configuración ─────────────────────────────────────────────────────
      'menu:config': {
        text: (chat) => {
          const provider = chat?.provider || 'claude-code';
          const mode = chat?.claudeMode || 'ask';
          const model = chat?.claudeSession?.model || 'default';
          return `⚙️ *Configuración*\nProvider: \`${provider}\` | Permisos: \`${mode}\` | Modelo: \`${model}\``;
        },
        buttons: () => [
          [{ text: '🤖 Provider',  id: 'menu:config:provider'  },
           { text: '🔐 Permisos',  id: 'menu:config:permisos'  }],
          [{ text: '🧠 Modelo',    id: 'menu:config:modelo'    },
           { text: '← Menú',       id: 'menu'                  }],
        ],
      },
      'menu:config:provider': {
        action: async ({ chatId, msgId, chat, bot }) => {
          if (!providersModule) {
            await bot.sendText(chatId, '❌ Módulo providers no disponible.'); return;
          }
          const current = chat.provider || 'claude-code';
          const providerButtons = providersModule.list().map(p => [{
            text: `${current === p.name ? '✅ ' : ''}${p.label}`,
            callback_data: `provider:${p.name}`,
          }]);
          providerButtons.push([{ text: '← Config', callback_data: 'menu:config' }]);
          await bot.sendWithButtons(chatId,
            `🤖 *Provider actual*: \`${current}\`\nElegí uno:`,
            providerButtons, msgId);
        },
      },
      'menu:config:permisos': {
        action: async ({ chatId, msgId, chat, bot }) => {
          const current = chat.claudeMode || 'ask';
          await bot.sendWithButtons(chatId,
            `🔐 *Modo de permisos*: \`${current}\`\n\n• \`ask\` — describe sin ejecutar\n• \`auto\` — ejecuta todo\n• \`plan\` — solo planifica`,
            [[
              { text: current==='ask'  ? '✅ ask'  : 'ask',   callback_data: 'claudemode:ask'  },
              { text: current==='auto' ? '✅ auto' : 'auto',  callback_data: 'claudemode:auto' },
              { text: current==='plan' ? '✅ plan' : 'plan',  callback_data: 'claudemode:plan' },
            ],
            [{ text: '← Config', callback_data: 'menu:config' }]],
            msgId);
        },
      },
      'menu:config:modelo': {
        action: async ({ chatId, msgId, chat, bot }) => {
          const current = chat.claudeSession?.model || 'default';
          await bot.sendWithButtons(chatId,
            `🧠 *Modelo actual*: \`${current}\`\nElegí uno:`,
            [
              [{ text: current==='claude-opus-4-6'           ? '✅ opus-4-6'   : 'opus-4-6',   callback_data: 'setmodel:claude-opus-4-6' },
               { text: current==='claude-sonnet-4-6'         ? '✅ sonnet-4-6' : 'sonnet-4-6', callback_data: 'setmodel:claude-sonnet-4-6' }],
              [{ text: current==='claude-haiku-4-5-20251001' ? '✅ haiku-4-5'  : 'haiku-4-5',  callback_data: 'setmodel:claude-haiku-4-5-20251001' },
               { text: current==='default'                   ? '✅ default'    : 'default',     callback_data: 'setmodel:default' }],
              [{ text: '← Config', callback_data: 'menu:config' }],
            ], msgId);
        },
      },

    }; // fin del objeto defs

    return defs[id] || null;
  }

  async _sendMenu(chatId, editMsgId = null) {
    const def = this._getMenuDef('menu');
    const text    = typeof def.text    === 'function' ? def.text(null) : def.text;
    const rawRows = typeof def.buttons === 'function' ? def.buttons(null) : def.buttons;
    await this.sendWithButtons(chatId, text, this._resolveButtons(rawRows, def.back), editMsgId);
  }

  async _handleCallbackQuery(cbq) {
    const chatId = cbq.message?.chat?.id;
    if (!chatId) return;
    const msgId  = cbq.message?.message_id;

    // Whitelist check
    if (!this._isAllowed(chatId)) {
      await this._answerCallback(cbq.id, '⛔ Sin acceso');
      return;
    }

    // Inicializar chat si no existe
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = {
        chatId,
        username: cbq.from?.username || null,
        firstName: cbq.from?.first_name || 'Usuario',
        sessionId: null,
        claudeSession: null,
        activeAgent: null,
        pendingAction: null,
        lastMessageAt: Date.now(),
        lastPreview: '',
        rateLimited: false,
        rateLimitedUntil: 0,
        monitorCwd: process.env.HOME,
        busy: false,
        provider: 'claude-code',
        aiHistory: [],
        claudeMode: 'ask',       // 'auto' | 'ask' | 'plan' — default: 'ask'
        consoleMode: false,
      };
      this.chats.set(chatId, chat);
    }

    await this._answerCallback(cbq.id);

    const data = cbq.data || '';

    // Callbacks de consola
    if (data.startsWith('console:')) {
      const command = data.slice(8);
      chat.consoleMode = true;
      await this._handleConsoleInput(chatId, command, chat);
      return;
    }

    // Motor de menús declarativo
    if (data.startsWith('menu:')) {
      const def = this._getMenuDef(data);
      if (!def) return;
      if (def.action) {
        await def.action({ chatId, msgId, chat, bot: this });
      } else {
        const text    = typeof def.text    === 'function' ? def.text(chat)    : def.text;
        const rawRows = typeof def.buttons === 'function' ? def.buttons(chat) : def.buttons;
        const buttons = this._resolveButtons(rawRows, def.back);
        await this.sendWithButtons(chatId, text, buttons, msgId);
      }
      return;
    }

    if (data.startsWith('setmodel:')) {
      const newModel = data.slice(9);
      const model = newModel === 'default' ? null : newModel;
      chat.claudeSession = new ClaudePrintSession({ model, permissionMode: chat.claudeMode || 'ask' });
      await this.sendText(chatId, `✅ Modelo: \`${newModel}\`\n_Nueva sesión iniciada._`);
      return;
    }

    if (data.startsWith('claudemode:')) {
      const newMode = data.slice(11); // 'auto' | 'ask' | 'plan'
      if (['auto', 'ask', 'plan'].includes(newMode)) {
        chat.claudeMode = newMode;
        // Actualizar sesión existente sin resetearla → preserva contexto
        if (chat.claudeSession) chat.claudeSession.permissionMode = newMode;
        const labels = { auto: '⚡ auto-accept', ask: '❓ ask', plan: '📋 plan' };
        await this.sendText(chatId,
          `✅ Modo cambiado a *${labels[newMode]}*\n_Contexto preservado._`
        );
      }
      return;
    }

    if (data.startsWith('provider:') && providersModule) {
      const newProvider = data.slice(9);
      const available = providersModule.list().map(p => p.name);
      if (available.includes(newProvider)) {
        chat.provider = newProvider;
        if (newProvider === 'claude-code') {
          chat.claudeSession = null;
        } else {
          chat.aiHistory = [];
        }
        const label = providersModule.get(newProvider).label;
        await this.sendText(chatId, `✅ Provider cambiado a *${label}*`);
      }
      return;
    }

    if (data.startsWith('agent:')) {
      const agentKey = data.slice(6);
      const agentDef = agentsModule.get(agentKey);
      if (agentDef?.prompt) {
        chat.claudeSession = new ClaudePrintSession({ permissionMode: chat.claudeMode || 'ask' });
        chat.activeAgent = { key: agentDef.key, prompt: agentDef.prompt };
        const fullPrompt = skillsModule.buildAgentPrompt(agentDef);
        await this._sendToSession(chatId, fullPrompt, chat);
      } else {
        await this.sendText(chatId, `❌ Agente "${agentKey}" no encontrado o sin prompt.`);
      }
      return;
    }

    switch (data) {
      case 'status_vps': {
        try {
          const s = getSystemStats();
          const text =
            `📊 *Estado del VPS*\n\n` +
            `🖥️ CPU: ${s.cpu}\n` +
            `🧠 RAM: ${s.ram}\n` +
            `💾 Disco: ${s.disk}\n` +
            `⏱️ Uptime: ${s.uptime}`;
          await this.sendWithButtons(chatId, text,
            [[{ text: '🔄 Actualizar', callback_data: 'status_vps' }]],
            msgId
          );
        } catch (err) {
          await this.sendText(chatId, `❌ Error: ${err.message}`);
        }
        break;
      }

      case 'nueva':
      case 'reset': {
        if (this._isClaudeBased()) {
          const model = chat.claudeSession?.model || null;
          chat.claudeSession = new ClaudePrintSession({ model, permissionMode: chat.claudeMode || 'ask' });
          await this.sendWithButtons(chatId,
            `✅ Nueva conversación *${this.defaultAgent}* iniciada (\`${chat.claudeSession.id.slice(0,8)}…\`)`,
            [[{ text: '🤖 Menú', callback_data: 'menu' }]]
          );
        } else {
          const s = await this.getOrCreateSession(chatId, chat, true);
          await this.sendWithButtons(chatId,
            `✅ Nueva sesión *${s.title}* creada (\`${s.id.slice(0,8)}…\`)`,
            [[{ text: '🤖 Menú', callback_data: 'menu' }]]
          );
        }
        break;
      }

      case 'skills': {
        const list = skillsModule.listSkills();
        if (!list.length) {
          await this.sendText(chatId, '🔧 *Skills instalados*\n\nNo hay skills instalados.\nInstalá uno desde el panel web o la API.');
        } else {
          const lines = list.map(s => `• \`${s.slug}\` — ${s.name}${s.description ? `\n  _${s.description.slice(0, 80)}_` : ''}`).join('\n');
          await this.sendText(chatId, `🔧 *Skills instalados* (${list.length})\n\n${lines}`);
        }
        break;
      }

      case 'agentes': {
        const roleAgents = agentsModule.list().filter(a => a.prompt);
        if (roleAgents.length === 0) {
          await this.sendText(chatId,
            `🎭 *Agentes de rol disponibles*\n\n` +
            `No hay agentes con prompt configurado.\n` +
            `Creá uno desde el panel web (botón 🎭) y usalo aquí.`
          );
        } else {
          const lines = roleAgents.map(a =>
            `• /${a.key} — ${a.description || a.key}` +
            (a.prompt ? `\n  _"${a.prompt.slice(0, 60)}${a.prompt.length > 60 ? '…' : ''}"_` : '')
          ).join('\n');
          const agentButtons = roleAgents.map(a => [{ text: `🎭 ${a.key}`, callback_data: `agent:${a.key}` }]);
          await this.sendWithButtons(chatId,
            `🎭 *Agentes de rol disponibles*\n\n${lines}\n\nActivá un agente tocando el botón:`,
            agentButtons
          );
        }
        break;
      }

      case 'ayuda': {
        await this.sendText(chatId,
          `🤖 *Comandos disponibles*\n\n` +
          `*Sesión:*\n` +
          `/start — saludo e inicio\n` +
          `/nueva — nueva conversación\n` +
          `/reset — reiniciar sesión\n` +
          `/compact — compactar contexto\n` +
          `/bash — nueva sesión bash\n\n` +
          `*Claude Code:*\n` +
          `/modelo [nombre] — ver/cambiar modelo\n` +
          `/permisos [modo] — ver/cambiar modo (auto/ask/plan)\n` +
          `/costo — costo de la sesión\n` +
          `/estado — estado detallado\n` +
          `/memoria — ver archivos de memoria\n` +
          `/dir — directorio de trabajo (alias: /pwd)\n\n` +
          `*Agentes de rol:*\n` +
          `/agentes — listar agentes con prompt\n` +
          `/<key> — activar agente de rol\n` +
          `/basta — desactivar agente de rol\n\n` +
          `*Skills:*\n` +
          `/skills — ver skills instalados\n` +
          `/buscar-skill — buscar e instalar skills de ClawHub\n` +
          `/mcps — ver MCPs configurados\n` +
          `/buscar-mcp [query] — buscar e instalar MCPs de Smithery\n\n` +
          `*Monitor:*\n` +
          `/consola — modo consola bash (toggle)\n` +
          `/status-vps — CPU, RAM y disco\n\n` +
          `*Audio:*\n` +
          `🎙️ Enviá un audio de voz y se transcribe automáticamente\n\n` +
          `*Bot:*\n` +
          `/agente [key] — ver/cambiar agente\n` +
          `/ayuda — esta ayuda`
        );
        break;
      }

      case 'menu': {
        await this._sendMenu(chatId, msgId);
        break;
      }

      case 'basta_action': {
        chat.activeAgent = null;
        chat.claudeSession = new ClaudePrintSession({ permissionMode: chat.claudeMode || 'ask' });
        const def = this._getMenuDef('menu:agentes');
        const text    = typeof def.text    === 'function' ? def.text(chat)    : def.text;
        const rawRows = typeof def.buttons === 'function' ? def.buttons(chat) : def.buttons;
        await this.sendWithButtons(chatId, text, this._resolveButtons(rawRows, def.back), msgId);
        break;
      }

      case 'compact_action': {
        if (chat.claudeSession) await this._sendToSession(chatId, '/compact', chat);
        break;
      }
    }
  }

  async sendText(chatId, text) {
    const chunks = chunkText(stripAnsi(text), 4096);
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      try {
        await this._apiCall('sendMessage', { chat_id: chatId, text: chunk, parse_mode: 'Markdown' });
      } catch {
        try { await this._apiCall('sendMessage', { chat_id: chatId, text: chunk }); } catch (e2) {
          console.error(`[Telegram:${this.key}] No se pudo enviar a ${chatId}:`, e2.message);
        }
      }
    }
  }

  toJSON() {
    return {
      key: this.key,
      running: this.running,
      botInfo: this.botInfo,
      defaultAgent: this.defaultAgent,
      whitelist: this.whitelist,
      rateLimit: this.rateLimit,
      rateLimitKeyword: this.rateLimitKeyword,
      chats: [...this.chats.values()],
    };
  }
}

// ─── BotManager ───────────────────────────────────────────────────────────────

class BotManager {
  constructor() {
    /** @type {Map<string, TelegramBot>} */
    this.bots = new Map();
  }

  // Carga bots desde bots.json e inicia los que estaban activos
  async loadAndStart() {
    const saved = this._readFile();
    for (const saved_entry of saved) {
      const { key, token, defaultAgent, whitelist, rateLimit, rateLimitKeyword, offset } = saved_entry;
      const bot = new TelegramBot(key, token, {
        initialOffset: offset || 0,
        onOffsetSave: () => this._saveFile(),
      });
      if (defaultAgent) bot.defaultAgent = defaultAgent;
      if (whitelist) bot.whitelist = whitelist;
      if (rateLimit !== undefined) bot.rateLimit = rateLimit;
      if (rateLimitKeyword !== undefined) bot.rateLimitKeyword = rateLimitKeyword;
      this.bots.set(key, bot);
      try {
        await bot.start();
      } catch (err) {
        console.error(`[Telegram] No se pudo iniciar bot "${key}":`, err.message);
      }
    }
  }

  // Agrega un nuevo bot (o actualiza el token si ya existe la key)
  async addBot(key, token) {
    // Detener instancia existente si hay
    if (this.bots.has(key)) {
      await this.bots.get(key).stop();
    }
    const bot = new TelegramBot(key, token, { onOffsetSave: () => this._saveFile() });
    // Verificar token antes de guardar
    const info = await bot.start();
    this.bots.set(key, bot);
    this._saveFile();
    return info;
  }

  async removeBot(key) {
    const bot = this.bots.get(key);
    if (!bot) return false;
    await bot.stop();
    this.bots.delete(key);
    this._saveFile();
    return true;
  }

  async startBot(key) {
    const bot = this.bots.get(key);
    if (!bot) throw new Error(`Bot "${key}" no encontrado`);
    return bot.start();
  }

  async stopBot(key) {
    const bot = this.bots.get(key);
    if (!bot) throw new Error(`Bot "${key}" no encontrado`);
    return bot.stop();
  }

  getBot(key) {
    return this.bots.get(key);
  }

  listBots() {
    return [...this.bots.values()].map(b => b.toJSON());
  }

  linkSession(key, chatId, sessionId) {
    const bot = this.bots.get(key);
    if (!bot) return false;
    const chat = bot.chats.get(Number(chatId));
    if (!chat) return false;
    chat.sessionId = sessionId;
    return true;
  }

  disconnectChat(key, chatId) {
    const bot = this.bots.get(key);
    if (!bot) return false;
    return bot.chats.delete(Number(chatId));
  }

  // ── Persistencia ────────────────────────────────────────────────────────────

  _readFile() {
    try {
      if (fs.existsSync(BOTS_FILE)) {
        return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8')) || [];
      }

      // Primera ejecución: inicializar desde variables de entorno
      const token = process.env.BOT_TOKEN;
      if (!token) return [];

      const whitelist = (process.env.BOT_WHITELIST || '')
        .split(',').map(s => s.trim()).filter(Boolean).map(Number);

      const entry = {
        key:               process.env.BOT_KEY               || 'dev',
        token,
        defaultAgent:      process.env.BOT_DEFAULT_AGENT      || 'claude',
        whitelist,
        rateLimit:         parseInt(process.env.BOT_RATE_LIMIT) || 30,
        rateLimitKeyword:  process.env.BOT_RATE_LIMIT_KEYWORD  || '',
        offset:            0,
      };

      fs.writeFileSync(BOTS_FILE, JSON.stringify([entry], null, 2), 'utf8');
      console.log(`[Telegram] bots.json creado desde variables de entorno (key: ${entry.key})`);
      return [entry];
    } catch { return []; }
  }

  setBotAgent(key, agentKey) {
    const bot = this.bots.get(key);
    if (!bot) throw new Error(`Bot "${key}" no encontrado`);
    bot.setDefaultAgent(agentKey);
    this._saveFile();
    return bot.toJSON();
  }

  _saveFile() {
    const data = [...this.bots.entries()].map(([key, bot]) => ({
      key,
      token: bot.token,
      defaultAgent: bot.defaultAgent,
      whitelist: bot.whitelist,
      rateLimit: bot.rateLimit,
      rateLimitKeyword: bot.rateLimitKeyword,
      offset: bot.offset,
    }));
    try {
      fs.writeFileSync(BOTS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[Telegram] No se pudo guardar bots.json:', err.message);
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

const manager = new BotManager();

module.exports = {
  loadAndStart: () => manager.loadAndStart(),

  addBot:  (key, token) => manager.addBot(key, token),
  removeBot: (key)      => manager.removeBot(key),
  startBot:  (key)      => manager.startBot(key),
  stopBot:   (key)      => manager.stopBot(key),

  listBots: () => manager.listBots(),
  getBot:   (key) => manager.getBot(key),

  setBotAgent: (key, agentKey) => manager.setBotAgent(key, agentKey),
  saveBots: () => manager._saveFile(),

  linkSession:    (key, chatId, sessionId) => manager.linkSession(key, chatId, sessionId),
  disconnectChat: (key, chatId)            => manager.disconnectChat(key, chatId),
};
