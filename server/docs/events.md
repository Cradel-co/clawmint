# Registro central de eventos

Todos los eventos emitidos por el server via `EventBus`. Los consumidores deben importar los nombres desde el módulo emisor (p.ej. `const { LOOP_EVENTS } = require('./core/LoopRunner')`) en vez de hardcodear strings.

## Convenciones

- Namespace por módulo: `<modulo>:<evento>` (ej. `loop:done`, `orchestration:task`).
- Payload es siempre un objeto plano serializable (sin referencias circulares).
- Campos comunes: `chatId`, `agentKey`, `timestamp` (Date.now()).
- Eventos `*:error` siempre incluyen `error: string` (message) + `code?: string`.

---

## Orden de evaluación en `ConversationService.execToolFn` (Fase 6 invariante)

Cuando el modelo invoca una tool, el pipeline es **estrictamente**:

```
1. hookRegistry.emit('pre_tool_use', { name, args }, ctx)
   - handlers pueden: `block: reason` (aborta) | `replace: { args: newArgs }` (muta args)
   - mutations solo válidas desde scope=global|user; otros scopes se ignoran con warning
   - si hay `block` → devuelve "Herramienta <name> bloqueada por hook: <reason>" al modelo

2. permissionService.resolve(name, permCtx) → 'auto' | 'ask' | 'deny'
   - evalúa contra los args FINALES post-hook-pre (nunca los originales del modelo)
   - 'deny'  → "Herramienta <name> rechazada por política de permisos"
   - 'ask'   → invoca onAskPermission(name, finalArgs); si false → "Herramienta rechazada por el usuario"
   - 'auto'  → continúa

3. mode wrapper (plan simula | ask legacy si !permissions.enabled)

4. mcp.execute(name, finalArgs, ctx) → result

5. hookRegistry.emit('post_tool_use', { name, args, result }, ctx) (solo observación; no muta result)
```

**Invariante no negociable:** `permission` NUNCA ve los args originales del modelo si un hook los modificó. Razón: los hooks son política declarativa que decide la acción real que va a ejecutarse; permission evalúa esa acción real, no la intención original.

**Consecuencia:** un hook con `replace.args` no puede usarse para **saltear permisos** — si el path nuevo está denegado, permission igual bloquea la ejecución.

---

## `loop:*` — LoopRunner (Fase 4)

Exportados como `LOOP_EVENTS` desde `core/LoopRunner.js`.

### `loop:start`
Inicia una iteración del loop agentic.
```ts
{ chatId, agentKey, provider, model, attempt, maxRetries, timestamp }
```

### `loop:text_delta`
Chunk de texto del stream del provider.
```ts
{ chatId, text: string, accumulated: string, timestamp }
```

### `loop:tool_call`
El modelo invocó una tool. Se emite antes de ejecutar.
```ts
{ chatId, agentKey, name: string, args: object, toolCallId?: string, timestamp }
```

### `loop:tool_result`
Resultado de una tool ejecutada.
```ts
{ chatId, agentKey, name: string, result: string, durationMs: number, timestamp }
```

### `loop:retry`
Se dispara antes de reintentar el stream tras error transient.
```ts
{ chatId, attempt: number, delayMs: number, reason: string, timestamp }
```

### `loop:cancel`
Stream cancelado por timeout o signal externo.
```ts
{ chatId, reason: 'timeout' | 'signal' | 'loop_detected', timestamp }
```

### `loop:loop_detected`
3 tool_calls consecutivos idénticos — abort con este evento.
```ts
{ chatId, toolName: string, argsHash: string, consecutiveCount: number, timestamp }
```

### `loop:callback_error`
Un callback del host (`onChunk`, `onStatus`, `onAskPermission`) throweó. El loop continúa.
```ts
{ chatId, callback: 'onChunk'|'onStatus'|'onAskPermission', error: string, timestamp }
```

### `loop:provider_error` (Ajuste 6.7)
El provider LLM dio up tras agotar retries o recibir error permanente. Se emite **en paralelo** al hook `provider_error`. Distinto de `tool_error` (que es error dentro de una tool, no del provider).
```ts
{ chatId, agentKey, provider, model, error: string, attempt: number, reason: string, timestamp }
```

### `loop:done`
Loop terminado (éxito o error final).
```ts
{ chatId, fullText: string, stopReason: 'end_turn'|'max_tokens'|'error'|'cancelled', usage?, usedTools: boolean, timestamp }
```

---

## `orchestration:*` — AgentOrchestrator

Exportados desde `core/AgentOrchestrator.js`. Consumidos por `MetricsBridge` (Fase 5.5) para instrumentar workflows.

### `orchestration:start`
```ts
{ workflowId: string, coordinator: string, chatId: string }
```

### `orchestration:task`
Cambio de estado de una delegación. Incluye `subagentType` cuando la delegación fue por tipo.
```ts
{
  workflowId: string,
  taskId: string,
  agent: string,
  subagentType: string | null,
  description: string,
  status: 'running' | 'done' | 'failed',
}
```

### `orchestration:done`
Workflow completado (manual via `completeWorkflow`). Usado por `MetricsBridge` para medir duración.
```ts
{ workflowId: string, taskCount: number, duration: number }
```

---

## `skill:*` — Skills

Emitidos desde `mcp/tools/skills.js`.

