# Fase 6 — Investigación previa

**Fecha:** 2026-04-18
**Objetivo:** sistema de hooks que permita al usuario registrar scripts que corren antes/después de tool-use, con executores pluggables y scope jerárquico.

## Callsites actuales de ejecución de tools

### 1. `services/ConversationService.js` — línea ~769

`rawExecFn` se construye con `mcpExec(name, args, ctx)`. Es el camino **único** para tools API (providers).

Pipeline actual (post-Fase 5):
```
rawExecFn → [permission gate] → [mode wrapper (plan/ask)] → rawExecFn.call → mcp.execute(name, args, ctx)
```

Punto de inyección para hooks:
- `pre_tool_use`: **antes del permission gate** (hook block > permission deny > mode simula > execute)
- `post_tool_use`: **después del result**, antes de devolver al modelo

### 2. `mcp/tools/index.js::execute(name, args, ctx)` — línea ~88

- Gate `MCP_DISABLED_TOOLS`, gate `coordinatorOnly + isDelegated`, gate `allowedToolPatterns`, gate `ADMIN_ONLY_TOOLS + isAdmin`.
- Llama `tool.execute(args, ctx)`.

Este es el caller de bajo nivel. Hooks **NO** se inyectan acá — en ConversationService tenemos el ctx completo (chatId, userId, channel) para resolver scope de hooks correctamente.

### 3. `mcp/router.js` (MCP server externo) — pendiente

Si algún día el server expone MCP HTTP al modelo, habría que inyectar hooks también. Parked.

## Eventos existentes reutilizables

`EventBus` (`core/EventBus.js`) ya emite:
- `loop:*` (LoopRunner) — pre/post stream
- `orchestration:*` — workflows multi-agente
- `skill:invoked` — skill_invoke carga body
- `loop:tool_call`, `loop:tool_result` — antes/después de tool (con payload completo)

**Observación:** `loop:tool_call` + `loop:tool_result` ya son semánticamente "pre/post tool use" a nivel de emisión del provider. Pero son **observables pasivos** — no soportan `block` ni `replace`. Los hooks agregan capacidad de **intervención**.

**Decisión:** NO reutilizar `loop:tool_call/result` para hooks. Son signals de telemetría. Hooks viven en su propio pipeline síncrono (`HookRegistry.emit(event, payload) → Promise<HookResult>`).

## Pipeline completo con hooks

```
1. Modelo emite tool_call (provider) → LoopRunner emite `loop:tool_call` (telemetría)
2. ConversationService::execToolFn invocado con (name, args)
3.   hookRegistry.emit('pre_tool_use', { name, args, ctx })
        → si algún handler retorna { block: reason } → return error al modelo
        → si algún handler retorna { replace: { args: newArgs } } → args = newArgs (aplicado si scope=global|user)
4.   permissionService.resolve(name, ctx) → action
        → deny → return error
        → ask  → onAskPermission o error si canal no soporta
        → auto → continuar
5.   mode wrapper:
        → plan → return simulado
        → execute → mcp.execute(name, finalArgs, ctx)
6.   resultado obtenido
7.   hookRegistry.emit('post_tool_use', { name, args, result, ctx })
        → handlers reciben el resultado; pueden loggear (`audit_log`)
        → NO pueden mutar el resultado (parked para iteración futura)
8. return resultado al LoopRunner → provider → modelo
```

**Regla dura:** permisos tienen palabra final. Si un hook retorna `replace: {args}` pero permisos niegan la tool sobre los args nuevos, la ejecución igual se bloquea.

## Interacción `Permission ↔ Hook` (aclaración)

Q: si hook pre muta args con `replace`, ¿permission evalúa args originales o los nuevos?
**A: los nuevos.** El permission gate se ejecuta **después** del `pre_tool_use`. Los args que ve el modelo (y que se ejecutan) son los mismos que el permission evalúa.

## Diseño modular (revisión 2026-04-18 aplicada)

1. **Plugin pattern para executores**: `HookRegistry` no conoce de executors.
   ```
   hookRegistry.registerExecutor('shell', shellExecutor)
   hookRegistry.registerExecutor('http', httpExecutor)
   ```
2. **`replace: { args }` inmutable** en vez de `mutate`.
3. **Timeout per-hook** (`timeout_ms` en schema). Default 10s; override por regla.
4. **`HookLoader`** carga desde repo al boot; `POST /api/hooks/reload` para hot-reload.
5. **Eventos tipados** exportados como `HOOK_EVENTS` const desde `HookRegistry`.

## Archivos nuevos

- `core/HookRegistry.js` — registry central + dispatch
- `hooks/executors/jsExecutor.js` — handlers JS in-process (tests + built-ins)
- `hooks/executors/shellExecutor.js` — spawn con `shellSandbox`, stdin JSON, stdout JSON
- `hooks/executors/httpExecutor.js` — fetch POST con `ssrfGuard`
- `hooks/executors/skillExecutor.js` — invoca un skill (stub, parked full impl)
- `hooks/builtin/auditLog.js` — log cada tool_use a storage
- `hooks/builtin/blockDangerousBash.js` — bloquea patrones peligrosos
- `storage/HookRepository.js` — schema + CRUD
- `core/HookLoader.js` — carga desde repo al boot
- `routes/hooks.js` — CRUD admin
- `docs/events.md` — agregar `hook:*` events

## Archivos a modificar

- `services/ConversationService.js` — inyectar hookRegistry + pre/post_tool_use al construir execToolFn
- `bootstrap.js` — instanciar HookRegistry, HookRepository, HookLoader, executores, built-ins
- `index.js` — montar `/api/hooks`

## Eventos nuevos `hook:*`

- `hook:error` — handler falló (timeout, throw, non-zero exit) → logged + loop continúa
- `hook:reloaded` — tras `POST /api/hooks/reload`
- `hook:blocked` — algún handler retornó `{ block: reason }` → útil para métricas

Metrics auto-instrumentadas por `MetricsBridge` (Fase 5.5):
- `hook_invocations_total{event, scope, status}` — counter
- `hook_duration_seconds{event, handler_type}` — histograma
- `hook_blocks_total{event, reason}` — counter
- `hook_errors_total{event, handler_type}` — counter

## Tests

- `test/hook-registry.test.js` — register/emit, prioridades, scopes, timeouts, block, replace, handler error no rompe loop.
- `test/hook-executors.test.js` — js, shell (spawn fake con echo), http (mock fetch).
- `test/hook-repository.test.js` — CRUD + filter por event/scope.
- `test/routes.hooks.test.js` — admin only, CRUD handlers directamente.
- `test/hooks-integration.test.js` — ConversationService con hook que bloquea, hook que replace args.

## Flag

```env
HOOKS_ENABLED=false   # default off. Flip true post-validación.
```

Cuando `false`, `HookRegistry.emit` retorna `{ block: false, args }` inmediatamente (no invoca handlers). Fase mergeable con cero cambio observable.
