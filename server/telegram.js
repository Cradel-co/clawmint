'use strict';

/**
 * telegram.js — re-export de compatibilidad.
 *
 * Instancia TelegramChannel con los módulos legacy (singletons) e
 * expone la misma API pública que tenía el BotManager original.
 * Fase 1–3 del refactoring: este archivo puede eliminarse en Fase 4
 * cuando index.js importe TelegramChannel directamente desde bootstrap.js.
 */

const path = require('path');

const { TelegramChannel }      = require('./channels/telegram/TelegramChannel');
const BotsRepository           = require('./storage/BotsRepository');
const ChatSettingsRepository   = require('./storage/ChatSettingsRepository');

// ── Cargar deps legacy ────────────────────────────────────────────────────────

const sessionManager = require('./sessionManager');
const agentsModule   = require('./agents');
const skillsModule   = require('./skills');
const memoryModule   = require('./memory');
const remindersModule = require('./reminders');
const events         = require('./events');
const { httpsDownload, transcribe } = require('./transcriber');
const transcriber    = { httpsDownload, transcribe };

let providersModule, providerConfig;
try { providersModule = require('./providers');     } catch {}
try { providerConfig  = require('./provider-config'); } catch {}

let consolidator = null;
try { consolidator = require('./memory-consolidator'); } catch {}

// ── Repos de storage ─────────────────────────────────────────────────────────

const botsRepo = new BotsRepository(path.join(__dirname, 'bots.json'));

const chatSettingsRepo = new ChatSettingsRepository(memoryModule.getDB());
chatSettingsRepo.init();

// ── Singleton ─────────────────────────────────────────────────────────────────

const manager = new TelegramChannel({
  botsRepo,
  chatSettingsRepo,
  sessionManager,
  agents:        agentsModule,
  skills:        skillsModule,
  memory:        memoryModule,
  reminders:     remindersModule,
  mcps:          null,   // lazy: se inyecta abajo
  consolidator,
  providers:     providersModule || null,
  providerConfig: providerConfig || null,
  eventBus:      events,
  transcriber,
  logger:        console,
});

// Lazy-load mcps
try {
  const mcpsModule = require('./mcps');
  manager._mcps = mcpsModule;
} catch {}

// ── Exports con la misma firma que antes ─────────────────────────────────────

module.exports = {
  loadAndStart:   () => manager.loadAndStart(),

  addBot:         (key, token) => manager.addBot(key, token),
  removeBot:      (key)        => manager.removeBot(key),
  startBot:       (key)        => manager.startBot(key),
  stopBot:        (key)        => manager.stopBot(key),

  listBots:       ()           => manager.listBots(),
  getBot:         (key)        => manager.getBot(key),

  setBotAgent:    (key, agentKey) => manager.setBotAgent(key, agentKey),
  saveBots:       ()           => manager.saveBots(),

  linkSession:    (key, chatId, sessionId) => manager.linkSession(key, chatId, sessionId),
  disconnectChat: (key, chatId)            => manager.disconnectChat(key, chatId),
};
