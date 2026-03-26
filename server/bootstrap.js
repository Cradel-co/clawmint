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
const ConversationService      = require('./services/ConversationService');
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

  const botsRepo = new BotsRepository(path.join(__dirname, 'bots.json'));

  const usersRepo = new UsersRepository(db);
  usersRepo.init();

  const actionsRepo = new ScheduledActionsRepository(db);
  actionsRepo.init();

  const pendingRepo = new PendingDeliveriesRepository(db);
  pendingRepo.init();

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
    scheduler,
  };

  return _container;
}

module.exports = { createContainer };