### `skill:invoked`
Un skill fue cargado via `skill_invoke`. Útil para telemetría y futura promoción a system real (Fase 4 LoopRunner podrá escuchar y reposicionar el body como system message).
```ts
{ slug: string, chatId, agentKey, userId }
```

---

## `mcp:*` — MCP pool (reservado Fase 11)

### `mcp:auth_required` (Fase 11)
Un MCP externo requiere OAuth flow.
```ts
{ server: string, authUrl: string, chatId, userId }
```

### `mcp:tool_registered` (futuro)
Una tool externa fue registrada en el pool.
```ts
{ name: string, source: 'internal' | 'mcp:<server>' }
```

---

## Hooks registrados vía `HookRegistry` — eventos observables por handlers

Exportados como `HOOK_EVENTS` desde `core/HookRegistry.js`. Estos NO son eventos del EventBus; son keys que un handler puede suscribirse vía `hookRegistry.register({ event, ... })`.

| Evento | Emitido desde | Payload |
|---|---|---|
| `pre_tool_use` | `ConversationService.execToolFn` antes de ejecutar | `{ name, args, agentKey, userId }` |
| `post_tool_use` | `ConversationService.execToolFn` post-resultado | `{ name, args, result, agentKey, userId }` |
| `user_prompt_submit` | reservado | `{ text, chatId, userId }` |
| `assistant_response` | reservado | `{ text, chatId, agentKey }` |
| `session_start` / `session_end` | reservado | `{ chatId }` |
| `pre_compact` / `post_compact` | reservado Fase 7 | `{ kind, historySize }` |
| `tool_error` | reservado — error dentro de ejecución de tool | `{ name, error, args }` |
| `provider_error` (Ajuste 6.7) | `LoopRunner` cuando retry policy da up | `{ chatId, provider, model, error, attempt, reason }` |
| `permission_decided` | reservado | `{ tool, action, scope }` |
| `chat.params` (Ajuste 6.6) | `ConversationService` antes del provider | `{ params, provider, model, agentKey }`; handler puede `replace.params` para mutar temperature/topP/topK/maxTokens |

## `hook:*` — EventBus events emitidos POR el registry (no keys de suscripción)

### `hook:error` (Fase 6)
Un handler de hook falló.
```ts
{ event: string, handlerId: string, error: string, scope: string }
```

### `hook:reloaded` (Fase 6)
Hooks recargados via hot-reload.
```ts
{ count: number, scope?: string }
```

---

## `cache:*` — Cache de prompt (reservado Fase 7)

### `cache:miss` (Fase 7)
Se esperaba cache hit en Anthropic pero `cache_read_input_tokens === 0`.
```ts
{ chatId, provider, model, cause: 'system_mutated' | 'tools_changed' | 'prefix_changed' | 'unknown' }
```

---

## `plan_mode:*` — Plan mode (reservado Fase 9)

### `plan_mode:timeout` (Fase 9)
`enter_plan_mode` no fue cerrado con `exit_plan_mode` en 5min.
```ts
{ chatId, enteredAt: number }
```

---

## `metrics:*` — MetricsService (Fase 5.5)

`MetricsService` no emite eventos (es pasivo — recibe via `MetricsBridge`). Pero expone un snapshot en:
- `GET /api/metrics` — Prometheus text format (admin-only)
- `GET /api/metrics/json` — snapshot JSON (admin-only)

Métricas instrumentadas automáticamente por `MetricsBridge` a partir de eventos existentes:

| Metric name                                  | Type       | Labels                       | Fuente                  |
|----------------------------------------------|------------|------------------------------|-------------------------|
| `loop_started_total`                         | counter    | provider, attempt            | `loop:start`            |
| `loop_tool_calls_total`                      | counter    | tool                         | `loop:tool_call`        |
| `loop_tool_duration_seconds`                 | histogram  | tool                         | `loop:tool_result`      |
| `loop_retries_total`                         | counter    | reason                       | `loop:retry`            |
| `loop_cancels_total`                         | counter    | reason                       | `loop:cancel`           |
| `loop_loop_detected_total`                   | counter    | tool                         | `loop:loop_detected`    |
| `loop_callback_errors_total`                 | counter    | callback                     | `loop:callback_error`   |
| `loop_done_total`                            | counter    | stop_reason                  | `loop:done`             |
| `loop_duration_seconds`                      | histogram  | stop_reason                  | `loop:start` → `loop:done` |
| `orchestration_workflows_total`              | counter    | coordinator                  | `orchestration:start`   |
| `orchestration_tasks_total`                  | counter    | status, agent                | `orchestration:task`    |
| `orchestration_workflow_duration_seconds`    | histogram  | —                            | `orchestration:start` → `done` |
| `skills_invoked_total`                       | counter    | slug                         | `skill:invoked`         |
| `terminal_live_uptime_seconds`               | gauge      | —                            | built-in                |

## Reglas para agregar eventos nuevos

1. Definir el nombre con namespace (`modulo:evento`).
2. Exportar una constante `const X_EVENTS = { EVENT_A: 'modulo:a', ... }` desde el módulo emisor.
3. Documentar aquí con payload shape.
4. Al menos 1 test que verifique emisión con payload correcto.
5. Evitar payloads con objetos pesados — máximo texto + IDs + metadata.
