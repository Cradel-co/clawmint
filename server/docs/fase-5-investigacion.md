# Fase 5 — Investigación previa

**Fecha:** 2026-04-18
**Objetivo:** Subagentes tipados (5 built-in hardcoded) + permisos granulares con resolución jerárquica por scope.

## Estado actual de los componentes a tocar

### `core/AgentOrchestrator.js` (165 LOC)

- `delegateTask(workflowId, { targetAgent, task, context }, convSvc)` — crea taskState y llama `convSvc.processMessage({ _isDelegated: true, ... })` línea 98.
- `MAX_DELEGATIONS = 5` hardcoded en módulo, validado en línea 53-55 contra `workflow.delegationCount`.
- **Bug confirmado**: el flag `_isDelegated: true` se pasa pero `ConversationService.processMessage()` lo ignora. Un delegado con `role='coordinator'` recibe `delegate_task` y puede crear workflow nuevo → re-delegación recursiva sin tope real.
- `workflow` es efímero en memoria (Map), cleanup a 5min tras completar.

### `services/ConversationService.js`

- `processMessage(opts)` — línea 293. Firma actual NO contiene `_isDelegated` ni `_delegationDepth`.
- Delegación vía `_processApiProvider` (~línea 344) que no conoce de depth.
- Construcción de `execToolFn` — líneas 789-801:
  - Modo `plan`: wrapper que retorna descripción sin ejecutar.
  - Modo `ask`: wrapper que invoca `onAskPermission(name, args)` antes de `rawExecFn`.
  - Modo `auto`: pasthrough directo.
  - **Lugar correcto para insertar permission gate**: ANTES del wrapper por modo. Orden: `PermissionService.resolve()` → `mode wrapper` → `rawExecFn`.

### `mcp/tools/orchestration.js` (110 LOC)

- 3 tools: `delegate_task`, `ask_agent`, `list_agents` — todas `coordinatorOnly: true`.
- `delegate_task::execute` auto-crea workflow si `!ctx.workflowId` (línea 30-34) — aquí el delegado re-delegaría sin restricción.
- Hoy `ctx.workflowId` **no está seteado** para un delegado → cada delegación recursiva crea workflow nuevo (con `delegationCount=0` → re-delega 5 veces más).

### `mcp/tools/index.js`

- Gate `ADMIN_ONLY_TOOLS` (línea 40-42) + `coordinatorOnly` filter (línea 60-63) + `MCP_DISABLED_TOOLS` env (línea 30-35).
- Función `execute(name, args, ctx)`:
  1. Check disabled → `Error: ... deshabilitada`
  2. Check admin-only + `isAdmin(ctx)` → `Error: ... solo admins`
  3. `await tool.execute(args, ctx)`
- **Lugar alternativo** para permission gate (menos invasivo): dentro de `execute()` entre los checks existentes. Pero el plan dice hacerlo en ConversationService para que el evento `onAskPermission` llegue al canal correcto.

### `mcp/tools/user-sandbox.js`

- `resolveUserId(ctx)` — ctx.userId directo o via `ctx.usersRepo.findByIdentity(channel, chatId)`.
- `isAdmin(ctx)` — `ctx.usersRepo.getById(userId).role === 'admin'`.
- **Reusar en PermissionService**: mismo patrón para resolver role del usuario (necesario para `scope_type='role'`).

### `storage/LimitsRepository.js`

- Patrón de referencia exacto para `PermissionRepository`.
- Schema `limits(id, type, scope, scope_id, max_count, window_ms, enabled, created_at, UNIQUE(type,scope,scope_id))`.
- `resolve(type, context)` itera scopes en orden de prioridad, match exacto, fallback a DEFAULTS.
- **Diferencia clave**: limits no tiene wildcards. Permissions sí — `tool_pattern` con `*`, `pty_*`, `memory_*`.

### `agents.js` / `agents.json`

