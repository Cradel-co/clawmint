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

let sessionManager, telegram, webChannel, agents, skills, events, memory, providerConfig, providersModule, consolidator, convSvc, mcps, authService, usersRepo, transcriber, reminders, limitsRepo, permissionService, metricsService, hooksRepo, hookRegistry, hookLoader, userPreferencesRepo, sharedSessionsRepo, sharedSessionsBroker, mcpAuthService, systemConfigRepo, locationService, householdRepo, tasksRepo, typedMemoryRepo, chatSettingsRepo, lspServerManager, orchestrator;
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
    authService  = _c.authService;
    usersRepo    = _c.usersRepo;
    transcriber  = _c.transcriber;
    reminders    = _c.reminders;
    limitsRepo   = _c.limitsRepo;
    permissionService = _c.permissionService;
    metricsService    = _c.metricsService;
    hooksRepo    = _c.hooksRepo;
    hookRegistry = _c.hookRegistry;
    hookLoader   = _c.hookLoader;
    userPreferencesRepo = _c.userPreferencesRepo;
    sharedSessionsRepo = _c.sharedSessionsRepo;
    sharedSessionsBroker = _c.sharedSessionsBroker || null;
    mcpAuthService = _c.mcpAuthService || null;
    tasksRepo = _c.tasksRepo || null;
    typedMemoryRepo = _c.typedMemoryRepo || null;
    systemConfigRepo = _c.systemConfigRepo || null;
    locationService = _c.locationService || null;
    householdRepo = _c.householdRepo || null;
    chatSettingsRepo = _c.chatSettingsRepo || null;
    lspServerManager = _c.lspServerManager || null;
    orchestrator = _c.orchestrator || null;
    try {
      const { createMcpRouter } = require('./mcp');
      mcpRouter = createMcpRouter({ sessionManager: _c.sessionManager, memory: _c.memory, scheduler: _c.scheduler, usersRepo: _c.usersRepo, locationService: _c.locationService, userPreferencesRepo: _c.userPreferencesRepo, reminders: _c.reminders, tasksRepo: _c.tasksRepo, householdRepo: _c.householdRepo });
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

  // Sincronizar MCPs habilitados al Claude CLI y generar mcp-config.json
  try {
    await mcps.syncAll();
    mcps.generateConfigFile();
    logger.info('MCPs sincronizados y mcp-config.json generado');
  } catch(e) { logger.warn('mcps sync/config falló:', e.message); }

  logger.info('Todos los módulos cargados.');
})();

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Security headers (sin dep externa — helmet lite). Solo activos en prod para
// no obstaculizar dev (ej. HMR de vite necesita CSP permisivo).
if (process.env.NODE_ENV === 'production') {
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(self), camera=()');
    next();
  });
  app.set('trust proxy', 1); // si hay reverse proxy (Tailscale/Caddy/nginx)
  app.disable('x-powered-by');
}

// Correlation ID por request (Fase 5.5 Observabilidad)
app.use(require('./middleware/correlationId'));

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

// ── Client estático (producción / Docker / packaged) ─────────────────────────

const { RESOURCES_DIR, ensureDirs } = require('./paths');
ensureDirs();

