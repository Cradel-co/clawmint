'use strict';

const fs   = require('fs');
const path = require('path');

const BaseChannel          = require('../BaseChannel');
const TelegramBot          = require('./TelegramBot');
const CommandHandler       = require('./CommandHandler');
const CallbackHandler      = require('./CallbackHandler');
const PendingActionHandler = require('./PendingActionHandler');
const MediaHandler         = require('./MediaHandler');
const ResponseRenderer     = require('./ResponseRenderer');
const MessageProcessor     = require('./MessageProcessor');

// ── TelegramChannel (ex BotManager) ──────────────────────────────────────────

class TelegramChannel extends BaseChannel {
  constructor({
    botsFilePath      = null,
    botsRepo          = null,
    chatSettingsRepo  = null,
    convSvc           = null,
    sessionManager    = null,
    agents            = null,
    skills            = null,
    memory            = null,
    reminders         = null,
    usersRepo         = null,
    mcps              = null,
    consolidator      = null,
    providers         = null,
    providerConfig    = null,
    chatSettings      = null,
    eventBus          = null,
    transcriber       = null,
    tts               = null,
    voiceProviders    = null,
    ttsConfig         = null,
    logger            = console,
  } = {}) {
    super({ eventBus, logger });
    this._botsFilePath    = botsFilePath || path.join(__dirname, '../../bots.json');
    this._botsRepo        = botsRepo || null;
    this._convSvc         = convSvc;
    this._sessionManager  = sessionManager;
    this._agents          = agents;
    this._skills          = skills;
    this._memory          = memory;
    this._reminders       = reminders;
    this._usersRepo       = usersRepo;
    this._mcps            = mcps;
    this._consolidator    = consolidator;
    this._providers       = providers;
    this._providerConfig  = providerConfig;
    this._chatSettings    = chatSettingsRepo || chatSettings;
    this._eventBus        = eventBus;
    this._transcriber     = transcriber;
    this._tts             = tts;
    this._voiceProviders  = voiceProviders;
    this._ttsConfig       = ttsConfig;
    this._logger          = logger;

    this._telegramMode    = process.env.TELEGRAM_MODE         || 'polling';
    this._webhookBaseUrl  = process.env.TELEGRAM_WEBHOOK_URL   || '';

    /** @type {Map<string, TelegramBot>} */
    this.bots = new Map();
  }

  _buildBot(key, token, { initialOffset = 0, onOffsetSave = null } = {}) {
    const commandHandler = new CommandHandler({
      agents:        this._agents,
      skills:        this._skills,
      memory:        this._memory,
      reminders:     this._reminders,
      mcps:          this._mcps,
      consolidator:  this._consolidator,
      sessionManager: this._sessionManager,
      providers:     this._providers,
      providerConfig: this._providerConfig,
      chatSettings:  this._chatSettings,
      transcriber:   this._transcriber,
      tts:           this._tts,
      logger:        this._logger,
    });
    const callbackHandler = new CallbackHandler({
      agents:        this._agents,
      skills:        this._skills,
      memory:        this._memory,
      reminders:     this._reminders,
      mcps:          this._mcps,
      consolidator:  this._consolidator,
      providers:     this._providers,
      providerConfig: this._providerConfig,
      chatSettings:  this._chatSettings,
      transcriber:     this._transcriber,
      tts:             this._tts,
      voiceProviders:  this._voiceProviders,
      ttsConfig:       this._ttsConfig,
      logger:          this._logger,
    });
    const pendingHandler = new PendingActionHandler({
      skills: this._skills,
      mcps:   this._mcps,
      logger: this._logger,
    });
    const mediaHandler = new MediaHandler({
      transcriber: this._transcriber,
      logger:      this._logger,
    });
    const responseRenderer = new ResponseRenderer();
    const messageProcessor = new MessageProcessor({
      convSvc:        this._convSvc,
      sessionManager: this._sessionManager,
      agents:         this._agents,
      memory:         this._memory,
      chatSettings:   this._chatSettings,
      tts:            this._tts,
      events:         this._eventBus,
      logger:         this._logger,
    });

    return new TelegramBot(key, token, {
      initialOffset,
      onOffsetSave:     onOffsetSave || (() => this._saveFile()),
      commandHandler,
      callbackHandler,
      pendingHandler,
      mediaHandler,
      responseRenderer,
      messageProcessor,
      convSvc:        this._convSvc,
      sessionManager: this._sessionManager,
      agents:         this._agents,
      memory:         this._memory,
      consolidator:   this._consolidator,
      providers:      this._providers,
      providerConfig: this._providerConfig,
      chatSettings:   this._chatSettings,
      events:         this._eventBus,
      transcriber:    this._transcriber,
      tts:            this._tts,
      usersRepo:      this._usersRepo,
      logger:         this._logger,
    });
  }

  // ── BaseChannel interface ─────────────────────────────────────────────────

  async start()  { return this.loadAndStart(); }

  async stop() {
    await Promise.all([...this.bots.values()].map(b => b.stop().catch(() => {})));
  }

  async send(destination, text) {
    for (const bot of this.bots.values()) {
      if (bot.running) {
        await bot.sendText(Number(destination), text);
        return;
      }
    }
    throw new Error('TelegramChannel: no hay bots en ejecución');
  }

  toJSON() { return { bots: this.listBots() }; }

  // ── Ciclo de vida ─────────────────────────────────────────────────────────

