# Fase 11 — Investigación previa

**Fecha:** 2026-04-18
**Alcance:** MCP OAuth estandarizado + slash commands middleware + keybindings.

## Estado actual relevante

### `mcp-client-pool.js`

- Soporta transports `stdio` y `SSEClientTransport` (SSE ya listo para Fase 12).
- **No tiene mecanismo de OAuth flow interactivo**: si un MCP requiere auth (ej. Gmail), la conexión falla silenciosamente.
- Conexiones reconnect con backoff (`_reconnectInFlight` Map). Infraestructura razonable para agregar flow OAuth encima.
- Tool registry namespaced con `mcpName__toolName` (doble underscore).

### `routes/mcps.js`

Post Fase 5.75 tiene admin gate (`requireAdmin`). CRUD completo: GET/POST/PATCH/DELETE/sync. Shape de MCP config en `mcps.js`:

```js
{
  name, type: 'stdio'|'sse', command?, args?, url?, headers?, env?, enabled
}
```

### `skills.js`

- `listSkills()` retorna metadata (name + description) desde `skills/<slug>/SKILL.md`.
- `parseFrontmatter(content)` extrae el `---` YAML-lite.
- `buildAgentPrompt(agentDef)` con flag `SKILLS_EAGER_LOAD` (default false) inyecta solo índice.
- Fase 3 tool `skill_invoke(slug)` permite invocación dinámica via MCP.
- **Sin concepto de slash commands**: hoy el modelo invoca skills con `skill_invoke`, el usuario escribe el slug como parte del texto.

### Parsing en canales

`channels/telegram/CommandHandler.js` parsea `/` commands (`/help`, `/skills`, `/buscar-skill`, etc.) — comandos del harness, **no** skills. Son dos sistemas separados:
- **Commands de canal**: `/help`, `/skills` → UI del bot
- **Skills del modelo**: `skill_invoke('review')` → modelo las invoca como tools

**Fase 11.2 objetivo**: permitir que el **usuario** invoque un skill con `/slug` desde cualquier canal, inyectando el body como `<system-reminder>` al próximo turn del modelo.

## Diseño modular aplicado (revisión 2026-04-18 + brief)

### 11.1 MCP OAuth

**Decisión arquitectónica**:
- **NO implementar el OAuth2 flow completo del lado server** (callback, code exchange). Eso es 1-2 días de trabajo por provider y hoy ya tenemos `server/services/OAuthService.js` para Google custom que funciona para esos casos.
- **SÍ hacer la infraestructura genérica**: tabla de tokens cifrados, evento `mcp:auth_required`, tools `mcp_authenticate` + `mcp_complete_authentication`. Los MCPs externos que implementan el standard `authenticate` del protocolo MCP podrán usarlos.

**Cifrado de tokens**:
- Derivar clave via `scrypt` desde una master-key en env (`MCP_TOKEN_ENCRYPTION_KEY`). Si no existe, generar random al primer boot y persistir en file con permissions 600.
- Los tokens se almacenan en tabla `mcp_auth(id, mcp_name, user_id, encrypted_token, expires_at, created_at, updated_at)` con UNIQUE(mcp_name, user_id).

**Eventos**:
- `mcp:auth_required` — payload `{server, url, chatId, userId}` emitido al EventBus cuando una herramienta MCP retorna 401/auth_required. Canales suscritos muestran la URL al usuario.
- `mcp:auth_completed` — cuando el token se persiste exitosamente.

### 11.2 Slash commands middleware

**Implementación central en `ConversationService.processMessage`**:
```js
// Al recibir text, si empieza con ^/\w+
// 1. Parse slug + resto del texto
// 2. Si es un skill existente → inyectar body en contextText + strip /slug
// 3. Llamar al loop normal con el contextText enriquecido
```

**Ventajas**:
- Una impl para todos los canales (telegram/webchat/p2p).
- No toca CommandHandler (que sigue manejando `/help`, `/skills` etc.).
- Comandos de canal tienen prioridad: si `CommandHandler` reconoce `/cmd` lo consume; sino pasa a `processMessage` donde Fase 11.2 lo intercepta como skill.

**Compat**: si el slug no existe como skill, el `/slug` se pasa al modelo tal cual (el modelo decide qué hacer). No rompe comportamiento actual.

### 11.3 Keybindings + statusline

**Alcance mínimo**:
- Tabla nueva `user_preferences(user_id, key, value_json, updated_at)` (clave-valor genérico).
- Endpoint `GET/PUT /api/user-preferences/:key` admin-only.
- El WebChat puede leer `keybindings` y `statusline_config`. Otros clients pueden usar la misma infra para sus settings.
- **Parked**: hook `status_line` (requiere ejecución del script al renderizar UI — acopla backend con UI).

## Archivos nuevos

- `docs/fase-11-investigacion.md` (este)
- `storage/McpAuthRepository.js` — tokens cifrados
- `storage/UserPreferencesRepository.js` — keybindings + futuro statusline
- `core/security/tokenCrypto.js` — scrypt + AES-GCM para cifrar tokens
- `services/McpAuthService.js` — fachada que maneja evento `mcp:auth_required` + persistencia
- `mcp/tools/mcpAuth.js` — 2 tools: mcp_authenticate, mcp_complete_authentication
- `routes/user-preferences.js` — GET/PUT/DELETE admin-only

## Archivos a modificar

- `mcp-client-pool.js` — detectar errores de auth del MCP y emitir evento
- `services/ConversationService.js` — middleware de slash commands pre-loop
- `bootstrap.js` — wiring de McpAuth + UserPreferences
- `index.js` — mount route

## Tests

- `test/mcp-auth-repo.test.js` — CRUD + UNIQUE(mcp_name, user_id)
- `test/token-crypto.test.js` — round-trip cifrado + key derivation
- `test/slash-commands.test.js` — detectSlashCommand + skill injection
- `test/routes.user-preferences.test.js` — admin CRUD

## Parked / out of scope

- OAuth2 flow completo custom por provider (callback, code exchange) — ya existe para Google
- `status_line` hook runtime — acopla backend con UI
- Keybindings UI del WebChat — trabajo en frontend, no server
