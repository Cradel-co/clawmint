'use strict';

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ─── Logger global ────────────────────────────────────────────────────────────
const LOG_FILE        = path.join(__dirname, 'server.log');
const LOG_CONFIG_FILE = path.join(__dirname, 'logs.json');

function _loadLogConfig() {
  try {
    if (fs.existsSync(LOG_CONFIG_FILE))
      return JSON.parse(fs.readFileSync(LOG_CONFIG_FILE, 'utf8'));
  } catch {}
  return { enabled: true };
}

function _saveLogConfig(cfg) {
  try { fs.writeFileSync(LOG_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); } catch {}
}

// Inicializar config si no existe
if (!fs.existsSync(LOG_CONFIG_FILE)) _saveLogConfig({ enabled: true });

let logConfig = _loadLogConfig();

function log(level, ...args) {
  logConfig = _loadLogConfig(); // re-leer en cada log para respetar cambios en caliente
  const isError = level.trim() === 'ERROR';
  if (!logConfig.enabled && !isError) return; // errores siempre se loguean
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

const logger = {
  info:  (...a) => log('INFO ', ...a),
  warn:  (...a) => log('WARN ', ...a),
  error: (...a) => log('ERROR', ...a),
};

process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT EXCEPTION:', err.stack || err.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('UNHANDLED REJECTION:', reason?.stack || reason);
  process.exit(1);
});

logger.info('=== INICIO DEL SERVIDOR ===');
logger.info('Node version:', process.version);
logger.info('PATH:', process.env.PATH);
logger.info('HOME:', process.env.HOME);

// ── Carga de módulos (async por sql.js WASM) ─────────────────────────────────

let sessionManager, telegram, webChannel, agents, skills, events, memory, providerConfig, providersModule, consolidator, convSvc, mcps;
let mcpRouter = null;
let nodrizaInstance = null;

const _modulesReady = (async function loadModules() {
  logger.info('Cargando módulos...');
  try { sessionManager  = require('./sessionManager');  logger.info('sessionManager OK'); }  catch(e) { logger.error('sessionManager FAIL:', e.message); process.exit(1); }
  try { agents          = require('./agents');           logger.info('agents OK'); }          catch(e) { logger.error('agents FAIL:', e.message); process.exit(1); }
  try { skills          = require('./skills');           logger.info('skills OK'); }          catch(e) { logger.error('skills FAIL:', e.message); process.exit(1); }
  try { mcps            = require('./mcps');             logger.info('mcps OK'); }            catch(e) { logger.error('mcps FAIL:', e.message); process.exit(1); }
  try { events          = require('./events');           logger.info('events OK'); }          catch(e) { logger.error('events FAIL:', e.message); process.exit(1); }

  // sql.js requiere inicialización async del WASM antes de crear instancias SQLite
  try { memory          = require('./memory');           logger.info('memory module loaded'); }  catch(e) { logger.error('memory FAIL:', e.message); process.exit(1); }
  try {
    await memory.initDBAsync();
    logger.info('memory SQLite OK (sql.js WASM)');
  } catch(e) { logger.error('memory initDBAsync FAIL:', e.message); process.exit(1); }

  try { providerConfig  = require('./provider-config'); logger.info('provider-config OK'); } catch(e) { logger.error('provider-config FAIL:', e.message); process.exit(1); }
  try { providersModule = require('./providers');        logger.info('providers OK'); }       catch(e) { logger.error('providers FAIL:', e.message); process.exit(1); }
  // Telegram + consolidator + mcpRouter via bootstrap.js (DI completa)
  try {
    const { createContainer } = require('./bootstrap');
    const _c = createContainer();
    telegram     = _c.telegramChannel;
    webChannel   = _c.webChannel;
    consolidator = _c.consolidator;
    nodrizaInstance = _c.nodriza || null;
    convSvc      = _c.convSvc;
    // MCP router (embebido en Express)
    try {
      const { createMcpRouter } = require('./mcp');
      mcpRouter = createMcpRouter({ sessionManager: _c.sessionManager, memory: _c.memory });
      logger.info('MCP router creado OK');
    } catch (mcpErr) {
      logger.warn('MCP router no disponible:', mcpErr.message);
    }
    logger.info('bootstrap OK (telegram + consolidator)');
  } catch(e) { logger.error('bootstrap FAIL:', e.message); process.exit(1); }

  // Inicializar pool de clientes MCP (conecta MCPs enabled para providers API)
  try {
    const mcpClientPool = require('./mcp-client-pool');
    await mcpClientPool.initialize();
    logger.info('mcp-client-pool OK');
  } catch(e) { logger.warn('mcp-client-pool init falló:', e.message); }

  logger.info('Todos los módulos cargados.');
})();

const app = express();
app.use(cors());
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────
const SERVER_START_TIME = Date.now();
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
    startedAt: new Date(SERVER_START_TIME).toISOString(),
    pid: process.pid,
    node: process.version,
  });
});

