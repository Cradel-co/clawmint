'use strict';

/**
 * HookRegistry — registry central de hooks (handlers que se ejecutan en eventos).
 *
 * NO conoce de executors específicos (shell/http/skill/js). Los executors se
 * registran via `registerExecutor(type, executor)`. El registry dispatcha cada
 * hook a su executor según `handler_type`.
 *
 * Eventos soportados (exportados como HOOK_EVENTS):
 *   - pre_tool_use / post_tool_use
 *   - user_prompt_submit / assistant_response
 *   - session_start / session_end
 *   - pre_compact / post_compact
 *   - tool_error
 *   - permission_decided
 *   - subagent_start / subagent_stop    — ciclo de vida de subagentes delegados
 *   - task_created / task_completed     — cambios de estado en tareas persistentes
 *   - instructions_loaded               — se cargó CLAUDE.md/GLOBAL.md/AGENTS.md en systemPrompt
 *
 * Scopes (orden de ejecución de más específico a más general):
 *   chat > user > agent > channel > global
 *
 * Por scope, las rules se ordenan por `priority` descendente (100=first, 0=last).
 *
 * Handler result shape:
 *   { block: 'razón' }           — abortar la acción, devolver la razón al caller
 *   { replace: { args: ... } }   — reemplazar los args del pre-hook (solo si scope=global|user)
 *   null/undefined               — continuar, sin cambios
 *
 * Errores de handlers (throw, timeout, exit != 0) NO bloquean la cadena.
 * Se emite `hook:error` al eventBus y se pasa al siguiente handler.
 *
 * Flag `HOOKS_ENABLED=false` (default) → `emit()` retorna `{block: false}` sin invocar handlers.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

const HOOK_EVENTS = Object.freeze({
  PRE_TOOL_USE:       'pre_tool_use',
  POST_TOOL_USE:      'post_tool_use',
  USER_PROMPT_SUBMIT: 'user_prompt_submit',
  ASSISTANT_RESPONSE: 'assistant_response',
  SESSION_START:      'session_start',
  SESSION_END:        'session_end',
  PRE_COMPACT:        'pre_compact',
  POST_COMPACT:       'post_compact',
  TOOL_ERROR:         'tool_error',
  PROVIDER_ERROR:     'provider_error',   // Ajuste 6.7 — errores del LLM provider (distinto de tool_error)
  PERMISSION_DECIDED: 'permission_decided',
  CHAT_PARAMS:        'chat.params',      // Ajuste 6.6 — mutar temperature/topP/topK/maxTokens antes del provider
  SUBAGENT_START:     'subagent_start',   // A1 — antes de delegateTask
  SUBAGENT_STOP:      'subagent_stop',    // A1 — tras delegateTask (done|failed|cancelled)
  TASK_CREATED:       'task_created',     // A1 — repo.create() exitoso en tasks.js
  TASK_COMPLETED:     'task_completed',   // A1 — status→completed en tasks.js
  INSTRUCTIONS_LOADED:'instructions_loaded', // A2 — InstructionsLoader cargó CLAUDE.md/GLOBAL.md/AGENTS.md
});

const SCOPE_PRIORITY = ['chat', 'user', 'agent', 'channel', 'global'];
const MUTATION_ALLOWED_SCOPES = new Set(['global', 'user']);

class HookRegistry {
  /**
   * @param {object} deps
   * @param {object} [deps.eventBus]       — para emitir `hook:error`, `hook:blocked`, `hook:reloaded`
   * @param {object} [deps.logger]
   * @param {object} [deps.metricsService] — opcional, para instrumentación directa (MetricsBridge ya escucha events)
   * @param {boolean} [deps.enabled]       — si se omite, lee HOOKS_ENABLED env
   */
  constructor({ eventBus = null, logger = console, metricsService = null, enabled } = {}) {
    this._bus = eventBus;
    this._logger = logger;
    this._metrics = metricsService;
    this._enabled = typeof enabled === 'boolean' ? enabled : process.env.HOOKS_ENABLED === 'true';

    /** @type {Map<string, object>} handlerType → executor */
    this._executors = new Map();

    /** @type {Map<string, Array<Hook>>} event → array de hooks */
    this._hooks = new Map();

    this._nextId = 1;
  }

  get enabled() { return this._enabled; }
  setEnabled(v) { this._enabled = !!v; }

  // ── Executors ─────────────────────────────────────────────────────────

  /**
   * Registra un executor para un tipo de handler. Los executors implementan:
   *   async execute(hook, payload, { timeoutMs }) → { block?, replace?, error? }
   */
  registerExecutor(type, executor) {
    if (!type || typeof type !== 'string') throw new Error('type requerido');
    if (!executor || typeof executor.execute !== 'function') {
      throw new Error(`executor "${type}" debe tener método .execute(hook, payload, opts)`);
    }
    this._executors.set(type, executor);
  }

  getExecutor(type) { return this._executors.get(type); }
  listExecutorTypes() { return Array.from(this._executors.keys()); }

  // ── Hook registration ─────────────────────────────────────────────────

  /**
   * Registra un hook en memoria.
   * @param {object} opts
   * @param {string} opts.event            — uno de HOOK_EVENTS
   * @param {string} opts.handlerType      — debe estar registrado como executor
   * @param {*} opts.handlerRef            — path del script / url / slug / function
   * @param {string} [opts.scopeType='global'] — global|chat|user|agent|channel
   * @param {string} [opts.scopeId=null]
   * @param {number} [opts.priority=50]    — 0..100
   * @param {number} [opts.timeoutMs]      — override del default 10s
   * @param {boolean} [opts.enabled=true]
   * @param {string} [opts.id]             — auto-gen si se omite
   * @returns {string} id del hook registrado
   */
  register(opts) {
    if (!opts || !opts.event) throw new Error('event requerido');
    if (!Object.values(HOOK_EVENTS).includes(opts.event)) {
      throw new Error(`event inválido: ${opts.event}`);
    }
    if (!opts.handlerType) throw new Error('handlerType requerido');
    if (!this._executors.has(opts.handlerType)) {
      throw new Error(`executor "${opts.handlerType}" no registrado. Tipos disponibles: ${this.listExecutorTypes().join(', ')}`);
    }

    const hook = {
      id:          opts.id || `hook-${this._nextId++}`,
      event:       opts.event,
      handlerType: opts.handlerType,
      handlerRef:  opts.handlerRef,
      scopeType:   opts.scopeType || 'global',
      scopeId:     opts.scopeId || null,
      priority:    Number.isFinite(opts.priority) ? opts.priority : 50,
      timeoutMs:   Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
      enabled:     opts.enabled !== false,
    };

    if (!this._hooks.has(hook.event)) this._hooks.set(hook.event, []);
    this._hooks.get(hook.event).push(hook);
    return hook.id;
  }

  unregister(id) {
    for (const [event, arr] of this._hooks) {
      const idx = arr.findIndex(h => h.id === id);
      if (idx !== -1) {
        arr.splice(idx, 1);
        if (!arr.length) this._hooks.delete(event);
        return true;
      }
    }
    return false;
  }

  clear() {
    this._hooks.clear();
  }

  listForEvent(event) {
    return (this._hooks.get(event) || []).slice();
  }

  /**
   * Fase 7.5.9 — true si hay hooks activos aplicables al ctx.
   * Usado por ConversationService para skip del bloque de instrucciones de hooks
   * en el system prompt cuando no hay hooks (ahorra tokens).
   * @param {object} [ctx]  — {chatId, userId, agentKey, channel}
   * @returns {boolean}
   */
  hasActiveHooks(ctx = {}) {
    if (!this._enabled) return false;
    if (this._hooks.size === 0) return false;
    for (const hooks of this._hooks.values()) {
      for (const h of hooks) {
        if (h.enabled && _scopeMatches(h, ctx)) return true;
      }
    }
    return false;
  }

  // ── Dispatch ──────────────────────────────────────────────────────────

  /**
   * Emite un evento y corre los handlers aplicables al scope.
   *
   * Handler result shape:
   *   { block: 'razón' }                 → aborta cadena
   *   { replace: { args: {...} } }       → muta args (pre_tool_use)
   *   { replace: { params: {...} } }     → muta params (chat.params)
   *   { replace: { <cualquier_campo>: ... } } → muta ese campo del payload
   *
   * @param {string} event
   * @param {object} payload
   * @param {object} [ctx]  — {chatId, userId, agentKey, channel} para filtrado de scope
   * @returns {Promise<{ block: false | string, args: object, params: object, payload: object }>}
   */
  async emit(event, payload, ctx = {}) {
    const initialPayload = payload && typeof payload === 'object' ? { ...payload } : {};
    if (!this._enabled) {
      return { block: false, args: initialPayload.args, params: initialPayload.params, payload: initialPayload };
    }

    const hooks = this._hooks.get(event) || [];
    if (!hooks.length) {
      return { block: false, args: initialPayload.args, params: initialPayload.params, payload: initialPayload };
    }

    // Filtrar por scope aplicable
    const applicable = hooks.filter(h => h.enabled && _scopeMatches(h, ctx));
    if (!applicable.length) {
      return { block: false, args: initialPayload.args, params: initialPayload.params, payload: initialPayload };
    }

    // Orden: scope más específico primero (chat > user > agent > channel > global);
    // dentro del mismo scope, priority desc.
    applicable.sort((a, b) => {
      const sa = SCOPE_PRIORITY.indexOf(a.scopeType);
      const sb = SCOPE_PRIORITY.indexOf(b.scopeType);
      if (sa !== sb) return sa - sb; // chat(0) antes de global(4)
      return b.priority - a.priority;
    });

    let currentPayload = initialPayload;

    for (const hook of applicable) {
      const startedAt = Date.now();
      let result = null;
      let hookError = null;
      try {
        const executor = this._executors.get(hook.handlerType);
        if (!executor) throw new Error(`executor "${hook.handlerType}" no disponible`);

        result = await _withTimeout(
          executor.execute(hook, currentPayload, { ctx }),
          hook.timeoutMs,
          `hook ${hook.id}`
        );
      } catch (err) {
        hookError = err;
      }
      const durationMs = Date.now() - startedAt;

      if (hookError) {
        this._emit('hook:error', {
          hookId: hook.id, event, handlerType: hook.handlerType,
          error: hookError.message, durationMs,
        });
        this._logger.warn && this._logger.warn(`[HookRegistry] hook ${hook.id} falló: ${hookError.message}`);
        continue; // error no bloquea cadena
      }

      if (!result || typeof result !== 'object') continue;

      if (result.block) {
        this._emit('hook:blocked', {
          hookId: hook.id, event, reason: String(result.block), durationMs,
        });
        return { block: String(result.block), args: currentPayload.args, params: currentPayload.params, payload: currentPayload };
      }

      if (result.replace && typeof result.replace === 'object') {
        // Enforcement: replace solo si scope es global o user (mutación controlada)
        if (MUTATION_ALLOWED_SCOPES.has(hook.scopeType)) {
          // Semántica: cada campo de `replace` reemplaza COMPLETAMENTE ese campo del payload.
          // Si un handler quiere preservar otros subcampos de un objeto (ej. params.topP),
          // debe incluirlos explícitamente en su replace.
          // Este comportamiento es predecible y consistente para args, params, y cualquier otro campo.
          currentPayload = { ...currentPayload, ...result.replace };
        } else {
          this._logger.warn && this._logger.warn(`[HookRegistry] hook ${hook.id} intentó replace en scope "${hook.scopeType}"; ignorado. Solo global|user pueden mutar.`);
        }
      }
    }

    return { block: false, args: currentPayload.args, params: currentPayload.params, payload: currentPayload };
  }

  _emit(eventName, payload) {
    if (this._bus && typeof this._bus.emit === 'function') {
      try { this._bus.emit(eventName, payload); } catch { /* no bloquear */ }
    }
  }
}

// ── Internos ────────────────────────────────────────────────────────────

function _scopeMatches(hook, ctx) {
  if (hook.scopeType === 'global') return true;
  if (!ctx) return false;
  switch (hook.scopeType) {
    case 'chat':    return hook.scopeId === String(ctx.chatId || '');
    case 'user':    return hook.scopeId === String(ctx.userId || '');
    case 'agent':   return hook.scopeId === String(ctx.agentKey || '');
    case 'channel': return hook.scopeId === String(ctx.channel || '');
    default: return false;
  }
}

function _withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${label} (${ms}ms)`)), ms);
    if (t.unref) t.unref();
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

HookRegistry.HOOK_EVENTS = HOOK_EVENTS;
HookRegistry.DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
HookRegistry._internal = { _scopeMatches, _withTimeout };
module.exports = HookRegistry;
