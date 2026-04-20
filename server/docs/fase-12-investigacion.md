---
fase: 12
fecha: 2026-04-18
autor: Claude Opus 4.7 + Brian
estado: en ejecución
---

# Fase 12 — Plataforma extensible — investigación previa

## Archivos relevantes (shape actual)

### MCP pool y transports
- `mcp-client-pool.js` (320 LOC, raíz):
  - Usa `@modelcontextprotocol/sdk` con `StdioClientTransport`, `SSEClientTransport`, `StreamableHTTPClientTransport` (fallback a SSE).
  - State global de módulo: `_connections`, `_toolRegistry`, `_registered`, `_mcpToolNames`, `_reconnectInFlight`.
  - API: `initialize`, `connectMcp`, `disconnectMcp`, `getExternalToolDefs`, `isExternalTool`, `callTool`, `status`.
  - **Gap detectado**: después de `client.connect(transport)` no se registran handlers de `notifications/*`. El SDK expone `setNotificationHandler(schema, handler)`; sin esto, cambios de tools en runtime se pierden hasta reconnect.
  - **Decisión**: agregar `_wireNotifications(client, mcpName, eventBus)` en `_connect`. Evento emitido: `mcp:tools_changed`. No tocar `_toolRegistry` directamente desde el handler — re-invocar `connectMcp(name)` (idempotente: limpia + recachea tool defs).

### Workspace providers
- `core/workspace/WorkspaceProvider.js` — interface con `acquire(ctx) → { id, cwd, release, meta }`.
- `core/workspace/NullWorkspace.js` — default, devuelve cwd del server.
- `core/workspace/GitWorktreeWorkspace.js` — worktree + branch; fail-open si git no está.
- **Gap**: no hay `DockerWorkspace` ni `SSHWorkspace`. `bootstrap.js::workspaceRegistry` indexa por string (`'null'`, `'git-worktree'`). Agregar `'docker'` + `'ssh'` con el mismo patrón detrás del flag `WORKSPACE_ADAPTORS_ENABLED`.
- **Decisión**: ambos con `failOpen=true`. Docker: validar `docker --version` en constructor; si falla, `acquire` retorna fallback. SSH: `ssh2` package (ya está en deps? verificar) — si no, fallback.

### WebSocket infra (para session sharing)
- `ws/pty-handler.js` — `setupPtyHandler({ wss, sessionManager, webChannel, allWebClients, startAISession, events })`. Tipos de conexión: `listener`, `webchat`, `claude/ai`, default PTY.
- `channels/web/WebChannel.js` — broadcast via `allWebClients` Set.
- `allWebClients` se inyecta desde `index.js` y es un `Set`. No hay routing por session compartida — todos los clients reciben todo.
- **Decisión**: agregar un nuevo tipo `sessionType: 'shared'` con `token`, que filtra mensajes al chat compartido. No tocar el flow existente.

### Repositorios existentes (patrón a clonar)
- `storage/McpAuthRepository.js` (Fase 11) y `storage/UserPreferencesRepository.js` — patrón claro: `constructor(db)`, `init()` con `CREATE TABLE IF NOT EXISTS`, métodos síncronos (sql.js wraps).
- Clonar ese patrón para `SharedSessionsRepository`.

### Routes
- `routes/user-preferences.js`, `routes/sessions.js` — factory pattern `module.exports = ({ dep }) => router`.

### SDK
- No existe `packages/` en el repo. Opciones:
  1. Crear `packages/sdk/` hermano de `server/` — requiere decisión de monorepo (fuera de scope server).
  2. Crear `server/sdk/` con scaffold como referencia — publicable manualmente después.
- **Decisión**: scaffold mínimo en `server/sdk/index.js` + `server/sdk/README.md` sin publicar a npm en esta fase. La API pública ya existe via `/api/*` routes; el SDK es solo sugar sobre HTTP.

## Dependencias del package.json

```
@modelcontextprotocol/sdk  — usado para MCP clients. Ya expone setNotificationHandler.
ws                         — WebSocket server. Reusado para session sharing.
express                    — ya reusado.
better-sqlite3 / sql.js    — DB (via DatabaseProvider).
```

**Falta**: `ssh2` para SSHWorkspace. Agregar lazy require — si no está instalado, SSHWorkspace devuelve fallback con warning. Esto evita hacer npm install obligatorio.

## Bugs preexistentes a cerrar en esta fase

- [ ] `mcp-client-pool.js` no registra notification handlers — cambios de tools requieren disconnect+connect manual.
- [ ] `allWebClients` (en `index.js`) broadcast indiscriminado — cualquier client autenticado ve eventos `telegram:session` de cualquier chat. Fase 12.4 introduce un Set<Token, Set<ws>> para routing por shared session.

## Scope definitivo (confirmación del usuario implícita por "continuemos con el roadmap")

| Sub-fase | Implementar | Parked |
|---|---|---|
| 12.1 SDK | scaffold `server/sdk/*.js` con factory `createClawmintClient` | publish npm, Home Assistant example |
| 12.2 Workspace | `DockerWorkspace` + `SSHWorkspace` (failOpen), wiring bootstrap, tests con mock spawn | tool `workspace_status` admin, GC wiring a scheduler (Fase 8 ya tiene gc() method) |
| 12.3 MCP SSE subscriptions | `setNotificationHandler` wire + re-connect tools + eventBus emission | refetch de resources/prompts (no usados hoy) |
| 12.4 Session sharing | `SharedSessionsRepository` + `routes/session-share.js` + WS routing por token | UI WebChat `?shared=<token>` (frontend fuera de scope server) |

## Flags nuevas

```env
WORKSPACE_ADAPTORS_ENABLED=false
DOCKER_WORKSPACE_IMAGE=clawmint/sandbox:latest
SSH_WORKSPACE_HOST=
SSH_WORKSPACE_USER=
SSH_WORKSPACE_KEY_PATH=
MCP_SSE_SUBSCRIPTIONS_ENABLED=false
SESSION_SHARING_ENABLED=false
SESSION_SHARE_TOKEN_TTL_HOURS=24
```

## Tests plan

- `test/mcp-sse-subscriptions.test.js` — MCP con notification handler fake → verificar eventBus emission + refetch.
- `test/workspace-docker.test.js` — mock `spawnSync`/`spawn`, verify container lifecycle (create → cwd → release).
- `test/workspace-ssh.test.js` — mock `ssh2` Client, verificar exec → release.
- `test/shared-sessions.test.js` — CRUD + TTL expiration + permission checks.
- `test/routes.session-share.test.js` — admin + non-admin paths.

## Orden de ejecución

1. 12.3 MCP SSE (toca `mcp-client-pool.js`, cambio quirúrgico).
2. 12.2 Workspace adaptors (Docker + SSH + wiring bootstrap).
3. 12.4 Session sharing (repo + route + WS handler).
4. 12.1 SDK scaffold (última, es sugar sobre lo ya expuesto).
5. ROADMAP update.