// ── MCP endpoint (montado después de inicializar mcpRouter) ──────────────────
// Se registra con app.use('/mcp', ...) luego de que mcpRouter esté disponible.
// Ver sección "Servidor" más abajo.

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
// Body: { key, command?, description?, prompt?, provider? }
app.post('/api/agents', (req, res) => {
  const { key, command, description, prompt, provider } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key requerida' });
  try {
    const agent = agents.add(key, command, description, prompt, provider);
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

// ─── MCPs API ─────────────────────────────────────────────────────────────────

// GET /api/mcps — listar MCPs configurados
app.get('/api/mcps', (_req, res) => {
  res.json(mcps.list());
});

// POST /api/mcps — crear MCP
app.post('/api/mcps', (req, res) => {
  try {
    const mcp = mcps.add(req.body);
    res.status(201).json(mcp);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PATCH /api/mcps/:name — actualizar MCP
app.patch('/api/mcps/:name', (req, res) => {
  try {
    const mcp = mcps.update(req.params.name, req.body);
    res.json(mcp);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// DELETE /api/mcps/:name — eliminar MCP
app.delete('/api/mcps/:name', (req, res) => {
  const ok = mcps.remove(req.params.name);
  if (!ok) return res.status(404).json({ error: 'MCP no encontrado' });
  res.json({ ok: true });
});

// POST /api/mcps/:name/sync — activar MCP (sincronizar con Claude CLI + pool)
app.post('/api/mcps/:name/sync', async (req, res) => {
  try {
    const mcp = await mcps.sync(req.params.name);
    res.json(mcp);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/mcps/:name/enable — alias de sync (usado por el frontend)
app.post('/api/mcps/:name/enable', async (req, res) => {
  try {
    const mcp = await mcps.sync(req.params.name);
    res.json(mcp);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/mcps/:name/unsync — desactivar MCP
app.post('/api/mcps/:name/unsync', async (req, res) => {
  try {
    const mcp = await mcps.unsync(req.params.name);
    res.json(mcp);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/mcps/:name/disable — alias de unsync (usado por el frontend)
app.post('/api/mcps/:name/disable', async (req, res) => {
  try {
    const mcp = await mcps.unsync(req.params.name);
    res.json(mcp);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/mcps/registry/search — buscar en Smithery
app.post('/api/mcps/registry/search', async (req, res) => {
  try {
    const results = await mcps.searchSmithery(req.body.query, req.body.limit);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mcps/registry/install — instalar desde Smithery
app.post('/api/mcps/registry/install', async (req, res) => {
  try {
    const result = await mcps.installFromRegistry(req.body.qualifiedName, req.body.name);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Skills API ───────────────────────────────────────────────────────────────

// GET /api/skills — lista skills instalados
app.get('/api/skills', (_req, res) => res.json(skills.listSkills()));

// POST /api/skills/install — descarga un skill directamente desde clawhub.ai API
app.post('/api/skills/install', async (req, res) => {
  const { slug } = req.body || {};
  if (!slug || !/^[a-z0-9_-]+$/.test(slug))
    return res.status(400).json({ error: 'slug inválido' });
  try {
    const response = await fetch(`https://clawhub.ai/api/v1/skills/${slug}/file?path=SKILL.md`);
    if (!response.ok) throw new Error(`ClawHub respondió ${response.status}`);
    const content = await response.text();
    const dir = path.join(skills.SKILLS_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
    res.json({ ok: true, slug });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/skills/search?q=query — buscar skills en ClawHub
app.get('/api/skills/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Parámetro q requerido' });
  try {
    const results = await skills.searchClawHub(q);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/skills/:slug — elimina un skill instalado
app.delete('/api/skills/:slug', (req, res) => {
  const dir = path.join(skills.SKILLS_DIR, req.params.slug);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Skill no encontrado' });
  fs.rmSync(dir, { recursive: true });
  res.json({ ok: true });
});

// ─── Memory API ───────────────────────────────────────────────────────────────

// GET /api/memory/debug?agentKey=xxx — análisis completo del estado de memoria
app.get('/api/memory/debug', (req, res) => {
  const agentKey = req.query.agentKey || null;

  // Stats desde SQLite
  const graph  = memory.buildGraph(agentKey);
  const notes  = graph.nodes;
  const links  = graph.links;

  // Distribución de importancia
  const byImportance = {};
  for (const n of notes) {
    byImportance[n.importance] = (byImportance[n.importance] || 0) + 1;
  }

  // Top 10 notas más accedidas
  const topAccessed = [...notes]
    .sort((a, b) => b.accessCount - a.accessCount)
    .slice(0, 10)
    .map(n => ({ id: n.id, title: n.title, tags: n.tags, accessCount: n.accessCount, importance: n.importance }));

  // Links learned vs explicit
  const learnedLinks   = links.filter(l => l.type === 'learned');
  const explicitLinks  = links.filter(l => l.type === 'explicit');

  // Top conexiones más fuertes
  const topLinks = [...links]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10)
    .map(l => {
      const src = notes.find(n => n.id === l.source);
      const tgt = notes.find(n => n.id === l.target);
      return {
        from: src?.title || l.source,
        to:   tgt?.title || l.target,
        weight: l.weight,
        type: l.type,
      };
    });

  // Todos los tags únicos
  const allTags = [...new Set(notes.flatMap(n => n.tags))].sort();

  res.json({
    stats: {
      totalNotes:     notes.length,
      totalLinks:     links.length,
      learnedLinks:   learnedLinks.length,
      explicitLinks:  explicitLinks.length,
      uniqueTags:     allTags.length,
      byImportance,
    },
    topAccessed,
    topLinks,
    allTags,
    agentKey: agentKey || '(todos)',
  });
});

// GET /api/memory/graph?agentKey=xxx — grafo para visualización futura
app.get('/api/memory/graph', (req, res) => {
  const agentKey = req.query.agentKey || null;
  res.json(memory.buildGraph(agentKey));
});

// GET /api/memory/:agentKey/search?tags=auth,jwt&q=texto — búsqueda semántica
app.get('/api/memory/:agentKey/search', (req, res) => {
  const { agentKey } = req.params;
  const tags    = req.query.tags ? req.query.tags.split(',').map(t => t.trim()) : [];
  const words   = req.query.q   ? memory.extractKeywords(req.query.q)           : [];
  const keywords = [...new Set([...tags, ...words])];
  const results  = memory.spreadingActivation(agentKey, keywords);
  res.json(results.map(r => ({
    filename:    r.filename,
    title:       r.title,
    tags:        r.tags,
    importance:  r.importance,
    accessCount: r.accessCount,
    preview:     r.content.slice(0, 200),
    score:       r.score,
  })));
});

// GET /api/memory/:agentKey — listar archivos de memoria del agente
app.get('/api/memory/:agentKey', (req, res) => {
  res.json(memory.listFiles(req.params.agentKey));
});

// GET /api/memory/:agentKey/:filename — leer archivo
app.get('/api/memory/:agentKey/:filename', (req, res) => {
  const content = memory.read(req.params.agentKey, req.params.filename);
  if (content === null) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.json({ content });
});

// PUT /api/memory/:agentKey/:filename — escribir/reemplazar archivo
app.put('/api/memory/:agentKey/:filename', (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content requerido' });
  try {
    memory.write(req.params.agentKey, req.params.filename, content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/memory/:agentKey/:filename/append — agregar al final
app.post('/api/memory/:agentKey/:filename/append', (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content requerido' });
  try {
    memory.append(req.params.agentKey, req.params.filename, content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/memory/:agentKey/:filename — eliminar archivo
app.delete('/api/memory/:agentKey/:filename', (req, res) => {
  try {
    const ok = memory.remove(req.params.agentKey, req.params.filename);
    if (!ok) return res.status(404).json({ error: 'Archivo no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Logs API ─────────────────────────────────────────────────────────────────

// GET /api/logs/config — ver estado actual
app.get('/api/logs/config', (_req, res) => {
  res.json(_loadLogConfig());
});

// POST /api/logs/config — cambiar config  { enabled: true|false }
app.post('/api/logs/config', (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) requerido' });
  const cfg = { enabled };
  _saveLogConfig(cfg);
  logConfig = cfg;
  logger.info(`Logs ${enabled ? 'activados' : 'desactivados'}.`);
  res.json(cfg);
});

// GET /api/logs/tail?lines=100 — últimas N líneas del log
app.get('/api/logs/tail', (req, res) => {
  const n = Math.min(parseInt(req.query.lines) || 100, 2000);
  try {
    const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
    const lines = content.split('\n').filter(Boolean);
    res.json({ lines: lines.slice(-n) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/logs — limpiar log
app.delete('/api/logs', (_req, res) => {
  try {
    fs.writeFileSync(LOG_FILE, '', 'utf8');
    logger.info('Log limpiado.');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// PATCH /api/telegram/bots/:key — actualizar config del bot
// Body: { defaultAgent?, whitelist?, groupWhitelist?, rateLimit?, rateLimitKeyword? }
app.patch('/api/telegram/bots/:key', (req, res) => {
  const bot = telegram.getBot(req.params.key);
  if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
  const { defaultAgent, whitelist, groupWhitelist, rateLimit, rateLimitKeyword } = req.body || {};
  if (defaultAgent !== undefined) bot.setDefaultAgent(defaultAgent);
  if (whitelist !== undefined) bot.setWhitelist(whitelist);
  if (groupWhitelist !== undefined) bot.setGroupWhitelist(groupWhitelist);
  if (rateLimit !== undefined) bot.setRateLimit(rateLimit);
  if (rateLimitKeyword !== undefined) bot.setRateLimitKeyword(rateLimitKeyword);
  telegram.saveBots();
  res.json(bot.toJSON());
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

// POST /api/telegram/bots/:key/chats/:chatId/message — enviar texto a un chat
app.post('/api/telegram/bots/:key/chats/:chatId/message', async (req, res) => {
  try {
    const bot = telegram.getBot(req.params.key);
    if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
    const chatId = Number(req.params.chatId);
    const { text, parse_mode, reply_markup, callbacks } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Se requiere text' });

    // Registrar callbacks dinámicos si vienen
    if (callbacks && typeof callbacks === 'object') {
      const dynamicRegistry = require('./channels/telegram/DynamicCallbackRegistry');
      dynamicRegistry.registerMany(callbacks);
    }

    const body = { chat_id: chatId, text };
    if (parse_mode) body.parse_mode = parse_mode;
    if (reply_markup) body.reply_markup = typeof reply_markup === 'string' ? reply_markup : JSON.stringify(reply_markup);
    const result = await bot._apiCall('sendMessage', body);
    res.json({ ok: true, message_id: result.message_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/telegram/bots/:key/chats/:chatId/photo — enviar imagen a un chat
app.post('/api/telegram/bots/:key/chats/:chatId/photo', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  try {
    const bot = telegram.getBot(req.params.key);
    if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
    const chatId = Number(req.params.chatId);
    const caption = req.query.caption || '';
    const filename = req.query.filename || 'photo.png';

    // Aceptar body raw (Buffer) o base64 en JSON
    let photoBuffer;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      photoBuffer = req.body;
    } else if (typeof req.body === 'string') {
      photoBuffer = Buffer.from(req.body, 'base64');
    } else {
      return res.status(400).json({ error: 'Se requiere imagen como body raw o base64' });
    }

    const result = await bot.sendPhoto(chatId, photoBuffer, { caption, filename });
    res.json({ ok: true, message_id: result.message_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/telegram/bots/:key/chats/:chatId/document — enviar archivo a un chat
app.post('/api/telegram/bots/:key/chats/:chatId/document', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  try {
    const bot = telegram.getBot(req.params.key);
    if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
    const chatId = Number(req.params.chatId);
    const caption = req.query.caption || '';
    const filename = req.query.filename || 'file.bin';
    const contentType = req.query.contentType || 'application/octet-stream';

    let docBuffer;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      docBuffer = req.body;
    } else if (typeof req.body === 'string') {
      docBuffer = Buffer.from(req.body, 'base64');
    } else {
      return res.status(400).json({ error: 'Se requiere archivo como body raw o base64' });
    }

    const result = await bot.sendDocument(chatId, docBuffer, { caption, filename, contentType });
    res.json({ ok: true, message_id: result.message_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/telegram/bots/:key/chats/:chatId/voice — enviar audio/voz a un chat
app.post('/api/telegram/bots/:key/chats/:chatId/voice', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  try {
    const bot = telegram.getBot(req.params.key);
    if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
    const chatId = Number(req.params.chatId);

    let audioBuffer;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      audioBuffer = req.body;
    } else if (typeof req.body === 'string') {
      audioBuffer = Buffer.from(req.body, 'base64');
    } else {
      return res.status(400).json({ error: 'Se requiere audio como body raw o base64' });
    }

    const result = await bot.sendVoice(chatId, audioBuffer);
    res.json({ ok: true, message_id: result.message_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/telegram/bots/:key/chats/:chatId/video — enviar video a un chat
app.post('/api/telegram/bots/:key/chats/:chatId/video', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  try {
    const bot = telegram.getBot(req.params.key);
    if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
    const chatId = Number(req.params.chatId);
    const caption = req.query.caption || '';
    const filename = req.query.filename || 'video.mp4';

    let videoBuffer;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      videoBuffer = req.body;
    } else if (typeof req.body === 'string') {
      videoBuffer = Buffer.from(req.body, 'base64');
    } else {
      return res.status(400).json({ error: 'Se requiere video como body raw o base64' });
    }

    const result = await bot.sendVideo(chatId, videoBuffer, { caption, filename });
    res.json({ ok: true, message_id: result.message_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/telegram/bots/:key/chats/:chatId/edit — editar mensaje de texto
app.post('/api/telegram/bots/:key/chats/:chatId/edit', async (req, res) => {
  try {
    const bot = telegram.getBot(req.params.key);
    if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
    const chatId = Number(req.params.chatId);
    const { message_id, text, parse_mode } = req.body || {};
    if (!message_id || !text) return res.status(400).json({ error: 'Se requieren message_id y text' });

    const body = { chat_id: chatId, message_id, text };
    if (parse_mode) body.parse_mode = parse_mode;
    const result = await bot._apiCall('editMessageText', body);
    res.json({ ok: true, message_id: result.message_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/telegram/bots/:key/chats/:chatId/delete — borrar mensaje
app.post('/api/telegram/bots/:key/chats/:chatId/delete', async (req, res) => {
  try {
    const bot = telegram.getBot(req.params.key);
    if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
    const chatId = Number(req.params.chatId);
    const { message_id } = req.body || {};
    if (!message_id) return res.status(400).json({ error: 'Se requiere message_id' });

    await bot._apiCall('deleteMessage', { chat_id: chatId, message_id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WebChat API ──────────────────────────────────────────────────────────────

// GET /api/webchat/sessions — listar sesiones activas
app.get('/api/webchat/sessions', (_req, res) => {
  if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
  res.json(webChannel.listSessions());
});

// POST /api/webchat/sessions/:sessionId/message — enviar texto a una sesión
app.post('/api/webchat/sessions/:sessionId/message', async (req, res) => {
  try {
    if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
    const { sessionId } = req.params;
    const { text, buttons, callbacks } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Se requiere text' });

    // Registrar callbacks dinámicos si vienen
    if (callbacks && typeof callbacks === 'object') {
      const dynamicRegistry = require('./channels/telegram/DynamicCallbackRegistry');
      dynamicRegistry.registerMany(callbacks);
    }

    if (buttons) {
      await webChannel.sendWithButtons(sessionId, text, buttons);
    } else {
      await webChannel.sendText(sessionId, text);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/webchat/sessions/:sessionId/photo — enviar imagen a una sesión
app.post('/api/webchat/sessions/:sessionId/photo', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  try {
    if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
    const { sessionId } = req.params;
    const caption = req.query.caption || '';
    const filename = req.query.filename || 'photo.png';

    let photoBuffer;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      photoBuffer = req.body;
    } else if (typeof req.body === 'string') {
      photoBuffer = Buffer.from(req.body, 'base64');
    } else {
      return res.status(400).json({ error: 'Se requiere imagen como body raw o base64' });
    }

    const base64 = photoBuffer.toString('base64');
    const mimeType = req.headers['content-type'] || 'image/png';
    const msgId = await webChannel.sendPhoto(sessionId, base64, { caption, filename, mimeType });
    res.json({ ok: true, msgId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/webchat/sessions/:sessionId/document — enviar archivo a una sesión
app.post('/api/webchat/sessions/:sessionId/document', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  try {
    if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
    const { sessionId } = req.params;
    const caption = req.query.caption || '';
    const filename = req.query.filename || 'file.bin';
    const contentType = req.query.contentType || 'application/octet-stream';

    let docBuffer;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      docBuffer = req.body;
    } else if (typeof req.body === 'string') {
      docBuffer = Buffer.from(req.body, 'base64');
    } else {
      return res.status(400).json({ error: 'Se requiere archivo como body raw o base64' });
    }

    const base64 = docBuffer.toString('base64');
    const msgId = await webChannel.sendDocument(sessionId, base64, { caption, filename, mimeType: contentType });
    res.json({ ok: true, msgId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/webchat/sessions/:sessionId/edit — editar mensaje
app.post('/api/webchat/sessions/:sessionId/edit', async (req, res) => {
  try {
    if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
    const { sessionId } = req.params;
    const { msg_id, text } = req.body || {};
    if (!msg_id || !text) return res.status(400).json({ error: 'Se requieren msg_id y text' });
    await webChannel.editMessage(sessionId, msg_id, text);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/webchat/sessions/:sessionId/delete — borrar mensaje
app.post('/api/webchat/sessions/:sessionId/delete', async (req, res) => {
  try {
    if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
    const { sessionId } = req.params;
    const { msg_id } = req.body || {};
    if (!msg_id) return res.status(400).json({ error: 'Se requiere msg_id' });
    await webChannel.deleteMessage(sessionId, msg_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/webchat/sessions/:sessionId/voice — enviar audio a una sesión
app.post('/api/webchat/sessions/:sessionId/voice', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  try {
    if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
    const { sessionId } = req.params;
    const caption = req.query.caption || '';
    const filename = req.query.filename || 'audio.ogg';

    let audioBuffer;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      audioBuffer = req.body;
    } else if (typeof req.body === 'string') {
      audioBuffer = Buffer.from(req.body, 'base64');
    } else {
      return res.status(400).json({ error: 'Se requiere audio como body raw o base64' });
    }

    const base64 = audioBuffer.toString('base64');
    const mimeType = req.headers['content-type'] || 'audio/ogg';
    const msgId = await webChannel.sendVoice(sessionId, base64, { caption, filename, mimeType });
    res.json({ ok: true, msgId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/webchat/sessions/:sessionId/video — enviar video a una sesión
app.post('/api/webchat/sessions/:sessionId/video', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  try {
    if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
    const { sessionId } = req.params;
    const caption = req.query.caption || '';
    const filename = req.query.filename || 'video.mp4';

    let videoBuffer;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      videoBuffer = req.body;
    } else if (typeof req.body === 'string') {
      videoBuffer = Buffer.from(req.body, 'base64');
    } else {
      return res.status(400).json({ error: 'Se requiere video como body raw o base64' });
    }

    const base64 = videoBuffer.toString('base64');
    const mimeType = req.headers['content-type'] || 'video/mp4';
    const msgId = await webChannel.sendVideo(sessionId, base64, { caption, filename, mimeType });
    res.json({ ok: true, msgId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

        if (msg.sessionType === 'webchat') {
          if (webChannel) {
            webChannel.handleConnection(ws, msg);
          } else {
            ws.send(JSON.stringify({ type: 'chat_error', error: 'WebChannel no disponible' }));
          }
          return;
        }

        if (msg.sessionType === 'claude' || msg.sessionType === 'ai') {
          // Sesión AI (sin PTY, acoplada al WS)
          startAISession(ws, msg);
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

// ─── AI session (acoplada al WS) — soporta múltiples providers ───────────────

// Historial de sesiones AI persistente entre reconexiones WS
// sessionId → { history: [], ts: number }
const aiSessionHistories = new Map();

// Limpiar entradas de más de 24h cada hora
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, entry] of aiSessionHistories) {
    if (entry.ts < cutoff) aiSessionHistories.delete(id);
  }
}, 60 * 60 * 1000).unref();

function startAISession(ws, opts) {
  const providerName = opts.provider || 'anthropic';
  const provider = providersModule.get(providerName);

  // Asignar sessionId propio y enviar al cliente para reconexiones futuras
  const sessionId = crypto.randomUUID();
  ws.send(JSON.stringify({ type: 'session_id', id: sessionId }));

  // Recuperar historial previo si el cliente reconectó con un sessionId anterior
  const prevEntry = opts.sessionId ? aiSessionHistories.get(opts.sessionId) : null;
  const history = prevEntry ? prevEntry.history : [];
  aiSessionHistories.set(sessionId, { history, ts: Date.now() });
  let inputBuffer = '';
  let processing = false;

  // Memoria del agente
  const agentKey = opts.agentKey || null;
  const agentDef = agentKey ? agents.get(agentKey) : null;
  const memoryFiles = agentDef?.memoryFiles || [];

  const basePrompt = opts.systemPrompt ||
    'Sos un asistente útil. Respondé de forma concisa y clara. ' +
    'Usá texto plano sin markdown ya que tu respuesta se mostrará en una terminal.';

  const toolInstructions = agentKey ? memory.TOOL_INSTRUCTIONS : '';
  // systemPrompt se actualiza en el primer mensaje con la memoria relevante
  let systemPrompt = [basePrompt, toolInstructions].filter(Boolean).join('\n\n');
  let memoryInjected = false;

  const apiKey  = providerConfig.getApiKey(providerName);
  const model   = opts.model || providerConfig.getConfig().providers[providerName]?.model || provider.defaultModel;

  const providerLabel = provider.label || providerName;
  send(`\x1b[1;32m╔══ ${providerLabel} ══╗\x1b[0m\r\n`);
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
          if (line) await askAI(line);
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

  async function askAI(userMessage) {
    processing = true;
    // Inyectar memoria en el primer mensaje con el texto real del usuario
    if (agentKey && !memoryInjected) {
      memoryInjected = true;
      const memCtx = memory.buildMemoryContext(agentKey, userMessage);
      if (memCtx) {
        systemPrompt = [basePrompt, memCtx, toolInstructions].filter(Boolean).join('\n\n');
      }
    }
    history.push({ role: 'user', content: userMessage });
    send(`\x1b[36m${providerLabel}:\x1b[0m `);

    try {
      let fullText = '';
      const gen = provider.chat({ systemPrompt, history, apiKey, model });

      for await (const event of gen) {
        if (event.type === 'text') {
          const chunk = event.text.replace(/\n/g, '\r\n');
          send(chunk);
          fullText = event.text; // se acumula en 'done'
        } else if (event.type === 'tool_call') {
          send(`\r\n\x1b[90m🔧 ${event.name}(${JSON.stringify(event.args)})\x1b[0m\r\n`);
        } else if (event.type === 'tool_result') {
          const preview = String(event.result).slice(0, 200);
          send(`\x1b[90m→ ${preview}${event.result?.length > 200 ? '…' : ''}\x1b[0m\r\n`);
          send(`\x1b[36m${providerLabel}:\x1b[0m `);
        } else if (event.type === 'done') {
          fullText = event.fullText;
        }
      }

      // Extraer y aplicar operaciones de memoria
      if (agentKey && fullText) {
        const { clean, ops } = memory.extractMemoryOps(fullText);
        if (ops.length > 0) {
          const saved = memory.applyOps(agentKey, ops);
          fullText = clean;
          send(`\r\n\x1b[90m💾 Memoria guardada: ${saved.join(', ')}\x1b[0m`);
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

// ─── Sesión AI sobre DataChannel (nodriza P2P) ──────────────────────────────

/**
 * Sesión P2P completa — reutiliza CommandHandler + CallbackHandler de Telegram
 * via P2PBotAdapter. Mismo pipeline: comandos, menú, botones, memoria, agentes.
 */
function startAISessionForDataChannel(dcAdapter, peerId) {
  logger.info(`[nodriza] Sesión AI P2P iniciada con peer ${peerId}`);

  const { createContainer } = require('./bootstrap');
  const container = createContainer();
  const P2PBotAdapter = require('./channels/p2p/P2PBotAdapter');
  const CommandHandler = require('./channels/telegram/CommandHandler');
  const CallbackHandler = require('./channels/telegram/CallbackHandler');

  // Estado del chat (similar a chat de Telegram)
  const chat = {
    chatId: peerId,
    firstName: 'peer',
    claudeSession: null,
    activeAgent: null,
    pendingAction: null,
    provider: providerConfig.getConfig().default || 'claude-code',
    model: null,
    claudeMode: 'auto',
    aiHistory: [],
    monitorCwd: process.env.HOME || process.cwd(),
    consoleMode: false,
    busy: false,
    _savedInSession: [],
  };

  let initialized = false;

  function send(data) {
    dcAdapter.send(JSON.stringify(data));
  }

  // Registrar peer en CritterRegistry para control remoto del PC
  const critterRegistry = require('./mcp/tools/critter-registry');
  critterRegistry.register(peerId, send);

  // Crear handlers con las mismas deps que Telegram
  const cbHandler = new CallbackHandler({
    agents: container.agents,
    skills: container.skills,
    memory: container.memory,
    reminders: container.reminders,
    mcps: container.mcps,
    consolidator: container.consolidator,
    providers: container.providers,
    providerConfig: container.providerConfig,
    chatSettings: container.chatSettingsRepo,
    transcriber: container.transcriber,
    tts: container.tts,
    voiceProviders: container.voiceProviders,
    ttsConfig: container.ttsConfig,
    logger,
  });

  const cmdHandler = new CommandHandler({
    agents: container.agents,
    skills: container.skills,
    memory: container.memory,
    reminders: container.reminders,
    mcps: container.mcps,
    consolidator: container.consolidator,
    sessionManager: container.sessionManager,
    providers: container.providers,
    providerConfig: container.providerConfig,
    transcriber: container.transcriber,
    tts: container.tts,
    chatSettings: container.chatSettingsRepo,
    logger,
  });

  const botAdapter = new P2PBotAdapter({
    send,
    chat,
    container,
    callbackHandler: cbHandler,
  });

  dcAdapter.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // Action results del critter
      if (msg.type === 'action_result') {
        critterRegistry.handleResult(peerId, msg.id, msg.result);
        return;
      }
      if (msg.type === 'action_error') {
        critterRegistry.handleError(peerId, msg.id, msg.error);
        return;
      }

      // Init
      if (msg.type === 'init' && !initialized) {
        initialized = true;
        if (msg.provider) chat.provider = msg.provider;
        if (msg.agentKey) chat.activeAgent = { key: msg.agentKey, prompt: '' };
        if (msg.model) chat.model = msg.model;

        const sessionId = crypto.randomUUID();
        send({ type: 'session_id', id: sessionId });
        logger.info(`[nodriza] P2P sesión ${sessionId} con provider ${chat.provider}`);
        return;
      }

      // Callback de botón
      if (msg.type === 'callback' && initialized) {
        handleCallback(msg.data);
        return;
      }

      // Audio para transcripción remota
      if (msg.type === 'audio' && initialized && !chat.busy) {
        handleAudio(msg.data, msg.format);
        return;
      }

      // Input de texto
      if (msg.type === 'input' && initialized && !chat.busy) {
        handleTextInput(msg.data);
      }
    } catch (e) {
      logger.error('[nodriza] Mensaje P2P inválido:', e.message);
    }
  });

  async function handleTextInput(text) {
    if (!text?.trim()) return;

    // Comandos /
    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);

      // Crear msg fake compatible con CommandHandler
      const fakeMsg = { chat: { id: peerId }, from: { first_name: 'peer' } };

      try {
        await cmdHandler.handle(botAdapter, fakeMsg, cmd, args, chat);
      } catch (err) {
        logger.error(`[nodriza] Error en comando /${cmd}:`, err.message);
        send({ type: 'output', data: `Error: ${err.message}` });
        send({ type: 'exit' });
      }
      return;
    }

    // Texto normal → ConversationService
    await botAdapter._sendToSession(peerId, text, chat);
  }

  async function handleCallback(callbackData) {
    // Crear callback query fake compatible con CallbackHandler
    const fakeCbq = {
      id: crypto.randomUUID(),
      data: callbackData,
      message: { chat: { id: peerId }, message_id: 0 },
      from: { id: peerId, first_name: 'peer' },
    };

    try {
      await cbHandler.handle(botAdapter, fakeCbq, chat);
    } catch (err) {
      logger.error(`[nodriza] Error en callback ${callbackData}:`, err.message);
      send({ type: 'output', data: `Error: ${err.message}` });
      send({ type: 'exit' });
    }
  }

  async function handleAudio(base64Data, format) {
    logger.info(`[nodriza] Audio recibido de peer ${peerId} (${base64Data?.length || 0} chars, format: ${format || 'unknown'})`);
    try {
      const transcriber = container.transcriber;
      if (!transcriber) {
        send({ type: 'output', data: 'Error: transcriber no disponible en el server' });
        send({ type: 'exit' });
        return;
      }

      let text;

      if (format === 'pcm_f32_16k') {
        // PCM Float32 16kHz directo — pasar al pipeline sin decodificar
        const buffer = Buffer.from(base64Data, 'base64');
        const pcm = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
        logger.info(`[nodriza] PCM recibido: ${pcm.length} muestras (${(pcm.length / 16000).toFixed(1)}s)`);
        text = await transcriber.transcribePCM(pcm);
      } else {
        // Formato archivo (webm, ogg) — guardar y transcribir
        const raw = base64Data.replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(raw, 'base64');
        const ext = format === 'ogg' ? '.ogg' : '.webm';
        const tmpFile = path.join(require('os').tmpdir(), `p2p_voice_${Date.now()}${ext}`);
        fs.writeFileSync(tmpFile, buffer);
        text = await transcriber.transcribe(tmpFile);
        try { fs.unlinkSync(tmpFile); } catch {}
      }

      if (text?.trim()) {
        await handleTextInput(text);
      } else {
        send({ type: 'output', data: '🎤 (no se detectó audio)' });
        send({ type: 'exit' });
      }
    } catch (err) {
      logger.error(`[nodriza] Error transcribiendo audio:`, err.message);
      send({ type: 'output', data: `Error transcripción: ${err.message}` });
      send({ type: 'exit' });
    }
  }

  // TODO: _pcmToWav could be extracted to a shared utility module (e.g. audio-utils.js)
  /** Convierte PCM Float32 a Buffer WAV */
  function _pcmToWav(pcm, sampleRate) {
    const numSamples = pcm.length;
    const bytesPerSample = 2; // 16-bit
    const dataSize = numSamples * bytesPerSample;
    const buffer = Buffer.alloc(44 + dataSize);

    // WAV header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);       // fmt chunk size
    buffer.writeUInt16LE(1, 20);        // PCM format
    buffer.writeUInt16LE(1, 22);        // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
    buffer.writeUInt16LE(bytesPerSample, 32);
    buffer.writeUInt16LE(16, 34);       // bits per sample
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    // Float32 → Int16
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      buffer.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7FFF, 44 + i * 2);
    }

    return buffer;
  }

  dcAdapter.on('close', () => {
    critterRegistry.unregister(peerId);
    logger.info(`[nodriza] DataChannel cerrado con peer ${peerId}`);
  });
}

// ─── WebChat Session — delegada a WebChannel (server/channels/web/WebChannel.js) ───

// ─── Providers API ────────────────────────────────────────────────────────────

// GET /api/providers — lista providers con label, models, si está configurado
app.get('/api/providers', async (_req, res) => {
  const cfg = providerConfig.getConfig();
  const providers = await providersModule.listAsync();
  const list = providers.map(p => ({
    ...p,
    configured: ['claude-code', 'ollama'].includes(p.name) ? true : !!(providerConfig.getApiKey(p.name)),
    currentModel: cfg.providers?.[p.name]?.model || p.defaultModel,
  }));
  res.json({ providers: list, default: cfg.default });
});

// GET /api/providers/config — config completa (sin mostrar keys completas)
app.get('/api/providers/config', (_req, res) => {
  const cfg = providerConfig.getConfig();
  const sanitized = JSON.parse(JSON.stringify(cfg));
  for (const [name, p] of Object.entries(sanitized.providers || {})) {
    if (p.apiKey) p.apiKey = p.apiKey.slice(0, 8) + '…';
  }
  res.json(sanitized);
});

// PUT /api/providers/default — { provider }
app.put('/api/providers/default', (req, res) => {
  const { provider } = req.body || {};
  if (!provider) return res.status(400).json({ error: 'provider requerido' });
  providerConfig.setDefault(provider);
  res.json({ ok: true, default: provider });
});

// PUT /api/providers/:name — { apiKey?, model? }
app.put('/api/providers/:name', (req, res) => {
  const { apiKey, model } = req.body || {};
  providerConfig.setProvider(req.params.name, { apiKey, model });
  res.json({ ok: true });
});

// ─── Voice Providers API ──────────────────────────────────────────────────────

// GET /api/voice-providers — lista con configured status
app.get('/api/voice-providers', (_req, res) => {
  try {
    const voiceProviders = require('./voice-providers');
    const ttsConfig      = require('./tts-config');
    const cfg = ttsConfig.getConfig();
    const list = voiceProviders.list().map(p => ({
      ...p,
      configured: p.type === 'local' ? true : !!ttsConfig.getApiKey(p.name),
      currentVoice: cfg.providers?.[p.name]?.voice || p.defaultVoice,
      currentModel: cfg.providers?.[p.name]?.model || p.defaultModel,
    }));
    res.json({ providers: list, default: cfg.default, enabled: cfg.enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/voice-providers/default — { provider }
app.put('/api/voice-providers/default', (req, res) => {
  try {
    const ttsConfig = require('./tts-config');
    const { provider } = req.body || {};
    if (!provider) return res.status(400).json({ error: 'provider requerido' });
    ttsConfig.setDefault(provider);
    res.json({ ok: true, default: provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/voice-providers/:name — { apiKey?, voice?, model? }
app.put('/api/voice-providers/:name', (req, res) => {
  try {
    const ttsConfig = require('./tts-config');
    const { apiKey, voice, model } = req.body || {};
    ttsConfig.setProvider(req.params.name, { apiKey, voice, model });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Nodriza API ─────────────────────────────────────────────────────────────

// GET /api/nodriza/config — config actual (apiKey censurada)
app.get('/api/nodriza/config', (_req, res) => {
  try {
    const nodrizaConfig = require('./nodriza-config');
    const cfg = nodrizaConfig.getConfig();
    if (cfg.apiKey) cfg.apiKey = cfg.apiKey.slice(0, 8) + '…';
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/nodriza/config — actualizar config
app.put('/api/nodriza/config', (req, res) => {
  try {
    const nodrizaConfig = require('./nodriza-config');
    const { url, serverId, apiKey, enabled } = req.body || {};
    const partial = {};
    if (url !== undefined)      partial.url = url;
    if (serverId !== undefined) partial.serverId = serverId;
    if (apiKey !== undefined)   partial.apiKey = apiKey;
    if (enabled !== undefined)  partial.enabled = enabled;
    nodrizaConfig.setConfig(partial);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/nodriza/status — estado de conexión
app.get('/api/nodriza/status', (_req, res) => {
  res.json({
    connected: nodrizaInstance?.isConnected() || false,
    peers: nodrizaInstance?.getConnectedPeers() || [],
  });
});

// POST /api/nodriza/reconnect — forzar reconexión
app.post('/api/nodriza/reconnect', (_req, res) => {
  if (!nodrizaInstance) return res.status(400).json({ error: 'nodriza no inicializada' });
  nodrizaInstance.stop();
  nodrizaInstance.start({ onPeerChannel: startAISessionForDataChannel });
  res.json({ ok: true });
});

// ─── MCP endpoint se monta en _modulesReady.then() (requiere bootstrap async) ─

// ─── Client estático (producción / Docker) ───────────────────────────────────

const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api|ws).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
  logger.info(`Sirviendo client build desde ${clientDist}`);
}

// ─── Servidor ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
logger.info(`Iniciando servidor en ${HOST}:${PORT}...`);
// Esperar a que sql.js WASM + módulos estén listos antes de escuchar
_modulesReady.then(() => {
  // Montar MCP router si está disponible (necesita bootstrap completo)
  if (mcpRouter) {
    app.use('/mcp', mcpRouter);
  }

  server.listen(PORT, HOST, async () => {
    logger.info(`Servidor escuchando en http://${HOST}:${PORT}`);
    console.log(`Servidor escuchando en http://${HOST}:${PORT}`);
    console.log(`HTTP API disponible en http://${HOST}:${PORT}/api/sessions`);

    logger.info('Iniciando bots de Telegram...');
    try {
      await telegram.loadAndStart();
      logger.info('Bots de Telegram iniciados OK.');
    } catch (err) {
      logger.error('Error al iniciar bots de Telegram:', err.stack || err.message);
    }

    // Iniciar nodriza si está configurada
    if (nodrizaInstance) {
      try {
        nodrizaInstance.start({ onPeerChannel: startAISessionForDataChannel });
        logger.info('Nodriza iniciada — conectando a señalización P2P');
      } catch (err) {
        logger.error('Error al iniciar nodriza:', err.stack || err.message);
      }
    }

    logger.info('=== SERVIDOR LISTO ===');
  });
}).catch(e => {
  logger.error('FATAL: No se pudieron cargar módulos:', e.message);
  process.exit(1);
});
