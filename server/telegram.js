'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const pty = require('node-pty');
const crypto = require('crypto');
const sessionManager = require('./sessionManager');
const agentsModule = require('./agents');
const skillsModule = require('./skills');
const events = require('./events');

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
  constructor({ model = null } = {}) {
    this.id = crypto.randomUUID();
    this.createdAt = Date.now();
    this.active = true;
    this.messageCount = 0;
    this.title = 'claude';
    this.model = model;           // modelo explícito (null = default)
    this.totalCostUsd = 0;        // costo acumulado de la sesión
    this.lastCostUsd = 0;         // costo del último mensaje
    this.claudeSessionId = null;  // session_id interno de claude
  }

  async sendMessage(text, onChunk = null) {
    const claudeArgs = [
      '--dangerously-skip-permissions',
      '-p', text,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];
    if (this.model) claudeArgs.push('--model', this.model);
    if (this.messageCount > 0) claudeArgs.push('--continue');

    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;

      // Usar node-pty para que el CLI crea que está en un TTY → flush inmediato por línea
      const child = pty.spawn('claude', claudeArgs, {
        name: 'xterm',
        cols: 220,
        rows: 50,
        cwd: process.env.HOME,
        env,
      });

      let lineBuffer = '';
      let fullText = '';
      let killed = false;
      let exited = false;

      const killTimer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGTERM'); } catch {}
      }, 120000);

      const processLine = (line) => {
        let jsonStr = line.trim();
        if (!jsonStr) return;
        // Limpiar posibles secuencias ANSI del PTY antes de parsear JSON
        jsonStr = jsonStr.replace(/\x1B\[[0-9;?]*[A-Za-z@]/g, '').replace(/\r/g, '').trim();
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
          // assistant event con texto acumulado (fallback)
          else if (event.type === 'assistant') {
            const content = event.message?.content;
            if (Array.isArray(content)) {
              const textBlock = content.find(b => b.type === 'text');
              if (textBlock?.text && textBlock.text.length > fullText.length) {
                fullText = textBlock.text;
                if (onChunk) onChunk(fullText);
              }
            }
          }
          // system event: capturar modelo activo
          else if (event.type === 'system' && event.model) {
            this.model = this.model || event.model;
          }
          // result event: texto final definitivo + metadatos
          else if (event.type === 'result') {
            if (event.result) fullText = event.result;
            if (event.session_id) this.claudeSessionId = event.session_id;
            if (event.total_cost_usd != null) {
              this.lastCostUsd = event.total_cost_usd - this.totalCostUsd;
              this.totalCostUsd = event.total_cost_usd;
            }
          }
        } catch { /* ignorar líneas no-JSON */ }
      };

      child.onData((chunk) => {
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) processLine(line);
      });

      child.onExit(({ exitCode }) => {
        if (exited) return;
        exited = true;
        clearTimeout(killTimer);
        // Procesar cualquier dato residual en el buffer
        if (lineBuffer.trim()) processLine(lineBuffer);
        if (killed) return reject(new Error('Timeout: claude -p no respondió en 120s'));
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
  constructor(key, token) {
    this.key = key;
    this.token = token;
    this.running = false;
    this.offset = 0;
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
        const agentKey = this.defaultAgent;
        const name = chat.firstName || 'usuario';
        if (!this._isClaudeBased()) await this.getOrCreateSession(chatId, chat);
        await this.sendText(chatId,
          `Hola ${name}! 👋\n\nSoy @${this.botInfo?.username}. Agente activo: *${agentKey}*.\n\n` +
          `Escribí cualquier cosa y lo enviaré a tu sesión.\nUsá /ayuda para ver los comandos.`
        );
        break;
      }

      case 'nueva':
      case 'reset':
      case 'clear': {
        if (this._isClaudeBased()) {
          const model = chat.claudeSession?.model || null;
          chat.claudeSession = new ClaudePrintSession({ model });
          await this.sendText(chatId, `✅ Nueva conversación *${this.defaultAgent}* iniciada (\`${chat.claudeSession.id.slice(0,8)}…\`)`);
        } else {
          const s = await this.getOrCreateSession(chatId, chat, true);
          await this.sendText(chatId, `✅ Nueva sesión *${s.title}* creada (\`${s.id.slice(0,8)}…\`)`);
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
          chat.claudeSession = new ClaudePrintSession({ model: nuevoModelo });
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
      case 'cwd':
      case 'directorio': {
        await this.sendText(chatId, `📁 Directorio de trabajo: \`${process.env.HOME}\``);
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
          await this.sendText(chatId,
            `🎭 *Agentes de rol disponibles*\n\n${lines}\n\n` +
            `Activá un agente con /<key>. Desactivá con /basta.`
          );
        }
        break;
      }

      // ── Desactivar agente de rol ──────────────────────────────────────────
      case 'basta': {
        const prevKey = chat.activeAgent?.key;
        chat.activeAgent = null;
        chat.claudeSession = new ClaudePrintSession();
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
          `/costo — costo de la sesión\n` +
          `/estado — estado detallado\n` +
          `/memoria — ver archivos de memoria\n` +
          `/dir — directorio de trabajo\n\n` +
          `*Agentes de rol:*\n` +
          `/agentes — listar agentes con prompt\n` +
          `/<key> — activar agente de rol\n` +
          `/basta — desactivar agente de rol\n\n` +
          `*Skills:*\n` +
          `/skills — ver skills instalados\n` +
          `/buscar-skill — buscar e instalar skills de ClawHub\n\n` +
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

      default: {
        // Detectar /{key} de agente con prompt de rol
        const agentDef = agentsModule.get(cmd);
        if (agentDef?.prompt) {
          chat.claudeSession = new ClaudePrintSession();
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
  }

  async _sendToSession(chatId, text, chat) {
    try {
      // Agentes claude-based → ClaudePrintSession (modo no-interactivo con streaming)
      if (this._isClaudeBased()) {
        if (!chat.claudeSession) {
          chat.claudeSession = new ClaudePrintSession();
        }

        // Enviar placeholder inmediato → obtener message_id para editar progresivamente
        let sentMsg = null;
        try {
          sentMsg = await this._apiCall('sendMessage', { chat_id: chatId, text: '⏳' });
        } catch { /* continuar sin edición progresiva si falla */ }

        let lastEditAt = 0;
        const THROTTLE_MS = 1500; // Telegram permite ~1 edit/s por chat

        const onChunk = async (partial) => {
          if (!partial.trim() || !sentMsg) return;
          const now = Date.now();
          if (now - lastEditAt < THROTTLE_MS) return;
          lastEditAt = now;
          console.error('[onChunk] edit at', new Date().toISOString(), '| chars:', partial.length);
          try {
            await this._apiCall('editMessageText', {
              chat_id: chatId,
              message_id: sentMsg.message_id,
              text: cleanPtyOutput(partial).slice(0, 4000) || partial.slice(0, 4000),
            });
          } catch (e) { console.error('[onChunk] edit failed:', e.message); }
        };

        try {
          const response = await chat.claudeSession.sendMessage(text, onChunk);
          // Edición final garantizada con texto completo
          if (sentMsg && response) {
            try {
              await this._apiCall('editMessageText', {
                chat_id: chatId,
                message_id: sentMsg.message_id,
                text: cleanPtyOutput(response).slice(0, 4096) || response.slice(0, 4096),
              });
            } catch {
              await this.sendText(chatId, response); // fallback: nuevo mensaje
            }
          } else if (!sentMsg && response) {
            await this.sendText(chatId, response);
          }
        } catch (err) {
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
      const { key, token, defaultAgent, whitelist, rateLimit, rateLimitKeyword } = saved_entry;
      const bot = new TelegramBot(key, token);
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
      whitelist: bot.whitelist,
      rateLimit: bot.rateLimit,
      rateLimitKeyword: bot.rateLimitKeyword,
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
