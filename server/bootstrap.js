'use strict';

const path = require('path');

/**
 * bootstrap.js — único punto de ensamblado del grafo de dependencias.
 *
 * Crea e inyecta todos los componentes en el orden correcto:
 *   Logger → EventBus → memory (DB) → consolidator
 *   → ChatSettingsRepository → BotsRepository
 *   → ConversationService
 *   → TelegramChannel
 *
 * Idempotente: llamadas posteriores devuelven el mismo container.
 */

const Logger     = require('./core/Logger');
const EventBus   = require('./core/EventBus');

const DatabaseProvider              = require('./storage/DatabaseProvider');
const ChatSettingsRepository        = require('./storage/ChatSettingsRepository');
const WebchatMessagesRepository     = require('./storage/WebchatMessagesRepository');
const BotsRepository                = require('./storage/BotsRepository');
const UsersRepository               = require('./storage/UsersRepository');
const ScheduledActionsRepository    = require('./storage/ScheduledActionsRepository');
const PendingDeliveriesRepository   = require('./storage/PendingDeliveriesRepository');
const LimitsRepository              = require('./storage/LimitsRepository');
const TaskRepository                = require('./storage/TaskRepository');
const PermissionRepository          = require('./storage/PermissionRepository');
const HookRepository                = require('./storage/HookRepository');
const TypedMemoryRepository         = require('./storage/TypedMemoryRepository');
const McpAuthRepository             = require('./storage/McpAuthRepository');
const UserPreferencesRepository     = require('./storage/UserPreferencesRepository');
const SharedSessionsRepository      = require('./storage/SharedSessionsRepository');
const ResumableSessionsRepository   = require('./storage/ResumableSessionsRepository');
const SystemConfigRepository        = require('./storage/SystemConfigRepository');
const InvitationsRepository         = require('./storage/InvitationsRepository');
const HouseholdDataRepository       = require('./storage/HouseholdDataRepository');
const TokenCrypto                   = require('./core/security/tokenCrypto');
const McpAuthService                = require('./services/McpAuthService');
const LocationService               = require('./services/LocationService');
const ConversationService      = require('./services/ConversationService');
const LoopRunner               = require('./core/LoopRunner');
const RetryPolicy              = require('./core/RetryPolicy');
const PermissionService        = require('./core/PermissionService');
const SubagentResolver         = require('./core/SubagentResolver');
const MetricsService           = require('./core/MetricsService');
const MetricsBridge            = require('./core/MetricsBridge');
const StructuredLogger         = require('./core/StructuredLogger');
const HookRegistry             = require('./core/HookRegistry');
const HookLoader               = require('./core/HookLoader');
const JsExecutor               = require('./hooks/executors/jsExecutor');
const ShellExecutor            = require('./hooks/executors/shellExecutor');
const HttpExecutor             = require('./hooks/executors/httpExecutor');
const { auditLogHandler }            = require('./hooks/builtin/auditLog');
const { blockDangerousBashHandler }  = require('./hooks/builtin/blockDangerousBash');
// Fase 7 — compactación + lazy tool loading
const ToolCatalog              = require('./core/ToolCatalog');
const SlidingWindowCompactor   = require('./core/compact/SlidingWindowCompactor');
const MicroCompactor           = require('./core/compact/MicroCompactor');
const ReactiveCompactor        = require('./core/compact/ReactiveCompactor');
const CompactorPipeline        = require('./core/compact/CompactorPipeline');
// Fase 8 — memoria tipada + workspace providers
const TypedMemoryService       = require('./services/TypedMemoryService');
const NullWorkspace            = require('./core/workspace/NullWorkspace');
const GitWorktreeWorkspace     = require('./core/workspace/GitWorktreeWorkspace');
const DockerWorkspace          = require('./core/workspace/DockerWorkspace');
const SSHWorkspace             = require('./core/workspace/SSHWorkspace');
// Fase 9 — tools agénticas
const PlanModeService          = require('./core/PlanModeService');
const JobQuotaService          = require('./core/JobQuotaService');
// Fase 10 — LSP integration
const LSPServerManager         = require('./services/LSPServerManager');
const AuthService              = require('./services/AuthService');
const { TelegramChannel }      = require('./channels/telegram/TelegramChannel');
const WebChannel               = require('./channels/web/WebChannel');
const ClaudePrintSession       = require('./core/ClaudePrintSession');
const Scheduler                = require('./scheduler');

