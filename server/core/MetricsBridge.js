'use strict';

/**
 * MetricsBridge — conecta EventBus con MetricsService.
 *
 * Escucha eventos de los módulos (loop:*, orchestration:*, skill:*) y
 * actualiza counters/histogramas automáticamente. De esta forma, los
 * emisores no conocen de metrics (separación de concerns).
 *
 * Diseño: observer pattern. Bridge se instala al boot y suscribe listeners.
 * Los módulos solo emiten sus eventos como ya hacen.
 */

const LOOP_EVENTS = {
  START:          'loop:start',
  TEXT_DELTA:     'loop:text_delta',
  TOOL_CALL:      'loop:tool_call',
  TOOL_RESULT:    'loop:tool_result',
  RETRY:          'loop:retry',
  CANCEL:         'loop:cancel',
  LOOP_DETECTED:  'loop:loop_detected',
  CALLBACK_ERROR: 'loop:callback_error',
  DONE:           'loop:done',
};

const ORCHESTRATION_EVENTS = {
  START: 'orchestration:start',
  TASK:  'orchestration:task',
  DONE:  'orchestration:done',
};

const SKILL_EVENTS = {
  INVOKED: 'skill:invoked',
};

// Fase 7.5.10 — token economy events
const COMPACT_EVENTS = {
  APPLIED:       'compact:applied',
  CIRCUIT_OPEN:  'compact:circuit_open',
};

const CACHE_EVENTS = {
  MISS:  'cache:miss',
  STATS: 'cache:stats',
};

const PLAN_MODE_EVENTS = {
  ENTER:   'plan_mode:enter',
  EXIT:    'plan_mode:exit',
  TIMEOUT: 'plan_mode:timeout',
};

const NOTIFICATION_EVENTS = {
  PUSH: 'notification:push',
};

class MetricsBridge {
  /**
   * @param {object} deps
   * @param {object} deps.eventBus        — EventEmitter del server
   * @param {object} deps.metricsService
   * @param {object} [deps.logger]
   */
  constructor({ eventBus, metricsService, logger = console }) {
    if (!eventBus) throw new Error('MetricsBridge: eventBus requerido');
    if (!metricsService) throw new Error('MetricsBridge: metricsService requerido');
    this._bus = eventBus;
    this._m = metricsService;
    this._logger = logger;
    this._unsubs = [];
    this._pendingLoops = new Map(); // chatId → startTimestamp (para medir duración)
  }

  install() {
    this._registerMetrics();
    this._attachLoopListeners();
    this._attachOrchestrationListeners();
    this._attachSkillListeners();
    this._attachCompactListeners();    // Fase 7.5.10
    this._attachCacheListeners();      // Fase 7.5.10
    this._attachPlanModeListeners();   // Fase 9
    this._attachNotificationListeners(); // Fase 9
    this._logger.info(`[MetricsBridge] instalado (metrics.enabled=${this._m.enabled})`);
  }

  uninstall() {
    for (const u of this._unsubs) { try { u(); } catch {} }
    this._unsubs = [];
  }

  _on(event, handler) {
    const wrapped = (p) => {
      try { handler(p); }
      catch (err) { this._logger.warn && this._logger.warn(`[MetricsBridge] handler de "${event}" falló:`, err.message); }
    };
    this._bus.on(event, wrapped);
    this._unsubs.push(() => this._bus.removeListener(event, wrapped));
  }

  // ── Registro de metrics (con HELP para /metrics) ───────────────────────

  _registerMetrics() {
    const m = this._m;
    m.registerCounter('loop_started_total', 'Total de iteraciones del loop iniciadas');
    m.registerCounter('loop_retries_total', 'Total de retries del loop (con reason)');
    m.registerCounter('loop_cancels_total', 'Total de cancelaciones del loop (timeout/signal/loop_detected)');
    m.registerCounter('loop_tool_calls_total', 'Total de tool_calls emitidos por providers');
    m.registerCounter('loop_callback_errors_total', 'Callbacks del host que throwearon');
    m.registerCounter('loop_loop_detected_total', 'Loops infinitos de tool_call detectados');
    m.registerCounter('loop_done_total', 'Loops completados (con stopReason)');
    m.registerHistogram('loop_duration_seconds', 'Duración end-to-end del loop', [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120]);
    m.registerHistogram('loop_tool_duration_seconds', 'Duración de ejecución de tools', [0.01, 0.05, 0.1, 0.5, 1, 5, 30]);

    m.registerCounter('orchestration_workflows_total', 'Workflows multi-agente creados');
    m.registerCounter('orchestration_tasks_total', 'Tareas delegadas (con status y agent)');
    m.registerHistogram('orchestration_workflow_duration_seconds', 'Duración de workflows', [1, 5, 10, 30, 60, 300]);

    m.registerCounter('skills_invoked_total', 'Skills cargados via skill_invoke');

    // Fase 7.5.10 — token economy
    m.registerCounter('compact_applied_total', 'Compactaciones aplicadas por estrategia');
    m.registerCounter('compact_circuit_open_total', 'Circuit breaker abierto en compactación');
    m.registerCounter('cache_miss_total', 'Cache misses inesperados por provider');
    m.registerHistogram('cache_read_tokens', 'Tokens leídos de cache por response', [100, 500, 1000, 5000, 10000, 50000, 100000]);
    m.registerCounter('plan_mode_enter_total', 'Entradas a plan mode');
    m.registerCounter('plan_mode_exit_total', 'Salidas de plan mode (manual o timeout)');
    m.registerCounter('notifications_push_total', 'Notificaciones push emitidas');
  }