  async loadAndStart() {
    const saved = this._readFile();
    for (const entry of saved) {
      const { key, token, defaultAgent, whitelist, groupWhitelist, rateLimit, rateLimitKeyword, offset, startGreeting, lastGreetingAt } = entry;
      const bot = this._buildBot(key, token, { initialOffset: offset || 0 });
      if (defaultAgent) bot.defaultAgent = defaultAgent;

      const envWhitelist = (process.env.BOT_WHITELIST || '')
        .split(',').map(s => s.trim()).filter(Boolean).map(Number);
      bot.whitelist = envWhitelist.length ? envWhitelist : (whitelist || []);

      const envGroupWhitelist = (process.env.BOT_GROUP_WHITELIST || '')
        .split(',').map(s => s.trim()).filter(Boolean).map(Number);
      bot.groupWhitelist = envGroupWhitelist.length ? envGroupWhitelist : (groupWhitelist || []);

      if (rateLimit        !== undefined) bot.rateLimit = rateLimit;
      if (rateLimitKeyword !== undefined) bot.rateLimitKeyword = rateLimitKeyword;
      if (startGreeting    !== undefined) bot.startGreeting = startGreeting;
      if (lastGreetingAt)  bot.lastGreetingAt = lastGreetingAt;

      this.bots.set(key, bot);
      try {
        if (this._telegramMode === 'webhook') {
          console.log(`[Telegram] Iniciando bot "${key}" en modo webhook`);
          await bot.startWebhook(this._webhookBaseUrl);
        } else {
          console.log(`[Telegram] Iniciando bot "${key}" en modo polling`);
          await bot.start();
        }
      } catch (err) { console.error(`[Telegram] No se pudo iniciar bot "${key}":`, err.message); }
    }

    // Nota: recordatorios ahora gestionados por Scheduler (server/scheduler.js)
  }

  async addBot(key, token) {
    if (this.bots.has(key)) await this.bots.get(key).stop();
    const bot  = this._buildBot(key, token);
    const info = this._telegramMode === 'webhook'
      ? await bot.startWebhook(this._webhookBaseUrl)
      : await bot.start();
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
    return this._telegramMode === 'webhook'
      ? bot.startWebhook(this._webhookBaseUrl)
      : bot.start();
  }

  async stopBot(key) {
    const bot = this.bots.get(key);
    if (!bot) throw new Error(`Bot "${key}" no encontrado`);
    return bot.stop();
  }

  getBot(key)   { return this.bots.get(key); }
  listBots()    { return [...this.bots.values()].map(b => b.toJSON()); }

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

  setBotAgent(key, agentKey) {
    const bot = this.bots.get(key);
    if (!bot) throw new Error(`Bot "${key}" no encontrado`);
    bot.setDefaultAgent(agentKey);
    this._saveFile();
    return bot.toJSON();
  }

  saveBots() { this._saveFile(); }

  // ── Webhook router ────────────────────────────────────────────────────────

  webhookRouter() {
    const router = require('express').Router();
    router.post('/:botKey', (req, res) => {
      const bot = this.bots.get(req.params.botKey);
      if (!bot || !bot.running) return res.sendStatus(404);
      // Process async, respond 200 immediately (Telegram requires fast response)
      bot.handleWebhookUpdate(req.body).catch(err => {
        console.error(`[Telegram:${req.params.botKey}] Webhook error:`, err.message);
      });
      res.sendStatus(200);
    });
    return router;
  }

  // ── Persistencia ─────────────────────────────────────────────────────────

  _readFile() {
    if (this._botsRepo) return this._botsRepo.read();
    try {
      if (fs.existsSync(this._botsFilePath)) {
        return JSON.parse(fs.readFileSync(this._botsFilePath, 'utf8')) || [];
      }
      const token = process.env.BOT_TOKEN;
      if (!token) return [];

      const whitelist = (process.env.BOT_WHITELIST || '')
        .split(',').map(s => s.trim()).filter(Boolean).map(Number);
      const groupWhitelist = (process.env.BOT_GROUP_WHITELIST || '')
        .split(',').map(s => s.trim()).filter(Boolean).map(Number);

      const entry = {
        key:              process.env.BOT_KEY               || 'dev',
        token,
        defaultAgent:     process.env.BOT_DEFAULT_AGENT      || 'claude',
        whitelist,
        groupWhitelist,
        rateLimit:        parseInt(process.env.BOT_RATE_LIMIT) || 30,
        rateLimitKeyword: process.env.BOT_RATE_LIMIT_KEYWORD  || '',
        offset:           0,
      };
      fs.writeFileSync(this._botsFilePath, JSON.stringify([entry], null, 2), 'utf8');
      console.log(`[Telegram] bots.json creado desde variables de entorno (key: ${entry.key})`);
      return [entry];
    } catch { return []; }
  }

  _saveFile() {
    const data = [...this.bots.entries()].map(([key, bot]) => ({
      key,
      token:            bot.token,
      defaultAgent:     bot.defaultAgent,
      whitelist:        bot.whitelist,
      groupWhitelist:   bot.groupWhitelist,
      rateLimit:        bot.rateLimit,
      rateLimitKeyword: bot.rateLimitKeyword,
      startGreeting:    bot.startGreeting,
      lastGreetingAt:   bot.lastGreetingAt,
      offset:           bot.offset,
    }));
    if (this._botsRepo) { this._botsRepo.save(data); return; }
    try {
      fs.writeFileSync(this._botsFilePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[Telegram] No se pudo guardar bots.json:', err.message);
    }
  }
}

module.exports = { TelegramChannel, TelegramBot };