let _container = null;

function createContainer() {
  if (_container) return _container;

  // ── Infraestructura base ──────────────────────────────────────────────────

  const logger   = new Logger();
  const eventBus = new EventBus();

  // ── Observabilidad (Fase 5.5) ────────────────────────────────────────────

  const structuredLogger = new StructuredLogger({ logger, context: { service: 'terminal-live-server' } });
  const metricsService   = new MetricsService();
  const metricsBridge    = new MetricsBridge({ eventBus, metricsService, logger });
  metricsBridge.install();

  // memory.js gestiona su propio DB internamente; obtener la instancia ya creada
  const memoryModule = require('./memory');
  const db = memoryModule.getDB();

  // Consolidador (opcional)
  let consolidator = null;
  try {
    consolidator = require('./memory-consolidator');
    consolidator.init(db);
  } catch (e) {
    logger.warn('memory-consolidator no disponible:', e.message);
  }

  // ── Repositorios de storage ───────────────────────────────────────────────

  const chatSettingsRepo = new ChatSettingsRepository(db);
  chatSettingsRepo.init();

  const messagesRepo = new WebchatMessagesRepository(db);
  messagesRepo.init();

  const { CONFIG_FILES } = require('./paths');
  const botsRepo = new BotsRepository(db, CONFIG_FILES.bots);
  botsRepo.init();

  const usersRepo = new UsersRepository(db);
  usersRepo.init();

  const authService = new AuthService({ db, usersRepo, logger });
  // invitationsRepo se crea más abajo (depende de tokenCrypto/etc); lo inyectamos retroactivamente.
  authService.init();

  const actionsRepo = new ScheduledActionsRepository(db);
  actionsRepo.init();

  const pendingRepo = new PendingDeliveriesRepository(db);
  pendingRepo.init();

  const limitsRepo = new LimitsRepository(db);
  limitsRepo.init();

  const tasksRepo = new TaskRepository(db);
  tasksRepo.init();

  const permissionsRepo = new PermissionRepository(db);
  permissionsRepo.init();
  const permissionService = new PermissionService({ repo: permissionsRepo, usersRepo, logger });

  // Fase 8 — memoria tipada
  const typedMemoryRepo = new TypedMemoryRepository(db);
  typedMemoryRepo.init();
  const typedMemoryService = new TypedMemoryService({ repo: typedMemoryRepo, logger });

  // Fase 8.4 — workspace providers
  // Default global: NullWorkspace. Subagentes code pueden override via SubagentResolver (Fase 5 + 8).
  const nullWorkspace = new NullWorkspace();
  let gitWorktreeWorkspace = null;
  if (process.env.WORKTREES_ENABLED === 'true') {
    try {
      gitWorktreeWorkspace = new GitWorktreeWorkspace({
        repoRoot: process.env.WORKTREES_REPO_ROOT || path.resolve(__dirname, '..'),
        logger,
      });
    } catch (e) {
      logger.warn('[bootstrap] GitWorktreeWorkspace init falló:', e.message);
    }
  }
  // Fase 12.2 — Docker/SSH workspaces (opt-in via WORKSPACE_ADAPTORS_ENABLED)
  let dockerWorkspace = null;
  let sshWorkspace = null;
  if (process.env.WORKSPACE_ADAPTORS_ENABLED === 'true') {
    try { dockerWorkspace = new DockerWorkspace({ logger }); }
    catch (e) { logger.warn('[bootstrap] DockerWorkspace init falló:', e.message); }
    try { sshWorkspace = new SSHWorkspace({ logger }); }
    catch (e) { logger.warn('[bootstrap] SSHWorkspace init falló:', e.message); }
  }

  // Expose a workspaceRegistry pequeño para que SubagentResolver y tools puedan elegir
  const workspaceRegistry = {
    'null': nullWorkspace,
    'git-worktree': gitWorktreeWorkspace, // puede ser null si no activo
    'docker': dockerWorkspace,             // puede ser null si WORKSPACE_ADAPTORS_ENABLED=false
    'ssh': sshWorkspace,                   // idem
  };

  // Fase 11 — MCP OAuth + user preferences
  const mcpAuthRepo = new McpAuthRepository(db);
  mcpAuthRepo.init();
  const tokenCrypto = new TokenCrypto({ logger });
  const mcpAuthService = new McpAuthService({ repo: mcpAuthRepo, crypto: tokenCrypto, eventBus, logger });

  // Repo key/value global para config sin .env (credenciales OAuth, etc.).
  // Usa tokenCrypto para cifrar secrets en disco.
  const systemConfigRepo = new SystemConfigRepository({ db, tokenCrypto, logger });
  systemConfigRepo.init();

  // LocationService: agrega LAN + Tailscale + IP pública + override manual.
  // Inyectado en MCP ctx para tools server_info / server_location / weather_get.
  const locationService = new LocationService({ systemConfigRepo, logger });

  // Invitaciones de un solo uso (onboarding familiar — Fase A).
  const invitationsRepo = new InvitationsRepository(db);
  invitationsRepo.init();
  authService.setInvitationsRepo(invitationsRepo);

  // Datos compartidos del hogar (mercadería, eventos, notas, servicios, inventario — Fase B).
  const householdRepo = new HouseholdDataRepository(db);
  householdRepo.init();

  // Registrar providers OAuth MCP. Leen de systemConfigRepo primero (UI admin)
  // y caen a env vars GOOGLE_CLIENT_ID/etc si están. Funciona instalable sin .env.
  try {
    require('./mcp-oauth-providers').registerAll({ mcpAuthService, systemConfigRepo, logger });
  } catch (e) {
    logger?.warn?.(`[bootstrap] mcp-oauth-providers falló: ${e.message}`);
  }

  const userPreferencesRepo = new UserPreferencesRepository(db);
  userPreferencesRepo.init();

  // Fase 10 — LSP manager (instancia siempre; tools chequean LSP_ENABLED antes de usar)
  const lspServerManager = new LSPServerManager({ logger });
  // Fail-open dinámico: detectar al arranque qué language servers están disponibles.
  // Si LSP_ENABLED=false, saltamos la detección (tools ya devuelven disabled).
  if (process.env.LSP_ENABLED === 'true') {
    lspServerManager.detectAvailableServers().then(results => {
      const avail = Object.entries(results).filter(([, v]) => v).map(([k]) => k);
      logger.info(`[bootstrap] LSP servers disponibles: ${avail.length ? avail.join(', ') : '(ninguno)'}`);
    }).catch(err => logger.warn('[bootstrap] LSP detectAvailable falló:', err.message));
  }

  // Fase 4 extra — resumable sessions (usado por schedule_wakeup)
  const resumableSessionsRepo = new ResumableSessionsRepository(db);
  resumableSessionsRepo.init();

  // Fase 12.4 — session sharing (repo siempre creado; routes + broker sólo si flag)
  const sharedSessionsRepo = new SharedSessionsRepository(db);
  sharedSessionsRepo.init();
  let sharedSessionsBroker = null;
  if (process.env.SESSION_SHARING_ENABLED === 'true') {
    const SharedSessionsBroker = require('./core/SharedSessionsBroker');
    sharedSessionsBroker = new SharedSessionsBroker({ sharedSessionsRepo, eventBus, logger });
  }

  // Fase 9 — plan mode granular + cuotas de crons
  const planModeService = new PlanModeService({ eventBus, logger });
  const jobQuotaService = new JobQuotaService({
    logger,
    getActiveCount: (userId) => {
      try {
        const list = actionsRepo.listByCreator(userId).filter(r => r.trigger_type === 'cron' && r.status === 'active');
        return list.length;
      } catch { return 0; }
    },
  });

  // Hooks (Fase 6) — inicialización + executors + built-ins + carga desde repo
  const hooksRepo = new HookRepository(db);
  hooksRepo.init();
  const hookRegistry = new HookRegistry({ eventBus, metricsService, logger });
  const jsExecutor = new JsExecutor();
  jsExecutor.registerHandler('audit_log', auditLogHandler({ logger }));
  jsExecutor.registerHandler('block_dangerous_bash', blockDangerousBashHandler());
  hookRegistry.registerExecutor('js', jsExecutor);
  hookRegistry.registerExecutor('shell', new ShellExecutor());
  hookRegistry.registerExecutor('http', new HttpExecutor());
  const hookLoader = new HookLoader({ registry: hookRegistry, repo: hooksRepo, logger, eventBus });
  hookLoader.loadAll().catch(e => logger.warn('[bootstrap] hookLoader.loadAll falló:', e.message));

  // A2 — InstructionsLoader: auto-carga CLAUDE.md/GLOBAL.md/AGENTS.md al construir systemPrompt.
  // Flag INSTRUCTIONS_ENABLED=true para activar (default off, no rompe deploys existentes).
  const InstructionsLoader = require('./services/InstructionsLoader');
  const instructionsLoader = new InstructionsLoader({ logger, hookRegistry });

  // ── Singletons de dominio ─────────────────────────────────────────────────

  const sessionManager = require('./sessionManager');
  const agents         = require('./agents');
  const skills         = require('./skills');
  const reminders      = require('./reminders');

  let providers = null, providerConfig = null;
  try { providers     = require('./providers');      } catch {}
  try { providerConfig = require('./provider-config'); } catch {}

  let transcriber = null;
  try {
    transcriber = require('./transcriber');
    transcriber.preload();
  } catch {}

  let tts = { synthesize: async () => null, isEnabled: () => false };
  try {
    const t = require('./tts');
    tts = t;
    if (t.isEnabled()) t.preload();
  } catch {}

  let voiceProviders = null;
  try { voiceProviders = require('./voice-providers'); } catch {}

  let ttsConfig = null;
  try { ttsConfig = require('./tts-config'); } catch {}

  // Preload del voice provider activo (descarga binario + modelo al iniciar)
  if (voiceProviders && ttsConfig && ttsConfig.enabled && ttsConfig.default) {
    try {
      const activeVP = voiceProviders.get(ttsConfig.default);
      if (activeVP && typeof activeVP.preload === 'function') {
        activeVP.preload();
      }
    } catch (e) {
      logger.warn('[bootstrap] voice-provider preload falló:', e.message);
    }
  }

  let mcps = null;
  try { mcps = require('./mcps'); } catch {}

  // Fase 12.3 — wire eventBus al mcp-client-pool para notifications
  try {
    const mcpClientPool = require('./mcp-client-pool');
    if (typeof mcpClientPool.setEventBus === 'function') {
      mcpClientPool.setEventBus(eventBus);
    }
  } catch (e) {
    logger.warn('[bootstrap] mcp-client-pool setEventBus falló:', e.message);
  }

  // ── Nodriza (señalización P2P) ──────────────────────────────────────────────

  let nodriza = null;
  try {
    const nodrizaConfig = require('./nodriza-config');
    if (nodrizaConfig.isEnabled()) {
      const NodrizaConnection = require('./nodriza');
      nodriza = new NodrizaConnection({ logger, nodrizaConfig });
      logger.info('[bootstrap] nodriza habilitada');
    } else {
      logger.info('[bootstrap] nodriza deshabilitada');
    }
  } catch (e) {
    logger.warn('[bootstrap] nodriza no disponible:', e.message);
  }

  // ── LoopRunner (Fase 4) ──────────────────────────────────────────────────
  // Nota: la creación del LoopRunner se mueve después de compactorPipeline (D5)
  // para que el runner pueda invocar compactación reactiva en prompt_too_long.

  const retryPolicy = new RetryPolicy({ maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30_000, jitterMs: 500 });
  const SuspendedPromptsManager = require('./core/SuspendedPromptsManager');
  const suspendedPromptsManager = new SuspendedPromptsManager({ eventBus, logger });

  // ── Fase 7: compactor pipeline + tool catalog ───────────────────────────

  // Summarizer compartido (usado por SlidingWindow y ReactiveCompactor).
  // Fase 7.5.4: routing automático al tier cheap para tareas internas.
  const { resolveModelForTier } = require('./providers/modelTiers');

  async function _defaultSummarize(messages, opts = {}) {
    const providerName = opts.provider || 'anthropic';
    const provider = providers && providers.get(providerName);
    if (!provider || !provider.chat) return '';

    // Tier cheap: el summarize no necesita calidad premium; ahorra ~80% de tokens.
    // Override vía opts.model si el caller lo fuerza; sino resolvemos por tier.
    const cheapModel = opts.model || resolveModelForTier(providerName, 'cheap') || provider.defaultModel;

    const gen = provider.chat({
      systemPrompt: 'Resumí la siguiente conversación preservando decisiones tomadas, archivos modificados, tools usadas y preferencias del usuario. Máximo 500 tokens.',
      history: [...messages, { role: 'user', content: 'Resumí lo anterior en puntos clave.' }],
      apiKey: opts.apiKey,
      model:  cheapModel,
      source: opts.source || 'reactive_compact',   // 7.5.3 TTL 5m para summaries
    });
    let out = '';
    try {
      for await (const ev of gen) {
        if (ev.type === 'text') out += ev.text;
        else if (ev.type === 'done') out = ev.fullText || out;
      }
    } catch { /* summarizer best-effort: no romper turn */ }
    return out;
  }

  const slidingWindowCompactor = new SlidingWindowCompactor({ summarize: _defaultSummarize, logger });
  const microCompactor = new MicroCompactor({
    everyTurns: Number(process.env.MICROCOMPACT_EVERY_TURNS) || 10,
    keepLastK:  Number(process.env.MICROCOMPACT_KEEP_LAST_K) || 4,
  });
  const reactiveCompactor = new ReactiveCompactor({
    microCompactor, summarize: _defaultSummarize, eventBus, logger,
    autocompactBufferTokens: Number(process.env.AUTOCOMPACT_BUFFER_TOKENS) || 13_000,
    maxFailures: Number(process.env.MAX_CONSECUTIVE_COMPACT_FAILURES) || 3,
  });

  // Orden: reactive → micro → sliding. Cada uno respeta sus propios flags; si el
  // flag está off, shouldCompact retorna false y pasa al siguiente.
  const _compactorsEnabledList = [];
  if (process.env.REACTIVE_COMPACT_ENABLED === 'true') _compactorsEnabledList.push(reactiveCompactor);
  if (process.env.MICROCOMPACT_ENABLED === 'true')     _compactorsEnabledList.push(microCompactor);
  _compactorsEnabledList.push(slidingWindowCompactor); // legacy fallback siempre activo (retrocompat)
  const compactorPipeline = new CompactorPipeline({
    compactors: _compactorsEnabledList,
    metricsService, eventBus, logger,
  });

  // D5 — LoopRunner creado DESPUÉS de compactorPipeline para reactive compact
  const loopRunner = new LoopRunner({ eventBus, retryPolicy, hookRegistry, suspendedPromptsManager, compactorPipeline, logger });

  // ToolCatalog — lazy loading de tool schemas
  let _allToolDefs = [];
  try {
    const { getToolDefs } = require('./mcp');
    _allToolDefs = getToolDefs({ agentRole: 'coordinator' });
  } catch (e) {
    logger.warn('[bootstrap] getToolDefs falló:', e.message);
  }
  const toolCatalog = new ToolCatalog({ tools: _allToolDefs });

  // Fase 12.3 — refrescar índice cuando un MCP externo cambia tools
  if (process.env.MCP_SSE_SUBSCRIPTIONS_ENABLED === 'true') {
    eventBus.on('mcp:tools_changed', ({ mcpName }) => {
      try {
        const mcpClientPool = require('./mcp-client-pool');
        const externalDefs = mcpClientPool.getExternalToolDefs();
        for (const def of externalDefs) toolCatalog.register(def);
        logger.info(`[bootstrap] ToolCatalog refrescado tras mcp:tools_changed (${mcpName}, ${externalDefs.length} externas)`);
      } catch (err) {
        logger.warn('[bootstrap] refresh ToolCatalog falló:', err.message);
      }
    });
  }

  // ── ConversationService ───────────────────────────────────────────────────

  const convSvc = new ConversationService({
    sessionManager,
    providers,
    providerConfig,
    memory:  memoryModule,
    agents,
    skills,
    ClaudePrintSession,
    consolidator,
    limitsRepo,
    tasksRepo,
    permissionService,
    hookRegistry,
    compactorPipeline,
    toolCatalog,
    typedMemoryService,
    planModeService,
    jobQuotaService,
    mcpAuthService,
    systemConfigRepo,
    locationService,
    userPreferencesRepo,
    reminders,
    householdRepo,
    lspServerManager,
    resumableSessionsRepo,
    workspaceRegistry,
    loopRunner,
    eventBus,
    instructionsLoader,
    logger,
  });

  // ── TelegramChannel ───────────────────────────────────────────────────────

  const telegramChannel = new TelegramChannel({
    botsRepo,
    chatSettingsRepo,
    convSvc,
    sessionManager,
    agents,
    skills,
    memory:        memoryModule,
    reminders,
    usersRepo,
    mcps,
    consolidator,
    providers,
    providerConfig,
    eventBus,
    transcriber,
    tts,
    voiceProviders,
    ttsConfig,
    logger,
  });

  // ── WebChannel ─────────────────────────────────────────────────────────────

  const TitleGenerator = require('./services/TitleGenerator');
  const titleGenerator = new TitleGenerator({ providers, providerConfig, logger });

  const webChannel = new WebChannel({
    convSvc,
    providers,
    providerConfig,
    agents,
    chatSettingsRepo,
    messagesRepo,
    eventBus,
    logger,
    transcriber,
    tts,
    usersRepo,
    authService,
    titleGenerator,
    // scheduler se inyecta después via setter (dependencia circular)
  });

  // ── Scheduler (acciones programadas) ──────────────────────────────────────

  const scheduler = new Scheduler({
    actionsRepo,
    pendingRepo,
    usersRepo,
    convSvc,
    chatSettingsRepo,
    botsRepo,
    agents,
    resumableSessionsRepo,
    logger,
  });

  // Inicializar default_agent global si no existe
  if (!chatSettingsRepo.getGlobal('default_agent')) {
    const bots = botsRepo.read();
    const defaultFromBot = bots[0]?.defaultAgent;
    const firstAgent = agents.list()[0]?.key;
    chatSettingsRepo.setGlobal('default_agent', defaultFromBot || firstAgent || 'claude');
  }
  scheduler.setTelegramChannel(telegramChannel);
  scheduler.setWebChannel(webChannel);
  webChannel._scheduler = scheduler;  // inyectar scheduler post-creación
  convSvc.setSchedulerDeps({ scheduler, usersRepo });
  scheduler.start();

  // ── Orchestrator (multi-agente) ─────────────────────────────────────────

  const AgentOrchestrator = require('./core/AgentOrchestrator');
  const subagentResolver = new SubagentResolver({ agents, providers, workspaceRegistry });
  const orchestrator = new AgentOrchestrator({ agents, eventBus, logger, subagentResolver, hookRegistry });
  convSvc.setOrchestrator(orchestrator);

  // ── Container ─────────────────────────────────────────────────────────────

  _container = {
    logger,
    eventBus,
    db,
    memory:          memoryModule,
    consolidator,
    chatSettingsRepo,
    botsRepo,
    convSvc,
    telegramChannel,
    webChannel,
    sessionManager,
    agents,
    skills,
    reminders,
    providers,
    providerConfig,
    mcps,
    nodriza,
    transcriber,
    tts,
    voiceProviders,
    ttsConfig,
    usersRepo,
    authService,
    limitsRepo,
    tasksRepo,
    permissionsRepo,
    permissionService,
    loopRunner,
    retryPolicy,
    suspendedPromptsManager,
    subagentResolver,
    scheduler,
    orchestrator,
    metricsService,
    metricsBridge,
    structuredLogger,
    hooksRepo,
    hookRegistry,
    hookLoader,
    instructionsLoader,
    compactorPipeline,
    toolCatalog,
    slidingWindowCompactor,
    microCompactor,
    reactiveCompactor,
    typedMemoryRepo,
    typedMemoryService,
    workspaceRegistry,
    nullWorkspace,
    gitWorktreeWorkspace,
    dockerWorkspace,
    sshWorkspace,
    planModeService,
    jobQuotaService,
    mcpAuthRepo,
    mcpAuthService,
    systemConfigRepo,
    locationService,
    invitationsRepo,
    householdRepo,
    tokenCrypto,
    userPreferencesRepo,
    sharedSessionsRepo,
    sharedSessionsBroker,
    lspServerManager,
    resumableSessionsRepo,
  };

  return _container;
}

module.exports = { createContainer };
