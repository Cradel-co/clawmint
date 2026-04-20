'use strict';

/**
 * Anthropic provider v2 — streaming + prompt caching + extended thinking + cancellation.
 *
 * Conserva el contrato v1 OUTWARD (eventos {type: 'text'|'tool_call'|'tool_result'|'usage'|'done'})
 * para no romper ConversationService. Internamente usa `client.messages.stream()` con:
 *   - Streaming real: emite `{type: 'text', text: <chunk>}` por cada text_delta, no al final
 *   - Prompt caching: inyecta cache_control en system y tools cuando `enableCache=true`
 *   - Extended thinking: {type: 'enabled', budget_tokens} cuando `enableThinking` es truthy
 *   - Cancelación: respeta `signal` (AbortSignal) — aborta el stream si se dispara
 *
 * Eventos adicionales emitidos (compatibles con consumidores que los ignoren):
 *   { type: 'cache_stats', creation: N, read: M }
 *   { type: 'thinking', text: <chunk> }  // solo si enableThinking y el caller opta por verlos
 *
 * Gotchas críticos (documentados):
 *   - input_json_delta.partial_json llega FRAGMENTADO; parsear SOLO en content_block_stop
 *   - stop_reason vive en message_delta.delta.stop_reason (no en message_stop)
 *   - Al reenviar history con thinking + tool_use, el bloque `thinking` debe mantenerse en el
 *     assistant turn (la API rechaza si falta) → aquí se pasa todo el content tal cual lo devuelve
 *     finalMessage(), preservando el bloque thinking automáticamente
 */

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const tools = require('../tools');

// D8 — Hash determinista de userId para metadata.user_id.
// Usamos hash en lugar del userId crudo para no filtrar identificadores internos
// a la plataforma Anthropic, pero manteniendo correlation per-user.
function _hashUserId(userId) {
  if (!userId) return undefined;
  return 'u_' + crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16);
}

// D8 — Construye array de beta headers dinámicos según features habilitadas.
// Claude Code real declara betas según los flags activados en la request.
function _buildBetas({ enableCache, enableThinking, contextWindow1M, useToolSearch }) {
  const betas = [];
  if (enableCache) betas.push('prompt-caching-2024-07-31');
  if (enableThinking) betas.push('extended-thinking-2024-10-24');
  if (contextWindow1M) betas.push('context-1m-2024-11');
  if (useToolSearch) betas.push('tool-search-2025-01');
  return betas;
}

// D6 — Whitelist de tools read-only seguras para ejecutar en paralelo.
// Los tools con side effects (write_file, edit_file, bash, git commit/push, telegram_send_*, etc.)
// DEBEN ejecutarse secuencialmente para preservar orden y evitar race conditions.
// Heurística conservadora: solo incluimos lo que claramente no muta estado.
const PARALLEL_SAFE_TOOLS = new Set([
  'read_file', 'list_dir', 'search_files',
  'glob', 'grep',
  'memory_read', 'memory_list',
  'user_info', 'user_list', 'contact_info', 'contact_list',
  'task_get', 'task_list',
  'list_scheduled', 'list_bots',
  'server_info', 'server_location', 'weather_get',
  'sun', 'moon_phase', 'uv_index', 'air_quality', 'holiday_check', 'is_weekend',
  'user_location_get', 'location_get',
  'critter_read_file', 'critter_list_files', 'critter_grep', 'critter_screen_info',
  'critter_clipboard_read', 'critter_status',
  'skill_list',
  'lsp_go_to_definition', 'lsp_find_references', 'lsp_hover',
  'tool_search',
]);

function _isParallelSafe(name, toolDef) {
  if (toolDef && toolDef.parallelSafe === true) return true;
  if (toolDef && toolDef.parallelSafe === false) return false;
  return PARALLEL_SAFE_TOOLS.has(name);
}

// ── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Resuelve max_tokens en base al modelo.
 * Opus 4.6/4.7: 16000 | Sonnet 4.x: 8192 | Haiku: 4096 | default: 4096
 */
function resolveMaxTokens(model, override) {
  if (typeof override === 'number' && override > 0) return override;
  if (!model) return 4096;
  const m = String(model).toLowerCase();
  if (m.includes('opus'))   return 16000;
  if (m.includes('sonnet')) return 8192;
  if (m.includes('haiku'))  return 4096;
  return 4096;
}

/**
 * Fase 7.5.3 — TTL dual: decide si usar 5m o 1h de cache según source del request.
 *
 * - 1h: tareas "main" que se van a reusar muchas veces (main_thread, sdk).
 * - 5m: tareas efímeras que no vale la pena cachear largo (microcompact, session_memory,
 *       prompt_suggestion, consolidator, reactive_compact).
 * - Fallback: 5m (más conservador, menos costo).
 *
 * Callers que quieran 1h deben pasar `source: 'main_thread'` en chatArgs.
 */
const LONG_TTL_SOURCES = new Set(['main_thread', 'sdk']);
const SHORT_TTL_SOURCES = new Set([
  'microcompact', 'micro_compact', 'session_memory',
  'prompt_suggestion', 'consolidator', 'reactive_compact',
  'sliding_window_compact',
]);

function resolveCacheTtl(source) {
  if (!source) return '5m';
  const s = String(source).toLowerCase();
  if (LONG_TTL_SOURCES.has(s)) return '1h';
  if (SHORT_TTL_SOURCES.has(s)) return '5m';
  return '5m';
}

function _cacheControl(ttl) {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

/**
 * Inyecta cache_control en bloques de system prompt.
 *
 * D3 — Soporta estrategia "prefix estable + suffix dinámico":
 *   Si el caller pasa array de bloques con `_cacheable:true`, el cache_control
 *   se pone SOLO en el último bloque marcado cacheable. Así el prefix queda
 *   estable turno a turno y los bloques dinámicos (memoryCtx, toolInstr) que
 *   vienen DESPUÉS no invalidan el hit de cache.
 *
 * Acepta:
 *   - string → si < 1000 chars no cachea (overhead > beneficio); si larger, lo envuelve
 *   - array de bloques sin flags → agrega cache_control al último (comportamiento v1)
 *   - array con `_cacheable` → cache_control al último cacheable, dynamic sin cc
 *
 * @param {string|Array} systemPrompt
 * @param {string} [ttl] — '5m' | '1h' (default '5m')
 */
function applyCacheToSystem(systemPrompt, ttl = '5m') {
  if (!systemPrompt) return undefined;
  const cc = _cacheControl(ttl);
  if (typeof systemPrompt === 'string') {
    if (systemPrompt.length < 1000) return systemPrompt;
    return [{ type: 'text', text: systemPrompt, cache_control: cc }];
  }
  if (Array.isArray(systemPrompt) && systemPrompt.length > 0) {
    // D3 — buscar último bloque marcado cacheable; si existe, ponemos cc allí
    // y strippeamos los flags internos (_cacheable) antes de enviar al API.
    let lastCacheableIdx = -1;
    for (let i = systemPrompt.length - 1; i >= 0; i--) {
      if (systemPrompt[i] && systemPrompt[i]._cacheable) { lastCacheableIdx = i; break; }
    }
    if (lastCacheableIdx >= 0) {
      return systemPrompt.map((b, i) => {
        const clean = { ...b };
        delete clean._cacheable;
        if (i === lastCacheableIdx) clean.cache_control = cc;
        return clean;
      });
    }
    // Sin flags: comportamiento legacy — cache_control en el último bloque
    const copy = systemPrompt.map(b => ({ ...b }));
    copy[copy.length - 1] = { ...copy[copy.length - 1], cache_control: cc };
    return copy;
  }
  return systemPrompt;
}

/**
 * Marca la última tool con cache_control para cachear también las definiciones.
 * @param {Array} toolDefs
 * @param {string} [ttl] — '5m' | '1h' (default '5m')
 */
function applyCacheToTools(toolDefs, ttl = '5m') {
  if (!Array.isArray(toolDefs) || toolDefs.length === 0) return toolDefs;
  const copy = toolDefs.map(t => ({ ...t }));
  copy[copy.length - 1] = { ...copy[copy.length - 1], cache_control: _cacheControl(ttl) };
  return copy;
}

/**
 * Resuelve la configuración de thinking.
 * enableThinking:
 *   - false | undefined → sin thinking
 *   - 'adaptive' → budget escalado según historyTokens (ver _adaptiveBudget)
 *   - 'enabled'  → { type: 'enabled', budget_tokens: thinkingBudget || 1024 }
 *   - number     → { type: 'enabled', budget_tokens: n }     (shorthand)
 *   - true       → igual que 'adaptive'
 *
 * D10 — Guard Haiku: la API rechaza thinking en modelos Haiku. Si el modelo
 * contiene 'haiku', retornamos null forzado.
 *
 * D10 — Budget adaptativo: para 'adaptive' escalamos entre 1024 y 16384 según
 * historyTokens estimados. Más contexto → más budget para razonamiento útil.
 */
function _adaptiveBudget(historyTokens = 0, maxOutputTokens = 16000) {
  // Heurística: ~10% del history en budget de thinking, capado por maxOutputTokens-1
  const base = Math.floor((historyTokens || 0) / 10);
  const budget = Math.min(maxOutputTokens - 1, Math.max(2048, base));
  return budget;
}

function _estimateHistoryTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    if (!m || !m.content) continue;
    if (typeof m.content === 'string') {
      total += Math.ceil(m.content.length / 4);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && typeof b.text === 'string') total += Math.ceil(b.text.length / 4);
        else if (b && typeof b.thinking === 'string') total += Math.ceil(b.thinking.length / 4);
        else if (b && typeof b.content === 'string') total += Math.ceil(b.content.length / 4);
      }
    }
  }
  return total;
}

