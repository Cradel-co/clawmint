'use strict';

/**
 * LoopRunner — orquesta una iteración del loop agentic.
 *
 * Responsabilidades:
 *  - Deep-clone del history al entrar (evita race por shallow-copy).
 *  - Construcción de AbortController linkeado a timeout + parent signal.
 *  - Ejecución del stream del provider, normalizando eventos a LOOP_EVENTS.
 *  - Delegación de retries a RetryPolicy.
 *  - Detección de tool-call loops via LoopDetector.
 *  - Envoltura de callbacks externos con CallbackGuard.
 *
 * NO responsabilidades:
 *  - Build del system prompt (lo hace ConversationService).
 *  - Extracción de memory ops (lo hace ConversationService).
 *  - Compactación de history (lo hace ConversationService pre-run).
 *
 * Uso:
 *   const runner = new LoopRunner({ eventBus, retryPolicy, logger });
 *   const result = await runner.run({
 *     chatId, agentKey, provider, model,
 *     chatArgs,                                // systemPrompt, history, apiKey, model, tools, executeTool, ...
 *     provObj,                                 // provider (con .chat(args))
 *     onChunk, onStatus, onAskPermission,      // callbacks opcionales del host
 *     signal,                                  // AbortSignal externo
 *     timeoutMs,                               // default 120s
 *   });
 *   // → { text, usage, stopReason, usedTools, history }
 */

const RetryPolicy     = require('./RetryPolicy');
const LoopDetector    = require('./LoopDetector');
const CallbackGuard   = require('./CallbackGuard');
const { withTimeout, isAborted } = require('../providers/base/Cancellation');

const DEFAULT_TIMEOUT_MS = 120_000;

const LOOP_EVENTS = Object.freeze({
  START:          'loop:start',
  TEXT_DELTA:     'loop:text_delta',
  TOOL_CALL:      'loop:tool_call',
  TOOL_RESULT:    'loop:tool_result',
  RETRY:          'loop:retry',
  CANCEL:         'loop:cancel',
  LOOP_DETECTED:  'loop:loop_detected',
  CALLBACK_ERROR: CallbackGuard.EVENT,
  PROVIDER_ERROR: 'loop:provider_error', // Ajuste 6.7 — provider dio up (post-retries)
  DONE:           'loop:done',
});

