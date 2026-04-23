> Última actualización: 2026-03-29

# Arquitectura del sistema

## Visión general

Clawmint es un agente familiar doméstico que corre en el hogar. El servidor orquesta conversaciones con IA, gestiona integraciones (calendario, correo, tareas) y expone múltiples canales de acceso: Telegram, WebChat, P2P y una terminal PTY para administración. Cada miembro de la familia se identifica mediante un sistema de autenticación por invitación y accede a su propio contexto.

> Ver [vision.md](./vision.md) para los principios y el roadmap de integraciones.

```
┌──────────────────────────────────────────────────────────────┐
│  Clientes                                                    │
│  ┌───────────────┐   ┌─────────────────────────────┐        │
│  │  Navegador    │   │  Telegram (usuario)         │        │
│  │  React + WS   │   │  long polling               │        │
│  └───────┬───────┘   └──────────────┬──────────────┘        │
└──────────┼───────────────────────── │────────────────────────┘
           │ WebSocket / HTTP          │ HTTPS polling
           ▼                          ▼
┌──────────────────────────────────────────────────────────────┐
│  server/index.js  (Express 4 + ws, puerto 3001)             │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ REST API │  │  WS Hub  │  │ EventBus │  │ POST /mcp  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │
└───────┼──────────── │ ────────── │ ──────────────│──────────┘
        │              │            │               │ JSON-RPC 2.0
        ▼              ▼            │               ▼
┌───────────────────────────────────────────────────────────────┐
│  Núcleo de dominio                                            │
│                                                               │
│  ConversationService ── orquesta mensajes por proveedor      │
│  sessionManager      ── PtySession (node-pty)                │
│  agents.js           ── CRUD agentes                         │
│  memory.js           ── SQLite + spreading activation        │
│  providers/          ── Anthropic │ Gemini │ OpenAI          │
│  TelegramChannel     ── TelegramBot × N                      │
│  reminders.js        ── recordatorios                        │
│  skills.js           ── skills locales + ClawHub             │
│  mcps.js             ── MCP registry (Smithery)              │
│  mcp/                ── MCP Server embebido (tools + shell)  │
└───────────────────────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
┌───────────────────────┐   ┌────────────────────────────┐
│  Persistencia         │   │  mcp/ShellSession          │
│  memory/index.db      │   │  Map<shellId, bash>        │
│  agents.json          │   │  cwd/env persisten         │
│  bots.json            │   │  idle timeout 30min        │
│  provider-config.json │   └────────────────────────────┘
│  memory/<agent>/*.md  │
└───────────────────────┘
```

### Flujo de herramientas con estado de shell

```
Providers API (Anthropic / Gemini / OpenAI)
    │  chat({ ..., executeTool })       ← ejecutor inyectado con shellId
    │
    │  tool_call → execToolFn(name, args)
    │                    │
    │                    ▼
    │           mcp/tools/index.execute(name, args, { shellId })
    │                    │
    │                    ▼
    │           mcp/ShellSession.get(shellId)
    │                    │  bash persistente por chatId
    │                    │  cd /tmp persiste, $X=42 persiste
    │                    ▼
    │           resultado → provider → respuesta final
    ▼
ConversationService devuelve texto al canal (Telegram / WS)
```

---

## Módulos principales

### server/index.js
Punto de entrada. Inicializa Express, WebSocket y monta todas las rutas REST. Llama a `bootstrap.createContainer()` para obtener `telegramChannel`, `consolidator` y `mcpRouter` con DI completa. Monta `POST /mcp` como endpoint MCP embebido.

### server/bootstrap.js
Hub único de inyección de dependencias. Crea e inyecta en orden:
```
Logger → EventBus → memory (DB) → consolidator
→ ChatSettingsRepository → BotsRepository
→ ConversationService → TelegramChannel
```
Idempotente: llamadas repetidas devuelven el mismo container.

### server/mcp/
Módulo MCP embebido en el proceso Express. Tres responsabilidades:

1. **ShellSession.js** — shell bash persistente por ID. `cd /tmp` en un llamado, `pwd` en el siguiente devuelve `/tmp`. Centinela único por comando. Auto-destroy tras 30 min idle.
2. **tools/** — implementaciones de herramientas (bash, read_file, write_file, list_dir, search_files, pty_write, pty_read).
3. **index.js** — `createMcpRouter` (JSON-RPC 2.0 en `/mcp`), `executeTool` (en-proceso sin overhead de protocolo), `getToolDefs`.

### server/sessionManager.js
Gestiona el pool de `PtySession`. Cada sesión spawna un proceso real (bash, claude, etc.) mediante `node-pty`, con buffer circular de 5000 entradas. Soporta tipo `pty` (interactivo) y `listener` (solo output).

### server/memory.js
Sistema de memoria persistente por agente. Combina:
- **SQLite** (`memory/index.db`) — índice de notas, tags, links, embeddings, cola
- **Archivos Markdown** (`memory/<agent>/*.md`) — fuente de verdad del contenido
- **Spreading Activation** — búsqueda por activación semántica (2 saltos, decay 0.7)
- **ACT-R Base-Level + Ebbinghaus** — priorización por acceso y retención

### server/channels/telegram/TelegramChannel.js
Gestiona N bots Telegram simultáneos (`TelegramBot`). Cada bot hace long polling (POLL_TIMEOUT=25s). Extiende `BaseChannel`. Recibe `convSvc` por constructor (DI) y delega todos los mensajes a `ConversationService.processMessage()`.

### server/services/ConversationService.js
Desacopla el procesamiento de mensajes del canal de transporte. Enruta a `_processClaudeCode` o `_processApiProvider` según el provider. Inyecta contexto de memoria, señales y `executeTool` con `shellId` para persistencia de shell por conversación.

### server/providers/
Implementaciones de LLM. Cada uno expone:
```javascript
async *chat({ systemPrompt, history, apiKey, model, executeTool? })
// yields: { type: 'text'|'done'|'tool_call'|'tool_result' }
```
El parámetro `executeTool` es opcional; si se pasa, se usa en lugar del default. Permite inyectar el executor con contexto de `shellId`.

---

## Flujo de datos — mensaje IA por WebSocket

```
1. Cliente (React) abre WS y envía { type: 'init', sessionType: 'ai', provider, agentKey, ... }
2. index.js crea sesión AI (sin PTY)
3. Cliente envía { type: 'input', data: 'pregunta del usuario' }
4. index.js llama provider.chat({ systemPrompt, history, apiKey, model })
5. Por cada chunk: ws.send({ type: 'output', data: chunk })
6. Al terminar: ws.send({ type: 'exit' })
```

## Flujo de datos — mensaje Telegram

```
1. TelegramBot recibe update via long polling
2. TelegramBot → _handleMessage() → _sendToSession()
3. _sendToSession() → convSvc.processMessage({ ..., shellId: String(chatId) })
4. ConversationService → provider.chat({ ..., executeTool }) o ClaudePrintSession
5. Herramientas ejecutadas via mcp/tools con ShellSession(chatId) — estado persiste
6. Respuesta → bot._sendResult() → Telegram (con animación de edición cada 1500ms)
7. events.emit('telegram:session') → broadcast a todos los WS del navegador
```

---

## Capas de la arquitectura

| Capa | Módulos | Responsabilidad |
|------|---------|-----------------|
| **Transporte** | `index.js`, `TelegramChannel` | HTTP, WebSocket, polling, /mcp |
| **Orquestación** | `ConversationService` | Routing de mensajes, inyección de contexto |
| **Tools** | `mcp/`, `tools.js` | Ejecución de herramientas con estado de shell |
| **Dominio** | `memory.js`, `agents.js`, `skills.js`, `reminders.js` | Lógica de negocio |
| **Infraestructura** | `sessionManager.js`, `providers/`, `transcriber.js` | I/O externo |
| **Persistencia** | `storage/`, `memory/` | SQLite, JSON |
| **DI** | `bootstrap.js`, `core/` | Ensamblado de dependencias |

---

## Decisiones de diseño

| Decisión | Alternativa descartada | Razón |
|----------|------------------------|-------|
| CommonJS (no ESM) | ES Modules | Compatibilidad con node-pty y better-sqlite3 (bindings nativos) |
| Long polling Telegram | Webhooks | Sin dominio público en desarrollo local |
| SQLite (no PostgreSQL) | PostgreSQL | Sin infra: archivo local, zero-config, suficiente para el volumen |
| `onChunk` callback (no AsyncIterator) | AsyncIterator | Animación de edición Telegram es específica del canal; ConversationService no sabe de Telegram |
| Archivos .md como fuente de verdad | Solo SQLite | Editables a mano, legibles sin herramientas, versionables |
| MCP HTTP sin SDK | `@modelcontextprotocol/sdk` | El SDK usa ESM; el proyecto es CJS. JSON-RPC manual es más simple y confiable |
| ShellSession por chatId | Shell global compartida | Aislamiento natural por conversación; cd/env de un usuario no afectan a otros |
| executeTool inyectado en providers | `require('../tools')` global | Permite pasar shellId como contexto sin romper la interfaz existente |
| Multi-user con `status` en lugar de tablas separadas | Tabla `pending_users`, `active_users` | Una sola tabla, ALTER TABLE idempotente, queries simples |
| Invitaciones soft-revoke (no delete) | Hard delete al revocar | Auditoría: queda histórico de quién generó qué para quién |
| `household_data` flexible con `kind` + `data_json` | 5 tablas separadas | Una sola tabla, queries unificadas, fácil agregar nuevos `kind` |
| OAuth credentials cifradas en DB | `.env` o keychain del OS | Instalable sin tocar archivos. AES-256-GCM via TokenCrypto |
| JWT auto-persistido en archivo | `.env` o variable runtime | App empaquetada (Tauri) corre sin shell — primer arranque genera y persiste |
| `routine_*` tools como wrappers de scheduler | Pedirle al user que escriba cron expressions | UX: time picker HH:MM se traduce a cron internamente |

---

## Multi-user lifecycle

```
[register email/password] ──┬─→ DB vacía → role=admin, status=active → tokens
                            │
                            ├─→ inviteCode válido → status=active → tokens
                            │
                            └─→ ningún caso anterior → status=pending → 202 sin tokens

[login] ─→ valida password ─→ chequea status:
              · active   → emite access + refresh tokens
              · pending  → 403 { code: 'pending', message }
              · disabled → 403 { code: 'disabled', message }

[admin approve/reject/reactivate]
              · approve   → setStatus(id, 'active')
              · reject    → setStatus(id, 'disabled') + revokeAllTokens(id)
              · reactivate→ setStatus(id, 'active')

[admin invite] ─→ InvitationsRepository.create({ ttlMs, role, familyRole, auto_approve: 1 })
              ─→ link http://host:3001/?invite=CODE
              ─→ AuthPanel detecta ?invite= → GET /api/auth/invitations/:code
              ─→ register con inviteCode → status=active inmediato
```

---

## OAuth credentials sin .env

Patrón "instalable sin configuración manual":

1. **Primer arranque**: `AuthService.init()` busca `JWT_SECRET` en env → file `.jwt-secret.key` (mode 0600). Si no existe, lo genera (`crypto.randomBytes(64).hex`) y persiste.

2. **Admin pega credentials en UI**: `OAuthCredentialsPanel` → `PUT /api/system-config/oauth/google` body `{ client_id, client_secret }`. El secret se cifra con `TokenCrypto.encrypt` antes de persistir.

3. **mcp-oauth-providers se auto-registran al boot**: `registerAll({ mcpAuthService, systemConfigRepo })` itera google/github/spotify y registra los handlers. Cada handler tiene `getCreds()` que lee dinámicamente de `systemConfigRepo` con fallback a env vars.

4. **Flow OAuth**: `POST /api/mcp-auth/start/google-calendar` → handler.buildAuthUrl genera URL de Google con scope. Google redirige al callback `/api/mcp-auth/callback/google-calendar` → handler.exchange intercambia code por token → cifrado y guardado en `mcp_auth` table.

No requiere restart del server cuando admin actualiza credentials — la lectura es lazy en cada request.

---

## Datos compartidos del hogar (Fase B)

Tabla `household_data` con scope global del hogar. Cualquier `users.status='active'` puede leer/escribir. Tipos discriminados por `kind`:

```
[user dice "anotá manteca"] ─→ agente llama grocery_add({ item: "manteca" })
                              ─→ HouseholdDataRepository.create({ kind: 'grocery_item', ... })
                              ─→ visible para toda la familia desde Telegram, WebChat o panel "Hogar"

[admin carga "Cumple Tomás 15-jun"] ─→ family_event_add({ title, date, alertDaysBefore: 3 })
                                     ─→ family_event_upcoming({ days: 7 }) lo retorna automáticamente
```

REST `routes/household.js` espeja la API para el cliente. Middleware verifica `users.status='active'` antes de permitir acceso.

---

## Pro-actividad (Fase C)

Wrapper user-friendly sobre `Scheduler`:

```
[user pide "morning brief 7am"] ─→ agente llama routine_morning_set({ time: "07:00" })
                                  ─→ wrapper deriva cron "0 7 * * *" + payload natural language
                                  ─→ ScheduledActionsRepository.create({
                                       action_type: 'ai_task',
                                       trigger_type: 'cron',
                                       cron_expr: '0 7 * * *',
                                       target_type: 'self',
                                       payload: <prompt para que el agente ejecute morning_brief>
                                     })
                                  ─→ guarda action_id en userPreferences (key: routine:morning:action_id)

[Scheduler tick cada 30s] ─→ getTriggered(now) detecta cron vencido
                            ─→ _executeAiTask(action) despacha al agente con el payload
                            ─→ agente ejecuta morning_brief() + telegram_send_message()
```

Tools: `routine_morning_set`, `routine_bedtime_set`, `routine_weather_alert`, `routine_disable`, `routine_list`. Idempotentes: si ya existe la rutina, la borran y recrean.