// En dev: RESOURCES_DIR === <repo-root>/ → client/dist queda bien.
// En packaged: RESOURCES_DIR === <resources> → client/dist está ahí también.
const clientDist = path.join(RESOURCES_DIR, 'client', 'dist');
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
  // ── Auth middleware global ──────────────────────────────────────────────────
  const createAuthMiddleware = require('./middleware/authMiddleware');
  const { requireAuth } = createAuthMiddleware(authService);

  // Rutas públicas (sin auth)
  app.use('/api/auth',            require('./routes/auth')({ authService, usersRepo, logger }));
  app.use('/webhook',             telegram.webhookRouter());

  // Rutas protegidas (requieren JWT válido)
  app.use('/api/sessions',        requireAuth, require('./routes/sessions')({ sessionManager }));
  app.use('/api/agents',          requireAuth, require('./routes/agents')({ agents }));
  // /api/mcps: GET libre (lista censurada), mutaciones admin-only (Fase 5.75 F4).
  app.use('/api/mcps',            requireAuth, require('./routes/mcps')({ mcps, requireAdmin: require('./middleware/requireAdmin')({ usersRepo }) }));
  app.use('/api/skills',          requireAuth, require('./routes/skills')({ skills }));
  app.use('/api/memory',          requireAuth, require('./routes/memory')({ memory }));
  app.use('/api/logs',            requireAuth, require('./routes/logs')({ logger }));
  app.use('/api/telegram',        requireAuth, require('./routes/telegram')({ telegram, sessionManager }));
  app.use('/api/webchat',         requireAuth, require('./routes/webchat')({ webChannel }));
  app.use('/api/providers',       requireAuth, require('./routes/providers')({ providerConfig, providersModule }));
  app.use('/api/voice-providers', requireAuth, require('./routes/voice-providers')({}));
  app.use('/api/nodriza',         requireAuth, require('./routes/nodriza')({ nodrizaInstance, getDataChannelHandler: () => startAISessionForDataChannel }));
  app.use('/api/contacts',        requireAuth, require('./routes/contacts')({ usersRepo }));
  app.use('/api/transcriber',    requireAuth, require('./routes/transcriber')({ transcriber }));
  app.use('/api/reminders',      requireAuth, require('./routes/reminders')({ reminders }));
  app.use('/api/limits',          requireAuth, require('./routes/limits')({ limitsRepo }));
  app.use('/api/system',          requireAuth, require('./routes/system')({
    serverStart: SERVER_START_TIME,
    sessionManager,
    telegram,
    webChannel,
    providersModule,
    nodrizaInstance,
    allWebClients,
    locationService,
    requireAdmin: require('./middleware/requireAdmin')({ usersRepo }),
  }));

  // Tasks (Fase C.1) + Typed Memory (C.3) — CRUD REST.
  if (tasksRepo) {
    app.use('/api/tasks',         requireAuth, require('./routes/tasks')({ tasksRepo, usersRepo, logger }));
  }
  if (typedMemoryRepo) {
    app.use('/api/typed-memory',  requireAuth, require('./routes/typed-memory')({ typedMemoryRepo, logger }));
  }

  // Fase E — config admin (compaction, model-tiers, features snapshot)
  if (chatSettingsRepo) {
    app.use('/api/config',        requireAuth, require('./routes/config')({ chatSettingsRepo, usersRepo, logger }));
    app.use('/api/tools',         requireAuth, require('./routes/tools-admin')({ chatSettingsRepo, usersRepo, logger }));
  }
  // Fase E — LSP status
  if (lspServerManager) {
    app.use('/api/lsp',           requireAuth, require('./routes/lsp')({ lspServerManager, usersRepo, logger }));
  }
  // Fase E — orchestration workflows
  if (orchestrator) {
    app.use('/api/orchestration', requireAuth, require('./routes/orchestration')({ orchestrator, usersRepo, logger }));
  }

  // Permissions: admin-only CRUD (Fase 5)
  const requireAdmin = require('./middleware/requireAdmin')({ usersRepo });
  app.use('/api/permissions',     requireAuth, requireAdmin, require('./routes/permissions')({ permissionService }));

  // Metrics: admin-only (Fase 5.5)
  app.use('/api/metrics',         requireAuth, requireAdmin, require('./routes/metrics')({ metricsService }));

  // Hooks: admin-only (Fase 6)
  app.use('/api/hooks',           requireAuth, requireAdmin, require('./routes/hooks')({ hooksRepo, hookRegistry, hookLoader }));

  // SystemConfig: admin-only. Permite setear OAuth creds y otros settings globales
  // sin .env (crítico para la versión instalable).
  if (systemConfigRepo) {
    app.use('/api/system-config', requireAuth, requireAdmin, require('./routes/system-config')({ systemConfigRepo, logger }));
  }

  // Household: cualquier user activo (Fase B — datos compartidos).
  if (householdRepo) {
    app.use('/api/household', requireAuth, require('./routes/household')({ householdRepo, usersRepo, logger }));
  }

  // Workspaces: admin-only (Fase 8.4 parked → cerrado). Expose workspace_status.
  try {
    const { createContainer } = require('./bootstrap');
    const _c = createContainer();
    if (_c.workspaceRegistry) {
      app.use('/api/workspaces', requireAuth, require('./routes/workspaces')({
        workspaceRegistry: _c.workspaceRegistry, usersRepo, logger,
      }));
    }
  } catch (e) {
    logger.warn('[index] workspaces router no montado:', e.message);
  }

  // User preferences: keybindings, statusline, etc. (Fase 11.3). Solo requireAuth — cada user maneja sus prefs.
  app.use('/api/user-preferences', requireAuth, require('./routes/user-preferences')({ userPreferencesRepo }));

  // MCP OAuth callback per-provider (Fase 11 parked → cerrado).
  // El callback público no requiere auth de usuario — la seguridad viene del `state`.
  if (mcpAuthService) {
    app.use('/api/mcp-auth', require('./routes/mcp-auth')({ mcpAuthService, logger, requireAuth }));
  }

  // Session sharing (Fase 12.4) — gated por flag. El repo siempre existe; las routes solo si SESSION_SHARING_ENABLED=true.
  if (process.env.SESSION_SHARING_ENABLED === 'true' && sharedSessionsRepo) {
    app.use('/api', requireAuth, require('./routes/session-share')({ sharedSessionsRepo, sessionManager, logger }));
  }

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
  setupPtyHandler({ wss, sessionManager, webChannel, allWebClients, startAISession, events, sharedSessionsBroker, logger, authService, usersRepo });

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