function resolveThinking(enableThinking, thinkingBudget, opts = {}) {
  if (!enableThinking) return null;
  // D10 — guard Haiku: la API rechaza thinking. Fail-open (devolver null) en lugar de error.
  if (opts.model && /haiku/i.test(String(opts.model))) {
    if (opts.logger && opts.logger.debug) {
      opts.logger.debug(`[anthropic] thinking deshabilitado: modelo ${opts.model} no soporta thinking`);
    }
    return null;
  }
  if (typeof enableThinking === 'number') {
    return { type: 'enabled', budget_tokens: Math.max(1024, enableThinking) };
  }
  if (enableThinking === 'enabled') {
    return { type: 'enabled', budget_tokens: Math.max(1024, thinkingBudget || 1024) };
  }
  // 'adaptive' | true → escalar según longitud del history
  const adaptive = _adaptiveBudget(opts.historyTokens, opts.maxOutputTokens || 16000);
  return { type: 'enabled', budget_tokens: adaptive };
}

// ── Provider v2 ──────────────────────────────────────────────────────────────

module.exports = {
  name: 'anthropic',
  label: 'Anthropic API',
  defaultModel: 'claude-opus-4-6',
  models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],

  /**
   * @param {Object} opts
   * @param {string|Array} opts.systemPrompt
   * @param {Array} opts.history
   * @param {string} opts.apiKey
   * @param {string} [opts.model]
   * @param {number} [opts.maxTokens]
   * @param {Function} [opts.executeTool]
   * @param {string} [opts.channel]
   * @param {string} [opts.agentRole]
   * @param {boolean} [opts.enableCache=false]
   * @param {false|'adaptive'|'enabled'|number|true} [opts.enableThinking=false]
   * @param {number} [opts.thinkingBudget] — solo si enableThinking === 'enabled'
   * @param {AbortSignal} [opts.signal]
   */
  async *chat({
    systemPrompt, history, apiKey, model,
    executeTool: execToolFn, channel, agentRole,
    enableCache = false,
    enableThinking = false,
    thinkingBudget,
    signal,
    maxTokens,
    source,   // Fase 7.5.3: 'main_thread'|'sdk' → TTL 1h; compact/consolidator → TTL 5m
    userId,   // D8 — para metadata.user_id hash
  }) {
    if (!apiKey) {
      yield { type: 'done', fullText: 'Error: API key de Anthropic no configurada. Configurala en el panel ⚙️.' };
      return;
    }

    const client = new Anthropic({ apiKey });
    const toolDefsRaw = tools.toAnthropicFormat({ channel, agentRole });
    const execTool    = execToolFn || tools.executeTool;
    const messages    = Array.isArray(history) ? [...history] : [];
    const initialLen  = messages.length;  // D2 — marcar dónde empezaron los turns de ESTE request
    const usedModel   = model || this.defaultModel;
    const resolvedMaxTokens = resolveMaxTokens(usedModel, maxTokens);
    // D10 — estimar history tokens para adaptive budget + pasar model para guard Haiku
    const historyTokens = _estimateHistoryTokens(messages);
    const thinkingCfg = resolveThinking(enableThinking, thinkingBudget, {
      model: usedModel,
      historyTokens,
      maxOutputTokens: resolvedMaxTokens,
    });

    // Aplicar cache_control si está habilitado (inmutable: no mutar arrays originales)
    // TTL dinámico según source: main_thread/sdk→1h, compact/consolidator→5m, default→5m.
    const ttl = resolveCacheTtl(source);
    const systemParam = enableCache ? applyCacheToSystem(systemPrompt, ttl) : systemPrompt;
    const toolsParam  = enableCache ? applyCacheToTools(toolDefsRaw, ttl) : toolDefsRaw;

    let fullText = '';
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCacheCreation = 0;
    let totalCacheRead = 0;

    while (true) {
      if (signal && signal.aborted) {
        yield { type: 'done', fullText: fullText || 'Cancelado.' };
        return;
      }

      const req = {
        model: usedModel,
        max_tokens: resolvedMaxTokens,
        messages,
      };
      if (systemParam) req.system = systemParam;
      if (toolsParam && toolsParam.length) req.tools = toolsParam;
      if (thinkingCfg) {
        req.thinking = thinkingCfg;
        // thinking requiere temperature=1 (sino la API rechaza)
        req.temperature = 1;
      }
      // D8 — metadata.user_id hash determinista (correlation sin leak de IDs internos)
      const userHash = _hashUserId(userId);
      if (userHash) req.metadata = { user_id: userHash };
      // D8 — betas dinámicos según features activadas
      const contextWindow1M = typeof usedModel === 'string' && /\[1m\]/i.test(usedModel);
      const betas = _buildBetas({ enableCache, enableThinking: !!thinkingCfg, contextWindow1M, useToolSearch: false });
      // Los betas van como header anthropic-beta en options (no en el body req)

      let stream;
      let finalMsg;
      // D7 — Watchdog de stream idle: si no llegan chunks en STREAM_IDLE_TIMEOUT_MS, abort.
      // Protege contra conexiones colgadas que dejan el turn en 120s hasta el global timeout.
      // Default 90s (paridad con Claude Code real); configurable vía CLAUDE_STREAM_IDLE_TIMEOUT_MS.
      const streamIdleMs = Math.max(30_000, Number(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS) || 90_000);
      let idleTimer = null;
      let idleTimedOut = false;
      // Si el caller ya pasó un signal, creamos uno derivado; si no, uno propio.
      const idleController = new AbortController();
      const streamSignal = signal
        ? (AbortSignal.any ? AbortSignal.any([signal, idleController.signal]) : idleController.signal)
        : idleController.signal;
      if (signal && !AbortSignal.any) {
        // Polyfill para Node < 20.3: escuchar parent signal y propagar abort al controller
        const onParentAbort = () => { try { idleController.abort(signal.reason); } catch {} };
        if (signal.aborted) onParentAbort();
        else signal.addEventListener('abort', onParentAbort, { once: true });
      }
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimedOut = true;
          try { idleController.abort(new Error('stream_idle_timeout')); } catch {}
        }, streamIdleMs);
        if (idleTimer.unref) idleTimer.unref();
      };

      try {
        // D8 — headers anthropic-beta dinámicos
        const streamOpts = { signal: streamSignal };
        if (betas.length) {
          streamOpts.headers = { 'anthropic-beta': betas.join(',') };
        }
        stream = client.messages.stream(req, streamOpts);
        resetIdle();

        // Stream de deltas: solo text → yield chunks para el caller
        // Los demás bloques (tool_use, thinking) se ensamblan en finalMessage() al final
        for await (const event of stream) {
          resetIdle(); // D7 — cada chunk resetea el watchdog
          if (streamSignal && streamSignal.aborted) break;

          if (event.type === 'content_block_delta') {
            const d = event.delta;
            if (d && d.type === 'text_delta' && d.text) {
              fullText += d.text;
              yield { type: 'text', text: d.text };
            } else if (d && d.type === 'thinking_delta' && d.thinking) {
              // Opt-in: el caller puede ignorarlo; para debugging es útil
              yield { type: 'thinking', text: d.thinking };
            }
            // input_json_delta se acumula internamente; se parsea en finalMessage()
          }
          // message_delta trae stop_reason + usage; lo procesamos en finalMessage()
          // message_start/stop + content_block_start/stop — no necesarios en este nivel
        }

        finalMsg = await stream.finalMessage();
        if (idleTimer) clearTimeout(idleTimer);
      } catch (err) {
        if (idleTimer) clearTimeout(idleTimer);
        if (idleTimedOut) {
          yield { type: 'done', fullText: fullText || `Error Anthropic: stream idle timeout (${streamIdleMs}ms sin chunks)` };
          return;
        }
        if (signal && signal.aborted) {
          yield { type: 'done', fullText: fullText || 'Cancelado por el usuario.' };
          return;
        }
        yield { type: 'done', fullText: `Error Anthropic: ${err.message}` };
        return;
      }

      // Acumular tokens de la respuesta
      const u = finalMsg && finalMsg.usage;
      if (u) {
        totalPromptTokens     += u.input_tokens  || 0;
        totalCompletionTokens += u.output_tokens || 0;
        totalCacheCreation    += u.cache_creation_input_tokens || 0;
        totalCacheRead        += u.cache_read_input_tokens     || 0;
      }

      // Separar tool_uses del content final
      const content  = (finalMsg && finalMsg.content) || [];
      const toolUses = content.filter(b => b.type === 'tool_use');

      // Fin del turno: sin tool_uses O stop_reason end_turn → emitir usage + done
      if (toolUses.length === 0 || finalMsg.stop_reason === 'end_turn') {
        // D2 — pushear también el último assistant turn al history interno para que
        // `turnMessages` emitido en 'done' incluya el mensaje final con thinking/text/tool_use.
        // Esto permite a ConversationService persistir content arrays completos (no solo string),
        // requeridos por la API cuando thinking está ON en turnos futuros.
        messages.push({ role: 'assistant', content });
        yield { type: 'usage', promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
        if (totalCacheCreation || totalCacheRead) {
          // Fase 7.3 / D9: cache break detection — threshold por TTL.
          // Con TTL 5m (defaults efímeros), prefixes chicos pueden romper sin alarma.
          // Con TTL 1h (main_thread/sdk), invalidaciones valen la pena flaggear antes.
          const MIN_CACHE_MISS_TOKENS_5M = Number(process.env.CACHE_MISS_THRESHOLD_5M) || 2000;
          const MIN_CACHE_MISS_TOKENS_1H = Number(process.env.CACHE_MISS_THRESHOLD_1H) || 5000;
          const threshold = ttl === '1h' ? MIN_CACHE_MISS_TOKENS_1H : MIN_CACHE_MISS_TOKENS_5M;
          const missExpected = enableCache && totalCacheRead === 0 && totalCacheCreation >= threshold;
          yield { type: 'cache_stats', creation: totalCacheCreation, read: totalCacheRead, missExpected, ttl };
        }
        // D2 — turnMessages: todos los mensajes agregados durante ESTE request (assistant+tool_result pairs).
        // ConversationService los usa para reemplazar el último `{role:'assistant', content:string}` por
        // los blocks originales, preservando thinking y tool_use para turns con enableThinking.
        yield { type: 'done', fullText, turnMessages: messages.slice(initialLen) };
        return;
      }

      // Preservar el assistant turn completo (incluye thinking blocks — requerido si thinking estaba ON)
      messages.push({ role: 'assistant', content });

      // D6 — Ejecución híbrida: tools read-only se ejecutan en paralelo con Promise.all,
      // tools con side effects secuencial. Partición preserva orden original en el resultado.
      // Si todas son safe, 100% paralelo. Si alguna no es safe, toda la batch va secuencial
      // (más simple que reorderings parciales y respeta la semántica que el modelo pidió).
      const allSafe = toolUses.every(t => _isParallelSafe(t.name, null));
      const toolResults = [];

      async function _runSingle(toolUse) {
        let result;
        let isError = false;
        try {
          result = await execTool(toolUse.name, toolUse.input || {});
          if (typeof result === 'string' && /^error[\s:]/i.test(result.trim())) {
            isError = true;
          }
        } catch (err) {
          result = `Error ejecutando ${toolUse.name}: ${err.message}`;
          isError = true;
        }
        return { toolUse, result, isError };
      }

      if (allSafe && toolUses.length > 1) {
        // Paralelo: emit tool_call eventos, esperar Promise.all, emit tool_result en orden original
        for (const toolUse of toolUses) {
          yield { type: 'tool_call', name: toolUse.name, args: toolUse.input };
        }
        if (signal && signal.aborted) {
          yield { type: 'done', fullText: fullText || 'Cancelado durante ejecución de tool.' };
          return;
        }
        const parallelResults = await Promise.all(toolUses.map(_runSingle));
        for (const { toolUse, result, isError } of parallelResults) {
          yield { type: 'tool_result', name: toolUse.name, result, isError };
          const block = { type: 'tool_result', tool_use_id: toolUse.id, content: String(result) };
          if (isError) block.is_error = true;
          toolResults.push(block);
        }
      } else {
        // Secuencial: fail-safe para mixed batches o tools con side effects
        for (const toolUse of toolUses) {
          if (signal && signal.aborted) {
            yield { type: 'done', fullText: fullText || 'Cancelado durante ejecución de tool.' };
            return;
          }
          yield { type: 'tool_call', name: toolUse.name, args: toolUse.input };
          const { result, isError } = await _runSingle(toolUse);
          yield { type: 'tool_result', name: toolUse.name, result, isError };
          const block = { type: 'tool_result', tool_use_id: toolUse.id, content: String(result) };
          if (isError) block.is_error = true;
          toolResults.push(block);
        }
      }

      messages.push({ role: 'user', content: toolResults });
      // Continuar loop hasta que no haya tool_uses o se alcance end_turn
    }
  },

  // Exports para tests
  _internal: {
    resolveMaxTokens, applyCacheToSystem, applyCacheToTools,
    resolveThinking, resolveCacheTtl,
    _adaptiveBudget, _estimateHistoryTokens, _hashUserId, _buildBetas, _isParallelSafe,
  },
};
