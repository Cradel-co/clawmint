'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const crypto = require('crypto');
const sessionManager = require('./sessionManager');
const agentsModule = require('./agents');
const events = require('./events');

const BOTS_FILE = path.join(__dirname, 'bots.json');
const TELEGRAM_HOST = 'api.telegram.org';
const POLL_TIMEOUT = 25; // segundos

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

// ─── ClaudePrintSession (modo no-interactivo via `claude -p`) ─────────────────

class ClaudePrintSession {
  constructor() {
    this.id = crypto.randomUUID();
    this.createdAt = Date.now();
    this.active = true;
    this.messageCount = 0;
    this.title = 'claude';
  }

  async sendMessage(text) {
    const claudeArgs = ['--dangerously-skip-permissions', '-p', text];
    if (this.messageCount > 0) claudeArgs.push('--continue');

    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;

      // Usar spawn con stdin: 'ignore' para que claude no quede esperando input
      const child = spawn('claude', claudeArgs, {
        cwd: process.env.HOME,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const killTimer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
      }, 120000);

      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });

      child.on('close', (code) => {
        clearTimeout(killTimer);
        if (killed) {
          return reject(new Error('Timeout: claude -p no respondió en 120s'));
        }
        if (code !== 0) {
          console.error('[ClaudePrintSession] code:', code, '| stdout:', stdout.slice(0,200), '| stderr:', stderr.slice(0,200));
          const response = (stdout || stderr).trim();
          if (!response) return reject(new Error(`claude salió con código ${code}`));
          this.messageCount++;
          return resolve(response);
        }
        this.messageCount++;
        resolve(stdout.trim());
      });

      child.on('error', (err) => {
        clearTimeout(killTimer);
        console.error('[ClaudePrintSession] error al lanzar:', err.message);
        reject(err);
      });
    });
  }
}

// ─── Clase TelegramBot (una instancia por bot) ────────────────────────────────

class TelegramBot {
  constructor(key, token) {
    this.key = key;
    this.token = token;
    this.running = false;
    this.offset = 0;
    this.botInfo = null;
    this.defaultAgent = 'claude'; // key del agente por defecto
    /** @type {Map<number, object>} */
    this.chats = new Map();
  }

  setDefaultAgent(agentKey) {
    this.defaultAgent = agentKey;
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
      allowed_updates: ['message'],
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
      } catch (err) {
        if (!this.running) break;
        console.error(`[Telegram:${this.key}] Error en polling:`, err.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  async _handleUpdate(update) {
    const msg = update.message;
    if (!msg || !msg.text) return;
    await this._handleMessage(msg);
  }

  async _handleMessage(msg) {
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    console.log(`[Telegram:${this.key}] Mensaje de ${chatId}: ${text.slice(0, 60)}`);

    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = {
        chatId,
        username: msg.from?.username || null,
        firstName: msg.from?.first_name || 'Usuario',
        sessionId: null,
        claudeSession: null,
        lastMessageAt: Date.now(),
        lastPreview: '',
      };
      this.chats.set(chatId, chat);
    }
    chat.lastMessageAt = Date.now();
    chat.lastPreview = text.slice(0, 60);

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
      case 'start': {
        const agentKey = this.defaultAgent;
        const name = chat.firstName || 'usuario';
        if (!this._isClaudeBased()) await this.getOrCreateSession(chatId, chat);
        await this.sendText(chatId,
          `Hola ${name}! 👋\n\nSoy @${this.botInfo?.username}. Agente activo: *${agentKey}*.\n\n` +
          `Escribí cualquier cosa y lo enviaré a tu sesión.\nUsá /ayuda para ver los comandos.`
        );
        break;
      }
      case 'nueva': {
        if (this._isClaudeBased()) {
          chat.claudeSession = new ClaudePrintSession();
          await this.sendText(chatId, `✅ Nueva conversación *${this.defaultAgent}* iniciada (\`${chat.claudeSession.id.slice(0,8)}…\`)`);
        } else {
          const s = await this.getOrCreateSession(chatId, chat, true);
          await this.sendText(chatId, `✅ Nueva sesión *${s.title}* creada (\`${s.id.slice(0,8)}…\`)`);
        }
        break;
      }
      case 'bash': {
        const s = await this.getOrCreateSession(chatId, chat, true, 'bash');
        await this.sendText(chatId, `✅ Sesión *bash* creada (\`${s.id.slice(0,8)}…\`)`);
        break;
      }
      case 'agente': {
        if (args.length === 0) {
          // Mostrar agente actual y disponibles
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
      case 'sesion': {
        if (this._isClaudeBased()) {
          if (!chat.claudeSession) {
            await this.sendText(chatId, `❌ Sin sesión *${this.defaultAgent}* activa. Enviá un mensaje para iniciar una.`);
            return;
          }
          const cs = chat.claudeSession;
          const uptime = Math.round((Date.now() - cs.createdAt) / 1000);
          await this.sendText(chatId,
            `📊 *Sesión actual*\nID: \`${cs.id.slice(0,8)}…\`\nTipo: ${this.defaultAgent} -p (no-interactivo)\n` +
            `Mensajes: ${cs.messageCount}\nUptime: ${Math.floor(uptime/60)}m ${uptime%60}s`
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
        const uptime = Math.round((Date.now() - session.createdAt) / 1000);
        await this.sendText(chatId,
          `📊 *Sesión actual*\nID: \`${session.id.slice(0,8)}…\`\nAgente: ${session.title}\n` +
          `Activa: ${session.active ? 'Sí' : 'No'}\nUptime: ${Math.floor(uptime/60)}m ${uptime%60}s`
        );
        break;
      }
      case 'ayuda':
      case 'help':
        await this.sendText(chatId,
          `🤖 *Comandos*\n\n` +
          `/start — saludo y sesión con agente actual\n` +
          `/nueva — nueva sesión con agente actual\n` +
          `/bash — nueva sesión bash\n` +
          `/agente — ver/cambiar agente\n` +
          `/sesion — info de sesión actual\n` +
          `/ayuda — esta ayuda`
        );
        break;
      default:
        await this.sendText(chatId, `❓ Comando desconocido: /${cmd}\nUsá /ayuda.`);
    }
  }

  async _sendToSession(chatId, text, chat) {
    try {
      // Agentes claude-based → ClaudePrintSession (modo no-interactivo)
      if (this._isClaudeBased()) {
        if (!chat.claudeSession) {
          chat.claudeSession = new ClaudePrintSession();
        }
        try { await this._apiCall('sendChatAction', { chat_id: chatId, action: 'typing' }); } catch {}
        const response = await chat.claudeSession.sendMessage(text);
        if (response) await this.sendText(chatId, response);
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
      const result = await session.sendMessage(text, { timeout: 60000, stableMs: 3000 });
      const response = cleanPtyOutput(result.raw || '');
      if (response) await this.sendText(chatId, response);
    } catch (err) {
      console.error(`[Telegram:${this.key}] Error en sesión para chat ${chatId}:`, err.message);
      try { await this.sendText(chatId, `⚠️ Error: ${err.message}`); } catch {}
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
    for (const { key, token, defaultAgent } of saved) {
      const bot = new TelegramBot(key, token);
      if (defaultAgent) bot.defaultAgent = defaultAgent;
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
    const bot = new TelegramBot(key, token);
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
      if (!fs.existsSync(BOTS_FILE)) return [];
      return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8')) || [];
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

  linkSession:    (key, chatId, sessionId) => manager.linkSession(key, chatId, sessionId),
  disconnectChat: (key, chatId)            => manager.disconnectChat(key, chatId),
};
