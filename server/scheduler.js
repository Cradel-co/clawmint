'use strict';

const fs   = require('fs');
const path = require('path');
const cronParser = require('./utils/cron-parser');

const TICK_INTERVAL_MS    = 30_000; // 30 segundos
const MAX_ACTIONS_PER_TICK = 10;   // límite de acciones por tick para evitar bloqueo
const REMINDERS_FILE      = path.join(__dirname, 'reminders.json');

/**
 * Scheduler — motor de ejecución de acciones programadas.
 *
 * Loop cada 30s: busca acciones cuyo next_run_at ya pasó y las ejecuta.
 * Soporta notificaciones (texto directo) y ai_task (despierta al agente).
 * Entrega cross-channel con cola de pending para canales desconectados.
 */
class Scheduler {
  constructor({ actionsRepo, pendingRepo, usersRepo, convSvc, chatSettingsRepo, botsRepo, agents, logger }) {
    this._actionsRepo  = actionsRepo;
    this._pendingRepo  = pendingRepo;
    this._usersRepo    = usersRepo;
    this._convSvc      = convSvc;
    this._chatSettings = chatSettingsRepo || null;
    this._botsRepo     = botsRepo || null;
    this._agents       = agents || null;
    this._logger       = logger || console;

    this._telegramChannel = null;
    this._webChannel      = null;
    this._interval        = null;
  }

  // ── Setters lazy (resuelven dependencia circular) ──────────────────────────

  setTelegramChannel(tc) { this._telegramChannel = tc; }
  setWebChannel(wc)      { this._webChannel = wc; }

