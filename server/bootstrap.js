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

const DatabaseProvider         = require('./storage/DatabaseProvider');
const ChatSettingsRepository   = require('./storage/ChatSettingsRepository');
const BotsRepository           = require('./storage/BotsRepository');
const ConversationService      = require('./services/ConversationService');
const { TelegramChannel }      = require('./channels/telegram/TelegramChannel');
const WebChannel               = require('./channels/web/WebChannel');
const ClaudePrintSession       = require('./core/ClaudePrintSession');

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

  const botsRepo = new BotsRepository(path.join(__dirname, 'bots.json'));

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
    eventBus,
    logger,
    transcriber,
    tts,
  });

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
    transcriber,
    tts,
    voiceProviders,
    ttsConfig,
  };

  return _container;
}

module.exports = { createContainer };