- Shape actual: `{key, command?, description, prompt?, provider?, role?, userId?}`.
- Solo `role` binario (`'coordinator'` o undefined). No hay `type` ni `maxDelegationDepth`.
- `agents.get(key)`, `agents.list()`, `agents.reload()` — ya en patrón de inyección.
- **No agregamos nuevos campos en esta fase** — los subagent types son ortogonales (se resuelven por tipo y mapean a un agentKey concreto).

### Routes existentes

- Express en `index.js`, montado con `app.use('/api/<res>', requireAuth, router)`.
- Pattern: `routes/<res>.js` exporta `function create<Res>Router({ ...deps }) { return express.Router() }`.
- Middleware global `requireAuth` existe en `middleware/authMiddleware.js`. **`requireAdmin` no existe**; crear.
- Ejemplo de referencia: `routes/agents.js` — GET/POST/PATCH/DELETE con ownership.

### Tests

- Patrón Jest sin supertest. CRUD de repos tested con DB real temporal (ej. `test/tools.tasks.test.js`).
- Para routes, el patrón más cercano: invocar router handlers directamente con mocks o bien un supertest ligero.

## Bugs vivos confirmados

| # | Bug | Fix en Fase 5 |
|---|---|---|
| 1 | `_isDelegated` pasado pero ignorado en `processMessage` | Aceptar en firma + filtrar `coordinatorOnly` tools + validar depth |
| 2 | Delegado con `role=coordinator` + `!ctx.workflowId` → auto-crea workflow nuevo con `delegationCount=0` | Propagar `_delegationDepth` en ctx; `ConversationService` valida tope al entrar |
| 3 | Subagentes sin toolset restringido por intención | `SubagentRegistry` con `allowedToolPatterns` por tipo |
| 4 | Sin reglas granulares `(scope, tool) → action` | `PermissionService` + `PermissionRepository` con scope priority |

## Decisiones tomadas (confirmadas con el usuario)

- **Tipos hardcoded** en `core/SubagentRegistry.js`. Inmutables.
- **Default policy `auto`** cuando no hay reglas que matcheen.
- **Flag `PERMISSIONS_ENABLED=false`** default → `resolve()` retorna `'auto'` siempre. Fase mergeable con cero cambio observable.

## Archivos a crear (resumen)

- `core/SubagentRegistry.js`, `core/SubagentResolver.js`, `core/PermissionService.js`
- `storage/PermissionRepository.js`
- `middleware/requireAdmin.js`
- `routes/permissions.js`
- 5 tests: `subagent-registry`, `subagent-resolver`, `permission-repository`, `permission-service`, `routes.permissions`

## Archivos a modificar (resumen)

- `core/AgentOrchestrator.js` — `delegateTask` acepta `subagentType` + propaga `_delegationDepth`
- `services/ConversationService.js` — firma `_isDelegated`/`_delegationDepth`, permission gate, filtra coordinatorOnly si delegado
- `mcp/tools/orchestration.js` — acepta `subagent_type` en `delegate_task`, lee `ctx._delegationDepth`, nueva tool `list_subagent_types`
- `bootstrap.js` — instanciar repo + service + inyectar
- `index.js` — montar `/api/permissions` router

## Plan de test transversal

1. `PERMISSIONS_ENABLED=false` → comportamiento idéntico a hoy. Tests Fases 0-4 siguen verdes.
2. Flip a `true` con tabla vacía → resolve retorna `'auto'` para todo → igual.
3. Regla `{scope:'chat', scope_id:'X', tool_pattern:'bash', action:'deny'}` → en chat X, bash rechazado.
4. Regla `{scope:'global', action:'ask', tool_pattern:'write_file'}` → prompt al usuario en todos los chats.
5. Delegación `subagent_type:'explore'` → toolset concreto sin `write_file`.
6. `explore` intenta re-delegar → rechazo por `maxDelegationDepth=0`.
