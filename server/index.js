'use strict';

const express = require('express');
const http    = require('http');
const { WebSocketServer } = require('ws');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

// ─── Logger global ────────────────────────────────────────────────────────────
const Logger = require('./core/Logger');
const logger = new Logger();

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

  try { memory          = require('./memory');           logger.info('memory module loaded'); }  catch(e) { logger.error('memory FAIL:', e.message); process.exit(1); }
  try {
    await memory.initDBAsync();
    logger.info('memory SQLite OK (sql.js WASM)');
  } catch(e) { logger.error('memory initDBAsync FAIL:', e.message); process.exit(1); }

  try { providerConfig  = require('./provider-config'); logger.info('provider-config OK'); } catch(e) { logger.error('provider-config FAIL:', e.message); process.exit(1); }
  try { providersModule = require('./providers');        logger.info('providers OK'); }       catch(e) { logger.error('providers FAIL:', e.message); process.exit(1); }

  try {
    const { createContainer } = require('./bootstrap');
    const _c = createContainer();
    telegram     = _c.telegramChannel;
    webChannel   = _c.webChannel;
    consolidator = _c.consolidator;
    nodrizaInstance = _c.nodriza || null;
    convSvc      = _c.convSvc;
    try {
      const { createMcpRouter } = require('./mcp');
      mcpRouter = createMcpRouter({ sessionManager: _c.sessionManager, memory: _c.memory, scheduler: _c.scheduler, usersRepo: _c.usersRepo });
      logger.info('MCP router creado OK');
    } catch (mcpErr) {
      logger.warn('MCP router no disponible:', mcpErr.message);
    }
    logger.info('bootstrap OK (telegram + consolidator)');
  } catch(e) { logger.error('bootstrap FAIL:', e.message); process.exit(1); }

  try {
    const mcpClientPool = require('./mcp-client-pool');
    await mcpClientPool.initialize();
    logger.info('mcp-client-pool OK');
  } catch(e) { logger.warn('mcp-client-pool init falló:', e.message); }

  logger.info('Todos los módulos cargados.');
})();

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Health check
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

// ── HTTP + WebSocket servers ─────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const allWebClients = new Set();

// ── Rutas y WS handlers (montados después de _modulesReady) ──────────────────

const createAIHandler = require('./ws/ai-handler');
const createDataChannelHandler = require('./ws/datachannel-handler');
const setupPtyHandler = require('./ws/pty-handler');

let startAISession = null;
let startAISessionForDataChannel = null;

// ── Client estático (producción / Docker) ────────────────────────────────────

const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api|ws|mcp).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
  logger.info(`Sirviendo client build desde ${clientDist}`);
}

// ── Servidor ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
logger.info(`Iniciando servidor en ${HOST}:${PORT}...`);

_modulesReady.then(() => {
  // Montar rutas REST (necesitan módulos async)
  app.use('/api/sessions',        require('./routes/sessions')({ sessionManager }));
  app.use('/api/agents',          require('./routes/agents')({ agents }));
  app.use('/api/mcps',            require('./routes/mcps')({ mcps }));
  app.use('/api/skills',          require('./routes/skills')({ skills }));
  app.use('/api/memory',          require('./routes/memory')({ memory }));
  app.use('/api/logs',            require('./routes/logs')({ logger }));
  app.use('/api/telegram',        require('./routes/telegram')({ telegram, sessionManager }));
  app.use('/api/webchat',         require('./routes/webchat')({ webChannel }));
  app.use('/api/providers',       require('./routes/providers')({ providerConfig, providersModule }));
  app.use('/api/voice-providers', require('./routes/voice-providers')({}));
  app.use('/api/nodriza',         require('./routes/nodriza')({ nodrizaInstance, getDataChannelHandler: () => startAISessionForDataChannel }));

  // Montar MCP router si está disponible
  if (mcpRouter) app.use('/mcp', mcpRouter);

  // Broadcast de eventos Telegram a clientes WS
  if (events) {
    events.on('telegram:session', (data) => {
      const msg = JSON.stringify({ type: 'telegram_session', ...data });
      for (const ws of allWebClients) {
        try { if (ws.readyState === 1) ws.send(msg); } catch {}
      }
    });
  }

  // Inicializar WS handlers (necesitan módulos async)
  startAISession = createAIHandler({ providersModule, agents, memory, providerConfig });
  startAISessionForDataChannel = createDataChannelHandler({ providerConfig, logger });
  setupPtyHandler({ wss, sessionManager, webChannel, allWebClients, startAISession, events });

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
