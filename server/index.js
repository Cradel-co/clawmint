'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const sessionManager = require('./sessionManager');
const telegram = require('./telegram');
const agents = require('./agents');
const events = require('./events');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Clientes web conectados (para broadcasts de eventos Telegram)
const allWebClients = new Set();

// Cuando llega un mensaje de Telegram, notificar a todos los frontends conectados
events.on('telegram:session', ({ sessionId, from, text }) => {
  const payload = JSON.stringify({ type: 'telegram_session', sessionId, from, text });
  for (const ws of allWebClients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
});

function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;?]*[A-Za-z@]/g, '')          // CSI (incluye ?2004h, ?2004l, etc.)
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '') // OSC (título de ventana, etc.)
    .replace(/\x1B[A-Z\\]/g, '')                        // Escape sequences simples
    .replace(/[\x00-\x08\x0E-\x1F\x7F]/g, '')          // otros control chars
    .replace(/\r/g, '')
    .trim();
}

// ─── HTTP API ─────────────────────────────────────────────────────────────────

// GET /api/sessions — listar sesiones activas
app.get('/api/sessions', (_req, res) => {
  res.json(sessionManager.list().map(s => s.toJSON()));
});

// POST /api/sessions — crear sesión
// Body: { type?, command?, cols?, rows? }
app.post('/api/sessions', (req, res) => {
  const { type = 'pty', command, cols = 80, rows = 24 } = req.body || {};
  const session = sessionManager.create({ type, command, cols, rows });
  res.status(201).json(session.toJSON());
});

// GET /api/sessions/:id — info de sesión
app.get('/api/sessions/:id', (req, res) => {
  const session = sessionManager.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session.toJSON());
});

// DELETE /api/sessions/:id — cerrar sesión
app.delete('/api/sessions/:id', (req, res) => {
  const ok = sessionManager.destroy(req.params.id);
  res.json({ ok });
});

// POST /api/sessions/:id/input — input raw (retorna inmediato)
// Body: { text }
app.post('/api/sessions/:id/input', (req, res) => {
  const session = sessionManager.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { text } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error: 'text requerido' });
  session.input(text);
  res.json({ ok: true });
});