  // ── Loop events ────────────────────────────────────────────────────────

  _attachLoopListeners() {
    this._on(LOOP_EVENTS.START, (p) => {
      this._m.inc('loop_started_total', { provider: p?.provider || 'unknown', attempt: String(p?.attempt ?? 0) });
      if (p?.chatId) this._pendingLoops.set(p.chatId, Date.now());
    });

    this._on(LOOP_EVENTS.TOOL_CALL, (p) => {
      this._m.inc('loop_tool_calls_total', { tool: p?.name || 'unknown' });
    });

    this._on(LOOP_EVENTS.TOOL_RESULT, (p) => {
      if (typeof p?.durationMs === 'number') {
        this._m.observe('loop_tool_duration_seconds', p.durationMs / 1000, { tool: p.name || 'unknown' });
      }
    });

    this._on(LOOP_EVENTS.RETRY, (p) => {
      this._m.inc('loop_retries_total', { reason: p?.reason || 'unknown' });
    });

    this._on(LOOP_EVENTS.CANCEL, (p) => {
      this._m.inc('loop_cancels_total', { reason: p?.reason || 'unknown' });
    });

    this._on(LOOP_EVENTS.LOOP_DETECTED, (p) => {
      this._m.inc('loop_loop_detected_total', { tool: p?.toolName || 'unknown' });
    });

    this._on(LOOP_EVENTS.CALLBACK_ERROR, (p) => {
      this._m.inc('loop_callback_errors_total', { callback: p?.callback || 'unknown' });
    });

    this._on(LOOP_EVENTS.DONE, (p) => {
      this._m.inc('loop_done_total', { stop_reason: p?.stopReason || 'unknown' });
      if (p?.chatId) {
        const start = this._pendingLoops.get(p.chatId);
        if (start) {
          this._m.observe('loop_duration_seconds', (Date.now() - start) / 1000, {
            stop_reason: p?.stopReason || 'unknown',
          });
          this._pendingLoops.delete(p.chatId);
        }
      }
    });
  }

  // ── Orchestration events ───────────────────────────────────────────────

  _attachOrchestrationListeners() {
    const workflowStarts = new Map();

    this._on(ORCHESTRATION_EVENTS.START, (p) => {
      this._m.inc('orchestration_workflows_total', { coordinator: p?.coordinator || 'unknown' });
      if (p?.workflowId) workflowStarts.set(p.workflowId, Date.now());
    });

    this._on(ORCHESTRATION_EVENTS.TASK, (p) => {
      this._m.inc('orchestration_tasks_total', {
        status: p?.status || 'unknown',
        agent:  p?.agent || 'unknown',
      });
    });

    this._on(ORCHESTRATION_EVENTS.DONE, (p) => {
      if (p?.workflowId) {
        const start = workflowStarts.get(p.workflowId);
        if (start) {
          this._m.observe('orchestration_workflow_duration_seconds', (Date.now() - start) / 1000);
          workflowStarts.delete(p.workflowId);
        }
      }
    });
  }

  _attachSkillListeners() {
    this._on(SKILL_EVENTS.INVOKED, (p) => {
      this._m.inc('skills_invoked_total', { slug: p?.slug || 'unknown' });
    });
  }

  // ── Fase 7.5.10 — Compact events ────────────────────────────────────────

  _attachCompactListeners() {
    this._on(COMPACT_EVENTS.APPLIED, (p) => {
      this._m.inc('compact_applied_total', { compactor: p?.compactor || 'unknown' });
    });
    this._on(COMPACT_EVENTS.CIRCUIT_OPEN, (p) => {
      this._m.inc('compact_circuit_open_total', { chatId: p?.chatId || 'unknown' });
    });
  }

  // ── Fase 7.5.10 — Cache events ──────────────────────────────────────────

  _attachCacheListeners() {
    this._on(CACHE_EVENTS.MISS, (p) => {
      this._m.inc('cache_miss_total', { provider: p?.provider || 'unknown' });
    });
    this._on(CACHE_EVENTS.STATS, (p) => {
      if (typeof p?.read === 'number') {
        this._m.observe('cache_read_tokens', p.read, {});
      }
    });
  }

  // ── Fase 9 — PlanMode events ────────────────────────────────────────────

  _attachPlanModeListeners() {
    this._on(PLAN_MODE_EVENTS.ENTER, () => this._m.inc('plan_mode_enter_total'));
    this._on(PLAN_MODE_EVENTS.EXIT, () => this._m.inc('plan_mode_exit_total', { reason: 'manual' }));
    this._on(PLAN_MODE_EVENTS.TIMEOUT, () => this._m.inc('plan_mode_exit_total', { reason: 'timeout' }));
  }

  // ── Fase 9 — Notifications ──────────────────────────────────────────────

  _attachNotificationListeners() {
    this._on(NOTIFICATION_EVENTS.PUSH, (p) => {
      this._m.inc('notifications_push_total', { channel: p?.channel || 'unknown', urgent: String(!!p?.urgent) });
    });
  }
}

MetricsBridge.LOOP_EVENTS = LOOP_EVENTS;
MetricsBridge.ORCHESTRATION_EVENTS = ORCHESTRATION_EVENTS;
MetricsBridge.SKILL_EVENTS = SKILL_EVENTS;
MetricsBridge.COMPACT_EVENTS = COMPACT_EVENTS;
MetricsBridge.CACHE_EVENTS = CACHE_EVENTS;
MetricsBridge.PLAN_MODE_EVENTS = PLAN_MODE_EVENTS;
MetricsBridge.NOTIFICATION_EVENTS = NOTIFICATION_EVENTS;
module.exports = MetricsBridge;