class LoopRunner {
  /**
   * @param {object} deps
   * @param {object} [deps.eventBus]      EventBus (opcional pero recomendado)
   * @param {RetryPolicy} [deps.retryPolicy]
   * @param {object} [deps.logger]
   * @param {number} [deps.defaultTimeoutMs=120000]
   */
  constructor({ eventBus = null, retryPolicy = null, hookRegistry = null, suspendedPromptsManager = null, compactorPipeline = null, logger = console, defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this._eventBus = eventBus;
    this._retryPolicy = retryPolicy || new RetryPolicy();
    this._hookRegistry = hookRegistry; // Ajuste 6.7 — emitir hook provider_error
    this._suspendedPrompts = suspendedPromptsManager;
    this._compactorPipeline = compactorPipeline; // D5 — auto-compact reactivo en prompt_too_long
    this._logger = logger;
    this._defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Suspende el loop esperando respuesta del usuario. Fase 4 extra.
   * Delega en SuspendedPromptsManager. El tool `ask_user_question` usa esto.
   *
   * @param {object} opts
   * @param {string} opts.chatId
   * @param {string} opts.question
   * @param {string[]} [opts.options]
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<string>} — answer del usuario
   */
  suspend({ chatId, question, options, timeoutMs } = {}) {
    if (!this._suspendedPrompts) {
      return Promise.reject(new Error('SuspendedPromptsManager no inyectado en LoopRunner'));
    }
    return this._suspendedPrompts.suspend({ chatId, question, options, timeoutMs });
  }

  /**
   * Entrega una respuesta del usuario a un loop suspendido.
   * Usado por ConversationService cuando detecta un mensaje en un chat con
   * suspend pendiente.
   *
   * @returns {boolean} — true si había uno pendiente
   */
  resume(chatId, answer) {
    if (!this._suspendedPrompts) return false;
    return this._suspendedPrompts.resume(chatId, answer);
  }

  hasSuspended(chatId) {
    return !!(this._suspendedPrompts && this._suspendedPrompts.hasPending(chatId));
  }

  /**
   * Ejecuta el loop. Devuelve el resultado final.
   *
   * @param {object} opts
   * @param {string} opts.chatId
   * @param {string} opts.agentKey
   * @param {string} opts.provider
   * @param {string} opts.model
   * @param {object} opts.chatArgs            argumentos para provObj.chat() — incluye history
   * @param {object} opts.provObj             el provider (con async *chat(args))
   * @param {function} [opts.onChunk]         cb(accumulatedText)
   * @param {function} [opts.onStatus]        cb(status, extra?) — 'thinking'|'tool_use'|'done'
   * @param {function} [opts.onAskPermission] async cb(name, args) → boolean
   * @param {AbortSignal} [opts.signal]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxToolIters]      para detectores futuros; no usado directamente acá
   * @returns {Promise<{ text: string, usage?: object, stopReason: string, usedTools: boolean, history: array }>}
   */
  async run(opts) {
    const {
      chatId, agentKey, provider, model,
      chatArgs: rawArgs, provObj,
      onChunk, onStatus, onAskPermission,
      signal,
      timeoutMs = this._defaultTimeoutMs,
    } = opts;

    // Deep clone del history para evitar race por shallow copy
    const chatArgs = this._cloneChatArgs(rawArgs);

    const guard = new CallbackGuard({ eventBus: this._eventBus, chatId });
    const safeOnChunk  = guard.wrap('onChunk', onChunk);
    const safeOnStatus = guard.wrap('onStatus', onStatus);
    // onAskPermission lo envuelve el ConversationService vía execToolFn; acá no se wrapea.
    void onAskPermission;

    const detector = new LoopDetector();
    const maxRetries = this._retryPolicy.maxRetries;

    let accumulated = '';
    let usage = null;
    let stopReason = 'error';
    let usedTools = false;
    let usedToolsEver = false;
    let finalError = null;
    let turnMessages = null; // D2 — propagación de content blocks con thinking/tool_use

    safeOnStatus('thinking');

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Si ya ejecutamos tools, no reintentamos (idempotencia)
      if (attempt > 0 && usedToolsEver) break;

      this._emit(LOOP_EVENTS.START, {
        chatId, agentKey, provider, model, attempt, maxRetries, timestamp: Date.now(),
      });

      accumulated = '';
      usage = null;
      usedTools = false;
      detector.reset();

      const { controller, clear } = withTimeout(timeoutMs, signal);
      const attemptSignal = controller.signal;
      const attemptArgs = { ...chatArgs, signal: attemptSignal };

      let cancelReason = null;
      let loopBroke = false;

      try {
        const gen = provObj.chat(attemptArgs);
        for await (const event of gen) {
          if (attemptSignal.aborted) {
            cancelReason = this._reasonFromAbort(attemptSignal, signal, timeoutMs);
            break;
          }
          const handled = this._handleEvent(event, {
            chatId, agentKey, provider, model, detector,
            onText: (delta) => {
              accumulated += delta;
              safeOnChunk(accumulated);
              this._emit(LOOP_EVENTS.TEXT_DELTA, {
                chatId, text: delta, accumulated, timestamp: Date.now(),
              });
            },
            onToolCall: (name, args, toolCallId) => {
              usedTools = true;
              usedToolsEver = true;
              safeOnStatus('tool_use', name);
              this._emit(LOOP_EVENTS.TOOL_CALL, {
                chatId, agentKey, name, args, toolCallId, timestamp: Date.now(),
              });
            },
            onToolResult: (name, result, durationMs) => {
              this._emit(LOOP_EVENTS.TOOL_RESULT, {
                chatId, agentKey, name, result, durationMs, timestamp: Date.now(),
              });
            },
            onUsage: (u) => { usage = u; },
            onDone: (d) => {
              if (d.fullText) accumulated = d.fullText;
              stopReason = d.stopReason || 'end_turn';
              if (Array.isArray(d.turnMessages)) turnMessages = d.turnMessages; // D2
            },
          });
          if (handled === 'loop_detected') {
            cancelReason = 'loop_detected';
            try { controller.abort(new Error('loop_detected')); } catch {}
            loopBroke = true;
            break;
          }
        }
        if (!cancelReason && !loopBroke) stopReason = stopReason === 'error' ? 'end_turn' : stopReason;
      } catch (err) {
        if (isAborted(attemptSignal)) {
          cancelReason = this._reasonFromAbort(attemptSignal, signal, timeoutMs);
        } else {
          finalError = err;
          accumulated = `Error ${provider}: ${err.message}`;
          stopReason = 'error';
        }
      } finally {
        clear();
      }

      if (cancelReason) {
        this._emit(LOOP_EVENTS.CANCEL, { chatId, reason: cancelReason, timestamp: Date.now() });
        stopReason = 'cancelled';
        accumulated = accumulated || `Error: cancelado (${cancelReason})`;
        break;
      }

      // ¿Retry?
      if (finalError || stopReason === 'error') {
        const decision = this._retryPolicy.shouldRetry({
          errorMessage: accumulated,
          attempt,
          usedTools: usedToolsEver,
        });
        if (decision.retry) {
          this._emit(LOOP_EVENTS.RETRY, {
            chatId, attempt: attempt + 1, delayMs: decision.delayMs, reason: decision.reason, timestamp: Date.now(),
          });
          safeOnStatus('thinking', `reintento ${attempt + 2}/${maxRetries}`);
          finalError = null;

          // D5 — si el error es recoverable (prompt_too_long), compactar history antes del retry
          if (decision.recoverable && this._compactorPipeline && Array.isArray(chatArgs.history)) {
            try {
              safeOnStatus('thinking', 'compactando contexto (prompt_too_long)');
              const res = await this._compactorPipeline.maybeCompact(chatArgs.history, {
                turnCount: chatArgs.history.length,
                historySize: chatArgs.history.length,
                forceReactive: true,
                ctx: { chatId, agentKey, provider, model, source: 'reactive_compact' },
              });
              if (res && Array.isArray(res.history) && res.history.length < chatArgs.history.length) {
                chatArgs.history = res.history;
                this._emit('loop:reactive_compact', {
                  chatId, before: chatArgs.history.length, after: res.history.length,
                  applied: res.applied || 'reactive', timestamp: Date.now(),
                });
                this._logger.warn && this._logger.warn(`[LoopRunner] compactación reactiva aplicada (${res.applied}): ${chatArgs.history.length} msgs`);
              }
            } catch (err) {
              // Circuit open u otro error de compactación → abortar retry
              this._logger.warn && this._logger.warn(`[LoopRunner] compactación reactiva falló: ${err.message}`);
              break;
            }
          }

          await this._sleep(decision.delayMs, attemptSignal);
          continue;
        }
        // No retry → provider dio up. Emitir loop:provider_error (event bus) y hook 'provider_error'
        const errorPayload = {
          chatId, agentKey, provider, model,
          error: accumulated,
          attempt,
          reason: decision.reason,
          timestamp: Date.now(),
        };
        this._emit(LOOP_EVENTS.PROVIDER_ERROR, errorPayload);
        if (this._hookRegistry && this._hookRegistry.enabled) {
          // Fire-and-forget; no puede bloquear la respuesta. Cualquier error de hook se loguea adentro.
          try {
            await this._hookRegistry.emit('provider_error', errorPayload, { chatId, agentKey });
          } catch { /* no-op */ }
        }
        break;
      }

      // Éxito normal
      break;
    }

    if (usedTools) safeOnStatus('done');

    const result = {
      text: accumulated,
      usage,
      stopReason,
      usedTools: usedToolsEver,
      history: chatArgs.history,
      turnMessages, // D2
    };

    this._emit(LOOP_EVENTS.DONE, {
      chatId, fullText: result.text, stopReason, usage, usedTools: usedToolsEver, timestamp: Date.now(),
    });

    return result;
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  _handleEvent(event, handlers) {
    if (!event || typeof event !== 'object') return null;
    switch (event.type) {
      case 'text':
        handlers.onText(event.text || '');
        return 'text';
      case 'text_delta':
        handlers.onText(event.delta || event.text || '');
        return 'text';
      case 'tool_call': {
        const name = event.name || event.tool || 'unknown';
        const args = event.args || event.input || {};
        const r = handlers.detector.track(name, args);
        handlers.onToolCall(name, args, event.toolCallId || event.id);
        if (r.detected) {
          this._emit(LOOP_EVENTS.LOOP_DETECTED, {
            chatId: handlers.chatId, toolName: name, argsHash: r.argsHash, consecutiveCount: r.consecutiveCount, timestamp: Date.now(),
          });
          return 'loop_detected';
        }
        return 'tool_call';
      }
      case 'tool_result':
        handlers.onToolResult(event.name, event.result || '', event.durationMs || 0);
        return 'tool_result';
      case 'usage':
        handlers.onUsage({ promptTokens: event.promptTokens, completionTokens: event.completionTokens });
        return 'usage';
      case 'cache_stats':
        // Fase 7.3 / D9 — cache break detection accionable.
        // El provider marca missExpected cuando se pidió cache (enableCache=true) pero el API
        // no leyó ningún token del cache y creó >= MIN_CACHE_MISS_TOKENS. Indica que el prefix
        // del request cambió respecto al turno anterior — problema de orden de bloques (D3)
        // o invalidación externa.
        if (event.missExpected) {
          const payload = {
            chatId: handlers.chatId, provider: handlers.provider, model: handlers.model,
            creation: event.creation, read: event.read, timestamp: Date.now(),
          };
          this._emit('cache:miss', payload);
          this._emit('cache:miss_unexpected', payload);
          // Log observacional para detectar regresiones de cache hit rate en prod
          if (this._logger && this._logger.warn) {
            this._logger.warn(
              `[LoopRunner] cache miss inesperado chat=${handlers.chatId} provider=${handlers.provider} model=${handlers.model} creation=${event.creation} read=${event.read}`
            );
          }
        }
        this._emit('cache:stats', {
          chatId: handlers.chatId, provider: handlers.provider, model: handlers.model,
          creation: event.creation, read: event.read, missExpected: !!event.missExpected,
          timestamp: Date.now(),
        });
        return 'cache_stats';
      case 'done':
        handlers.onDone({ fullText: event.fullText, stopReason: event.stopReason, turnMessages: event.turnMessages });
        return 'done';
      default:
        return null;
    }
  }

  _cloneChatArgs(args) {
    if (!args) return {};
    const history = Array.isArray(args.history) ? this._safeClone(args.history) : [];
    return { ...args, history };
  }

  _safeClone(x) {
    try { return structuredClone(x); }
    catch { return JSON.parse(JSON.stringify(x)); }
  }

  _reasonFromAbort(attemptSignal, parentSignal, timeoutMs) {
    // Si el parent signal externo abortó, atribuir a signal
    if (parentSignal && parentSignal.aborted) return 'signal';
    // Si el reason del abort menciona timeout
    const r = attemptSignal.reason;
    if (r && typeof r === 'object' && r.message && /timeout/i.test(r.message)) return 'timeout';
    if (typeof r === 'string' && /timeout/i.test(r)) return 'timeout';
    // Default: timeout si hay ms
    return timeoutMs > 0 ? 'timeout' : 'signal';
  }

  _sleep(ms, signal) {
    return new Promise((resolve) => {
      if (!ms || ms <= 0) return resolve();
      const t = setTimeout(resolve, ms);
      if (t.unref) t.unref();
      if (signal && typeof signal.addEventListener === 'function') {
        const onAbort = () => { clearTimeout(t); resolve(); };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  _emit(name, payload) {
    if (!this._eventBus || typeof this._eventBus.emit !== 'function') return;
    try { this._eventBus.emit(name, payload); } catch { /* bus error; no-op */ }
  }
}

LoopRunner.EVENTS = LOOP_EVENTS;
module.exports = LoopRunner;