// POST /api/sessions/:id/message — envía mensaje y espera respuesta completa
// Body: { text }
// Response: { response, raw }
app.post('/api/sessions/:id/message', async (req, res) => {
  const session = sessionManager.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { text } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error: 'text requerido' });

  try {
    const result = await session.sendMessage(text);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:id/stream — SSE: output en tiempo real
app.get('/api/sessions/:id/stream', (req, res) => {
  const session = sessionManager.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const unsub = session.onOutput((data, event) => {
    if (event === 'exit') {
      res.write('event: exit\ndata: {}\n\n');
      res.end();
    } else {
      res.write(`data: ${JSON.stringify({ data })}\n\n`);
    }
  });

  req.on('close', unsub);
});

// GET /api/sessions/:id/output?since=0 — output buffereado desde timestamp
app.get('/api/sessions/:id/output', (req, res) => {
  const session = sessionManager.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const since = parseInt(req.query.since) || 0;
  const raw = session.getOutputSince(since);
  res.json({ raw, response: stripAnsi(raw), ts: Date.now() });
});

// ─── Agents API ───────────────────────────────────────────────────────────────

// GET /api/agents — listar agentes
app.get('/api/agents', (_req, res) => {
  res.json(agents.list());
});

// POST /api/agents — crear agente
// Body: { key, command?, description? }
app.post('/api/agents', (req, res) => {
  const { key, command, description } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key requerida' });
  try {
    const agent = agents.add(key, command, description);
    res.status(201).json(agent);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/agents/:key — actualizar agente
// Body: { command?, description? }
app.patch('/api/agents/:key', (req, res) => {
  try {
    const agent = agents.update(req.params.key, req.body || {});
    res.json(agent);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// DELETE /api/agents/:key — eliminar agente
app.delete('/api/agents/:key', (req, res) => {
  const ok = agents.remove(req.params.key);
  if (!ok) return res.status(404).json({ error: 'Agente no encontrado' });
  res.json({ ok: true });
});

// ─── Telegram API ─────────────────────────────────────────────────────────────

// GET /api/telegram/bots — lista todos los bots con su estado
app.get('/api/telegram/bots', (_req, res) => {
  res.json(telegram.listBots());
});

// POST /api/telegram/bots — agregar/actualizar bot
// Body: { key, token }
app.post('/api/telegram/bots', async (req, res) => {
  const { key, token } = req.body || {};
  if (!key || !token) return res.status(400).json({ error: 'key y token requeridos' });
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) return res.status(400).json({ error: 'key inválida (solo letras, números, _ y -)' });
  try {
    const result = await telegram.addBot(key, token);
    res.json({ ok: true, username: result.username });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/telegram/bots/:key — eliminar bot
app.delete('/api/telegram/bots/:key', async (req, res) => {
  const ok = await telegram.removeBot(req.params.key);
  if (!ok) return res.status(404).json({ error: 'Bot no encontrado' });
  res.json({ ok: true });
});

// POST /api/telegram/bots/:key/start — iniciar bot
app.post('/api/telegram/bots/:key/start', async (req, res) => {
  try {
    const result = await telegram.startBot(req.params.key);
    res.json({ ok: true, username: result.username });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/telegram/bots/:key — actualizar config del bot (ej: defaultAgent)
// Body: { defaultAgent }
app.patch('/api/telegram/bots/:key', (req, res) => {
  const { defaultAgent } = req.body || {};
  if (defaultAgent !== undefined) {
    try {
      const bot = telegram.setBotAgent(req.params.key, defaultAgent);
      return res.json(bot);
    } catch (err) {
      return res.status(404).json({ error: err.message });
    }
  }
  res.status(400).json({ error: 'Nada que actualizar' });
});

// POST /api/telegram/bots/:key/stop — detener bot
app.post('/api/telegram/bots/:key/stop', async (req, res) => {
  try {
    await telegram.stopBot(req.params.key);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// GET /api/telegram/bots/:key/chats — chats del bot
app.get('/api/telegram/bots/:key/chats', (req, res) => {
  const bot = telegram.getBot(req.params.key);
  if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
  res.json([...bot.chats.values()]);
});

// POST /api/telegram/bots/:key/chats/:chatId/session — vincular sesión
// Body: { sessionId? } — omitir → crear nueva claude
app.post('/api/telegram/bots/:key/chats/:chatId/session', async (req, res) => {
  const { key } = req.params;
  const chatId = Number(req.params.chatId);
  const { sessionId } = req.body || {};

  if (sessionId) {
    const ok = telegram.linkSession(key, chatId, sessionId);
    if (!ok) return res.status(404).json({ error: 'Chat o bot no encontrado' });
    return res.json({ ok: true, sessionId });
  }

  const session = sessionManager.create({ type: 'pty', command: 'claude', cols: 80, rows: 24 });
  telegram.linkSession(key, chatId, session.id);
  res.json({ ok: true, sessionId: session.id });
});

// DELETE /api/telegram/bots/:key/chats/:chatId — desconectar chat
app.delete('/api/telegram/bots/:key/chats/:chatId', (req, res) => {
  const ok = telegram.disconnectChat(req.params.key, Number(req.params.chatId));
  res.json({ ok });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  console.log('Cliente WS conectado');
  allWebClients.add(ws);

  let session = null;    // PtySession (puede ser null si es claude-api)
  let initialized = false;

  const initTimeout = setTimeout(() => {
    if (!initialized) {
      initialized = true;
      session = sessionManager.create({});
      ws.send(JSON.stringify({ type: 'session_id', id: session.id }));
      attachWsToSession(ws, session);
    }
  }, 500);

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'init' && !initialized) {
        clearTimeout(initTimeout);
        initialized = true;

        // Listener puro: solo recibe broadcasts, sin PTY
        if (msg.sessionType === 'listener') {
          return;
        }

        if (msg.sessionType === 'claude') {
          // Sesión Claude API (sin PTY, acoplada al WS)
          startClaudeSession(ws, msg);
          return;
        }

        // Adjuntarse a sesión existente o crear nueva
        if (msg.sessionId) {
          const existing = sessionManager.get(msg.sessionId);
          if (existing) {
            session = existing;
            ws.send(JSON.stringify({ type: 'session_id', id: session.id }));
            attachWsToSession(ws, session);
            return;
          }
        }

        session = sessionManager.create({
          type: 'pty',
          command: msg.command || null,
          cols: msg.cols || 80,
          rows: msg.rows || 24,
        });

        ws.send(JSON.stringify({ type: 'session_id', id: session.id }));
        attachWsToSession(ws, session);
        return;
      }

      if (msg.type === 'input' && session) {
        session.input(msg.data);
      } else if (msg.type === 'resize' && session) {
        session.resize(msg.cols, msg.rows);
      }
    } catch (e) {
      console.error('Mensaje WS inválido:', e);
    }
  });

  ws.on('close', () => {
    // La sesión NO se destruye al cerrar WS: persiste para uso HTTP
    console.log('Cliente WS desconectado — sesión persiste');
    allWebClients.delete(ws);
    clearTimeout(initTimeout);
  });
});

/** Conecta un WebSocket a una PtySession existente */
function attachWsToSession(ws, session) {
  // Enviar historial acumulado si hay algo
  const past = session.getOutputSince(0);
  if (past) {
    ws.send(JSON.stringify({ type: 'output', data: past }));
  }

  const unsub = session.onOutput((data, event) => {
    if (!ws || ws.readyState !== ws.OPEN) { unsub(); return; }
    if (event === 'exit') {
      ws.send(JSON.stringify({ type: 'exit' }));
    } else {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  });

  ws.on('close', unsub);
}

// ─── Claude API session (acoplada al WS) ─────────────────────────────────────

function startClaudeSession(ws, opts) {
  const client = new Anthropic();
  const history = [];
  let inputBuffer = '';
  let processing = false;

  const systemPrompt = opts.systemPrompt ||
    'Sos un asistente útil. Respondé de forma concisa y clara. ' +
    'Usá texto plano sin markdown ya que tu respuesta se mostrará en una terminal.';

  send('\x1b[1;32m╔══ Claude API ══╗\x1b[0m\r\n');
  send('\x1b[90mEscribí tu mensaje y presioná Enter. Ctrl+C para cancelar línea.\x1b[0m\r\n\r\n');
  prompt();

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type !== 'input') return;
      if (processing) return;

      for (const char of msg.data) {
        if (char === '\r' || char === '\n') {
          const line = inputBuffer.trim();
          inputBuffer = '';
          send('\r\n');
          if (line) await askClaude(line);
          else prompt();
        } else if (char === '\x7f' || char === '\x08') {
          if (inputBuffer.length > 0) {
            inputBuffer = inputBuffer.slice(0, -1);
            send('\x08 \x08');
          }
        } else if (char === '\x03') {
          inputBuffer = '';
          send('^C\r\n');
          prompt();
        } else {
          inputBuffer += char;
          send(char);
        }
      }
    } catch { /* ignorar */ }
  });

  async function askClaude(userMessage) {
    processing = true;
    history.push({ role: 'user', content: userMessage });
    send('\x1b[36mClaude:\x1b[0m ');

    try {
      const stream = client.messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        system: systemPrompt,
        messages: history,
      });

      let fullText = '';
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          const chunk = event.delta.text.replace(/\n/g, '\r\n');
          send(chunk);
          fullText += event.delta.text;
        }
      }

      history.push({ role: 'assistant', content: fullText });
      send('\r\n\r\n');
    } catch (err) {
      send(`\r\n\x1b[31mError: ${err.message}\x1b[0m\r\n\r\n`);
    }

    processing = false;
    prompt();
  }

  function prompt() { send('\x1b[33mvos>\x1b[0m '); }

  function send(text) {
    if (ws.readyState === ws.OPEN)
      ws.send(JSON.stringify({ type: 'output', data: text }));
  }
}

// ─── Servidor ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log(`HTTP API disponible en http://localhost:${PORT}/api/sessions`);

  // Auto-iniciar bots guardados en bots.json
  await telegram.loadAndStart();
});
