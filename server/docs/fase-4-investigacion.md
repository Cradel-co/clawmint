# Fase 4 — Investigación previa

**Fecha:** 2026-04-18
**Objetivo:** extraer la lógica de loop agentic de `ConversationService._processApiProvider` a `core/LoopRunner.js` + sub-módulos, con cancelación real, deep-clone del history, loop detection, y eventos tipados.

## Shape actual de `_processApiProvider`

**Archivo:** `services/ConversationService.js`
**Líneas:** 757–952 (195 LOC)

### Responsabilidades actuales (9 distintas)

1. **Resolve de provider/apiKey/model** (758–761)
2. **Build `execToolFn`** con wrappers por modo `auto|plan|ask` (763–801)
3. **Build system prompt** — tool instructions + memory context + nudge (803–821)
4. **Build user content multimodal** — imágenes por provider (824–847)
5. **Compactar history** (850)
6. **Loop de retries + stream events** ⭐ (862–921) — esto va al LoopRunner
7. **Timeout** — flag `timedOut`, NO aborta stream ⭐ (883, 887)
8. **Extraer memory ops** (925–941)
9. **Return shape** (943–951)

### Bugs vivos confirmados

| # | Bug | Línea | Fix en Fase 4 |
|---|-----|-------|---------------|
| 1 | `timedOut` es flag, no cancela stream → provider sigue corriendo hasta 120s+ | 883, 887 | `AbortController` linkeado al signal pasado al provider |
| 2 | Callbacks `onChunk`/`onStatus` pueden throwear y romper el loop | 893, 897, 919 | `CallbackGuard.wrap()` + emit `loop:callback_error` |
| 3 | `updatedHistory = [...compactedHistory, ...]` shallow — mutación con 2 requests paralelos pisa contexto | 851, 943 | `structuredClone(history)` al entrar al runner |
| 4 | Retry policy entrelazada con loop state — hard de testear | 873–920 | `RetryPolicy.shouldRetry()` aparte |
| 5 | Sin detección de tool calls idénticos consecutivos (modelo puede quedar llamando la misma tool infinitas veces) | — | `LoopDetector` con ring buffer |
| 6 | `onStatus` stream de mensajes como `'thinking'`, `'tool_use'`, `'done'` — no hay schema | 869, 897, 919, 923 | Eventos tipados `LOOP_EVENTS.*` |

### Callsites de callbacks

- `onChunk(accumulated)` — línea 893, solo texto incremental
- `onStatus('thinking')` — línea 869, 919
- `onStatus('tool_use', event.name)` — línea 897
- `onStatus('done')` — línea 923, solo si `usedTools`
- `onAskPermission(name, args)` — línea 797, **async**, bool response

## Provider contract actual (v1)

Los providers exponen `async *chat(args)` que yielda eventos con shape:

```js
{ type: 'text', text: string }
{ type: 'tool_call', name: string, ...tool data }
{ type: 'usage', promptTokens, completionTokens }
{ type: 'done', fullText?: string }
```

El contrato v2 (Anthropic, OpenAI, etc. ya migrados) es compatible pero emite más granular (`text_delta`, `tool_call_start/delta/end`). `legacyShim` los traduce cuando hace falta.

**Decisión Fase 4:** LoopRunner consume el contrato ya normalizado que `_processApiProvider` ya consume (eventos `text`, `tool_call`, `usage`, `done`). No re-diseñar el shape del provider en esta fase.

## Signal y cancelación

Hoy NINGÚN provider recibe `signal` desde `_processApiProvider`. Los providers v2 ya soportan `signal` en sus `clientConfig`, pero el caller no lo pasa. LoopRunner debe:

1. Crear un `AbortController` por intento.
2. Link con signal externo si se pasa (via `linkSignals` en `providers/base/Cancellation.js` — ya existe).
3. Timeout se implementa con `setTimeout` que hace `controller.abort('timeout')`.
4. Pasar `signal` en los `chatArgs` para que el provider lo propague al SDK.

## Archivos nuevos a crear

- `core/RetryPolicy.js` — clasifica errores, calcula backoff
- `core/LoopDetector.js` — detecta tool calls repetidos
- `core/CallbackGuard.js` — envuelve callbacks con try/catch
- `core/LoopRunner.js` — orquesta iteración + retries, usa los anteriores
- `test/retry-policy.test.js`
- `test/loop-detector.test.js`
- `test/callback-guard.test.js`
- `test/loop-runner.test.js`

## Archivos a modificar

- `services/ConversationService.js` — `_processApiProvider` se reduce a ~40 LOC:
  - Build args pre-loop (resp 1–5)
  - `await this._loopRunner.run(loopConfig)`
  - Post-loop (resp 8–9)
- `bootstrap.js` — instanciar `LoopRunner` y pasarlo al `ConversationService`

## Flag de rollout

`USE_LOOP_RUNNER=true` (default). Si `false`, `_processApiProvider` sigue el path legacy intacto. Permite rollback quirúrgico.

## Decisiones de diseño

1. **`structuredClone` al entrar al runner** — no al salir. Así si la llamada falla, el history original del caller no se contamina.
2. **`AbortController` por intento, no compartido** — un retry no cancela al siguiente.
3. **`LoopDetector` con ring buffer de 5** — si 3 consecutivos tienen mismo `{name, argsHash}`, abort con evento `loop:loop_detected`.
4. **`RetryPolicy` retorna `{retry: bool, delayMs: number, reason: string}`** — el runner solo obedece, no clasifica.
5. **`CallbackGuard` emite evento** — nunca propaga la excepción. El host ve `callback_error` en el bus si quiere reaccionar.
6. **`maxToolIters` por agente** — `agentDef.maxToolIters ?? env.MAX_TOOL_ITERS ?? 25`. Se expone en `LoopConfig`.

## Test strategy

- **`RetryPolicy`** — happy (retry transient), no retry on permanent, no retry si `usedTools`, backoff con jitter tope.
- **`LoopDetector`** — happy (3 idénticos), falla por un arg distinto, ring no excede 5.
- **`CallbackGuard`** — happy passthrough, callback throwea → evento emitido + no propaga.
- **`LoopRunner`** — con `fakeProvider` mock:
  - Happy: emite `start/text_delta/done`.
  - Retry transient: dos intentos, segundo ok.
  - No retry post-tool: un solo intento.
  - Abort por timeout: `loop:cancel` con `reason:'timeout'`.
  - Callback que throwea: no rompe loop, emite `callback_error`.
  - 3 tool_calls idénticos: emite `loop:loop_detected`, aborta.
  - `structuredClone` verificado: mutación externa del array no afecta el loop.