  /**
   * Obtiene el agente por defecto global (persistido en SQLite).
   * Fallback: primer agente disponible, o 'claude'.
   */
  getDefaultAgent() {
    // 1. Desde global_settings en DB — validar que exista
    if (this._chatSettings && this._agents) {
      const saved = this._chatSettings.getGlobal('default_agent');
      if (saved && this._agents.get(saved)) return saved;
    }
    // 2. Primer agente disponible
    if (this._agents) {
      const list = this._agents.list();
      if (list.length && list[0].key) return list[0].key;
    }
    // 3. Fallback final
    return 'claude';
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start() {
    this._migrateReminders();
    // Catch-up: ejecutar once pasados, recalcular cron pasados
    this._catchUp();
    // Iniciar loop
    this._interval = setInterval(() => this._tick(), TICK_INTERVAL_MS);
    this._interval.unref();
    // Tick inmediato para procesar pendientes al arrancar
    this._tick();
    this._logger.info('[Scheduler] Iniciado (interval: 30s)');
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._logger.info('[Scheduler] Detenido');
  }

  // ── API pública (para MCP tools) ──────────────────────────────────────────

  create(creatorId, params) {
    return this._actionsRepo.create({ creator_id: creatorId, ...params });
  }

  list(creatorId) {
    return this._actionsRepo.listByCreator(creatorId);
  }

  listAll(limit = 0) {
    return this._actionsRepo.listActive(limit);
  }

  cancel(actionId) {
    return this._actionsRepo.remove(actionId);
  }

  update(actionId, fields) {
    return this._actionsRepo.update(actionId, fields);
  }

  getById(actionId) {
    return this._actionsRepo.getById(actionId);
  }

  // ── Entrega de pendientes (llamado al reconectarse un cliente) ────────────

  async deliverPending(channel, identifier) {
    if (!this._pendingRepo) return;
    const pending = this._pendingRepo.getPending(channel, String(identifier));
    for (const p of pending) {
      try {
        const content = typeof p.content === 'object' ? p.content : { text: p.content };
        await this._sendToChannel(channel, identifier, p.bot_key, content.text);
        this._pendingRepo.markDelivered(p.id);
      } catch (err) {
        this._logger.warn(`[Scheduler] Error entregando pendiente ${p.id}:`, err.message);
      }
    }
  }

  // ── Core loop ─────────────────────────────────────────────────────────────

  async _tick() {
    // Lock para evitar ejecución concurrente si un tick tarda >30s
    if (this._ticking) return;
    this._ticking = true;
    try {
      const now = Date.now();
      const triggered = this._actionsRepo.getTriggered(now).slice(0, MAX_ACTIONS_PER_TICK);

      for (const action of triggered) {
        try {
          await this._executeAction(action);
        } catch (err) {
          this._logger.error(`[Scheduler] Error ejecutando acción ${action.id}:`, err.message);
          this._actionsRepo.markFailed(action.id, err.message);
        }
      }

      // Limpieza periódica de entregas antiguas (cada ~100 ticks ≈ 50 min)
      if (Math.random() < 0.01 && this._pendingRepo) {
        this._pendingRepo.cleanup();
      }
    } catch (err) {
      this._logger.error('[Scheduler] Error en _tick:', err.message);
    } finally {
      this._ticking = false;
    }
  }

  async _executeAction(action) {
    const targets = this._resolveTargetUsers(action);

    if (action.action_type === 'ai_task') {
      await this._executeAiTask(action, targets);
    } else {
      await this._sendNotification(action, targets);
    }

    // Actualizar estado
    this._actionsRepo.incrementRun(action.id);
    const updatedAction = this._actionsRepo.getById(action.id);

    if (action.trigger_type === 'once' ||
        (updatedAction && updatedAction.max_runs && updatedAction.run_count >= updatedAction.max_runs)) {
      this._actionsRepo.markDone(action.id);
    } else if (action.trigger_type === 'cron' && action.cron_expr) {
      // Recalcular próxima ejecución
      const nextRun = cronParser.getNextRun(action.cron_expr, new Date(), action.timezone);
      if (nextRun) {
        this._actionsRepo.updateNextRun(action.id, nextRun.getTime());
      } else {
        this._actionsRepo.markDone(action.id);
      }
    }
  }

  // ── Resolver destinatarios ────────────────────────────────────────────────

  /**
   * Resuelve target_type a lista de { userId, identities: [{channel, identifier, botKey}] }
   */
  _resolveTargetUsers(action) {
    const targets = [];

    if (action.target_type === 'self') {
      const user = this._usersRepo.getById(action.creator_id);
      if (user) targets.push(user);
    } else if (action.target_type === 'users' && action.target_user_ids) {
      try {
        const ids = JSON.parse(action.target_user_ids);
        for (const id of ids) {
          const user = this._usersRepo.getById(id);
          if (user) targets.push(user);
        }
      } catch { /* invalid JSON */ }
    } else if (action.target_type === 'whitelist' && this._botsRepo) {
      // Obtener whitelist de todos los bots
      const bots = this._botsRepo.read();
      const seenUserIds = new Set();
      for (const bot of bots) {
        for (const chatId of (bot.whitelist || [])) {
          const user = this._usersRepo.findByIdentity('telegram', String(chatId));
          if (user && !seenUserIds.has(user.id)) {
            seenUserIds.add(user.id);
            targets.push(user);
          }
        }
      }
    } else if (action.target_type === 'favorites') {
      // Contactos favoritos del creador que tengan user_id
      const favContacts = this._usersRepo.listContacts(action.creator_id, { favoritesOnly: true });
      for (const contact of favContacts) {
        if (contact.user_id) {
          const user = this._usersRepo.getById(contact.user_id);
          if (user) targets.push(user);
        }
      }
    } else if (action.target_type === 'all') {
      // Todos los usuarios registrados
      return this._usersRepo.listAll();
    }

    return targets;
  }

  // ── Tipos de acción ───────────────────────────────────────────────────────

  async _sendNotification(action, targets) {
    const text = action.payload || action.label;
    const message = `🔔 *${action.label}*\n\n${text !== action.label ? text : ''}`.trim();

    for (const user of targets) {
      for (const identity of (user.identities || [])) {
        await this._deliverToIdentity(action.id, user.id, identity, message);
      }
    }
  }

  async _executeAiTask(action, targets) {
    const prompt = action.payload || action.label;

    // Buscar la identidad principal del creador para contexto
    const creator = this._usersRepo.getById(action.creator_id);
    const creatorIdentity = creator?.identities?.[0];
    if (!creatorIdentity) {
      this._logger.warn(`[Scheduler] ai_task ${action.id}: creador sin identidades`);
      return;
    }

    // Determinar provider y modelo
    const settings = this._chatSettings
      ? this._chatSettings.load(creatorIdentity.bot_key || 'web', creatorIdentity.identifier)
      : null;

    try {
      // Construir info de destinatarios para el prompt
      const targetInfo = targets.map(u => {
        const channels = (u.identities || []).map(i => `${i.channel}:${i.identifier}`).join(', ');
        return `- ${u.name} (${channels})`;
      }).join('\n');

      const enrichedPrompt = [
        `[ACCIÓN PROGRAMADA] ${action.label}`,
        '',
        prompt,
        '',
        `Destinatarios (${targets.length}):`,
        targetInfo,
        '',
        'Ejecutá la tarea y enviá los resultados a cada destinatario usando las herramientas de mensajería disponibles (telegram_send_message, webchat_send_message, etc.).',
      ].join('\n');

      await this._convSvc.processMessage({
        chatId:      creatorIdentity.identifier,
        agentKey:    action.agent_key || this.getDefaultAgent(),
        provider:    action.provider || settings?.provider || 'anthropic',
        model:       action.model || settings?.model || null,
        text:        enrichedPrompt,
        botKey:      creatorIdentity.bot_key || 'web',
        channel:     creatorIdentity.channel,
        claudeMode:  'auto',
      });
    } catch (err) {
      this._logger.error(`[Scheduler] ai_task ${action.id} falló:`, err.message);
      // Fallback: enviar error como notificación al creador
      for (const identity of (creator?.identities || [])) {
        await this._deliverToIdentity(action.id, creator.id, identity,
          `❌ Error ejecutando tarea programada "${action.label}": ${err.message}`);
      }
    }
  }

  // ── Entrega a identidades ─────────────────────────────────────────────────

  async _deliverToIdentity(actionId, userId, identity, text) {
    try {
      const sent = await this._sendToChannel(identity.channel, identity.identifier, identity.bot_key, text);
      if (!sent && this._pendingRepo) {
        // Canal no disponible → encolar
        this._pendingRepo.enqueue({
          action_id:  actionId,
          user_id:    userId,
          channel:    identity.channel,
          identifier: identity.identifier,
          bot_key:    identity.bot_key,
          content:    { text },
        });
      }
    } catch (err) {
      this._logger.warn(`[Scheduler] Error enviando a ${identity.channel}:${identity.identifier}:`, err.message);
      // Encolar en pending
      if (this._pendingRepo) {
        this._pendingRepo.enqueue({
          action_id:  actionId,
          user_id:    userId,
          channel:    identity.channel,
          identifier: identity.identifier,
          bot_key:    identity.bot_key,
          content:    { text },
        });
      }
    }
  }

  /**
   * Envía mensaje a un canal específico. Retorna true si se envió, false si no disponible.
   */
  async _sendToChannel(channel, identifier, botKey, text) {
    if (channel === 'telegram') {
      if (!this._telegramChannel) return false;
      try {
        await this._telegramChannel.send(identifier, text);
        return true;
      } catch {
        return false;
      }
    }

    if (channel === 'web') {
      if (!this._webChannel) return false;
      try {
        return this._webChannel.sendToSession(identifier, text);
      } catch {
        return false;
      }
    }

    if (channel === 'p2p') {
      try {
        const registry = require('./mcp/tools/critter-registry');
        return registry.sendToPeer(identifier, { type: 'output', data: text });
      } catch {
        return false;
      }
    }

    return false;
  }

  // ── Catch-up al reiniciar ─────────────────────────────────────────────────

  _catchUp() {
    const now = Date.now();
    const triggered = this._actionsRepo.getTriggered(now);

    for (const action of triggered) {
      if (action.trigger_type === 'cron') {
        // Cron pasados: no ejecutar, solo recalcular
        const nextRun = cronParser.getNextRun(action.cron_expr, new Date(), action.timezone);
        if (nextRun) {
          this._actionsRepo.updateNextRun(action.id, nextRun.getTime());
        } else {
          this._actionsRepo.markDone(action.id);
        }
      }
      // Once pasados: se ejecutarán en el próximo _tick()
    }
  }

  // ── Migración de reminders.json ───────────────────────────────────────────

  _migrateReminders() {
    try {
      if (!fs.existsSync(REMINDERS_FILE)) return;
      const data = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
      if (!Array.isArray(data) || !data.length) return;

      let migrated = 0;
      for (const r of data) {
        // Buscar o crear usuario para el chatId
        const user = this._usersRepo.getOrCreate('telegram', String(r.chatId), `user_${r.chatId}`, r.botKey);
        if (!user) continue;

        this._actionsRepo.create({
          creator_id:   user.id,
          action_type:  'notification',
          label:        r.text || '⏰ Recordatorio',
          payload:      r.text || '⏰ Recordatorio',
          trigger_type: 'once',
          trigger_at:   r.triggerAt,
          next_run_at:  r.triggerAt,
          max_runs:     1,
        });
        migrated++;
      }

      // Renombrar archivo original
      fs.renameSync(REMINDERS_FILE, REMINDERS_FILE + '.migrated');
      this._logger.info(`[Scheduler] Migrados ${migrated} recordatorios de reminders.json`);
    } catch (err) {
      this._logger.warn('[Scheduler] Error migrando reminders.json:', err.message);
    }
  }
}

module.exports = Scheduler;
