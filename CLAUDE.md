# Clawmint — Agente Familiar Doméstico

Asistente IA doméstico que corre en el hogar (Raspberry Pi, mini PC, NAS). Cada miembro de la familia accede desde Telegram o el navegador. Gestiona correos, calendario, recordatorios, tareas y más — todo privado, todo local.

> Visión completa: `docs/vision.md`

## Instrucciones de comunicación

- Responder siempre en **español**.
- Ser conciso y directo, sin relleno.
- Usar siempre **rutas absolutas** (base: `/home/marcos/marcos/clawmint/`) para no perder contexto del directorio de trabajo.
- No explicar lo obvio; el usuario conoce el proyecto.

## Principios y reglas

Este proyecto sigue un conjunto explícito de principios y reglas de desarrollo. No se duplican acá — vivien en `docs/`:

- **Filosofía**: `docs/philosophy.md` — minimalismo intencional, honestidad de verificación, reversibilidad primero, root cause sobre workaround, colaboración sobre ejecución ciega.
- **Reglas concretas**: `docs/development-rules.md` — código, commits, docs, testing, seguridad, interacción con el usuario.
- **Mentalidad y técnicas senior**: `docs/engineering-craftsmanship.md` — patrones extraídos directamente del código de Claude Code (tipos como contrato, jerarquías de error, retry contextual, cleanup registry, event buffering, etc.). Referencia para decisiones técnicas no triviales.
- **Plan técnico**: `server/ROADMAP.md` — fases con principios de modularidad aplicados (un módulo = una responsabilidad, DI por constructor, eventos tipados, flags por feature, fail-open).

Si algo de lo escrito acá contradice esos documentos, ellos ganan. Si hay que cambiar una regla, se edita allá — no acá.

## Stack

- **Runtime:** Node.js 22+ (CommonJS, `'use strict'`)
- **Server:** Express 4 + `ws` + `node-pty`
- **Client:** React 18 + Vite + xterm.js
- **IA:** Anthropic SDK + `claude -p` (CLI) + Gemini + OpenAI + Grok (xAI) + Ollama (local)
- **TTS:** Edge TTS, Piper TTS, SpeechT5, ElevenLabs, OpenAI TTS, Google TTS
- **Persistencia:** SQLite via sql.js (WASM) + JSON planos (`agents.json`, `bots.json`)
- **Mensajería:** Telegram Bot API (long polling)
- **Procesos:** PM2 (auto-restart, logs, monitoreo)

## Estructura

```
clawmint/
├── server/
│   ├── index.js                # Orquestador (~170 LOC): setup, mount, startup
│   ├── bootstrap.js            # DI: inicialización de módulos (Telegram, TTS, etc.)
│   ├── sessionManager.js       # PtySession + pool de sesiones + idle timeout 30min
│   ├── routes/                 # Rutas REST (extraídas de index.js)
│   │   ├── sessions.js         # CRUD sesiones PTY + input/message/stream/output
│   │   ├── agents.js           # CRUD agentes
│   │   ├── mcps.js             # CRUD MCPs + registry Smithery
│   │   ├── skills.js           # Skills install/search/delete
│   │   ├── memory.js           # Memory debug/graph/CRUD por agente
│   │   ├── logs.js             # Logs config/tail/clear
│   │   ├── telegram.js         # Bots + chats + multimedia Telegram
│   │   ├── webchat.js          # Sessions + multimedia WebChat
│   │   ├── providers.js        # Config providers IA
│   │   ├── voice-providers.js  # Config TTS
│   │   └── nodriza.js          # Config/status P2P nodriza
│   ├── ws/                     # WebSocket handlers (extraídos de index.js)
│   │   ├── pty-handler.js      # Conexiones WS → PTY sessions
│   │   ├── ai-handler.js       # Sesiones AI via WebSocket
│   │   └── datachannel-handler.js # Sesiones AI via P2P/nodriza
│   ├── channels/
│   │   ├── BaseChannel.js      # Clase base para canales de mensajería
│   │   ├── p2p/
│   │   │   └── P2PBotAdapter.js # Adaptador DataChannel → interfaz TelegramBot
│   │   ├── web/
│   │   │   └── WebChannel.js   # WebChat via WebSocket
│   │   └── telegram/
│   │       ├── TelegramChannel.js     # TelegramBot + manejo de mensajes
│   │       ├── CommandHandler.js      # Comandos /start, /cd, /consola, etc.
│   │       ├── CallbackHandler.js     # Callbacks de botones inline
│   │       ├── DynamicCallbackRegistry.js # Callbacks dinámicos con TTL + tipo 'func'
│   │       └── PendingActionHandler.js # Acciones pendientes (whitelist, etc.)
│   ├── core/
│   │   ├── ClaudePrintSession.js # Sesión Claude CLI con persistencia
│   │   ├── ConsoleSession.js     # Sesión de consola bash
│   │   ├── EventBus.js           # Bus de eventos centralizado
│   │   ├── Logger.js             # Logger con niveles, archivo y rotación (>50MB)
│   │   └── systemStats.js        # Stats del sistema (CPU, RAM, uptime)
│   ├── services/
│   │   ├── ConversationService.js # Motor de conversación con IA (retry, rate limit, modos, costo, compresión)
│   │   ├── AuthService.js         # Auth + JWT auto-persistido + invitations + multi-user approval
│   │   ├── McpAuthService.js      # OAuth handlers para MCPs (Google/GitHub/Spotify)
│   │   └── LocationService.js     # LAN + Tailscale (rango 100.x) + IP pública (ipwho.is, cache 24h) + override manual
│   ├── providers/
│   │   ├── index.js             # Registry de proveedores IA
│   │   ├── anthropic.js         # Anthropic SDK directo (+ usage tracking)
│   │   ├── claude-code.js       # Claude Code CLI (claude -p)
│   │   ├── gemini.js            # Google Gemini (+ usage tracking)
│   │   ├── openai.js            # OpenAI ChatGPT (+ usage tracking)
│   │   ├── grok.js              # Grok (xAI) (+ usage tracking)
│   │   └── ollama.js            # Ollama (modelos locales, carga dinámica)
│   ├── voice-providers/
│   │   ├── index.js             # Registry de proveedores TTS
│   │   ├── edge-tts.js          # Microsoft Edge TTS (offline)
│   │   ├── piper-tts.js         # Piper TTS (offline, español nativo)
│   │   ├── speecht5.js          # SpeechT5 (@huggingface/transformers)
│   │   ├── elevenlabs.js        # ElevenLabs API
│   │   ├── openai-tts.js        # OpenAI TTS API
│   │   └── google-tts.js        # Google Cloud TTS
│   ├── storage/
│   │   ├── sqlite-wrapper.js    # Wrapper sql.js compatible con better-sqlite3
│   │   ├── DatabaseProvider.js  # Inicialización y acceso a la DB
│   │   ├── ChatSettingsRepository.js # Persistencia: provider, cwd, sesión, modo, historial
│   │   ├── BotsRepository.js    # Persistencia de configuración de bots
│   │   ├── InvitationsRepository.js   # Invitaciones por código (Fase A)
│   │   ├── HouseholdDataRepository.js # Datos compartidos del hogar (Fase B)
│   │   └── SystemConfigRepository.js  # Config global cifrada (OAuth creds sin .env)
│   ├── mcp/
│   │   ├── index.js             # Router MCP (herramientas expuestas)
│   │   ├── ShellSession.js      # Sesión shell para MCP (idle timeout 30min)
│   │   └── tools/
│   │       ├── index.js         # Registry de herramientas MCP (130+ tools modulares)
│   │       ├── bash.js          # Shell con estado persistente
│   │       ├── git.js           # Git: 12 acciones (status, diff, log, commit, push, etc.)
│   │       ├── files.js         # read_file, write_file, edit_file, list_dir, search_files
│   │       ├── pty.js           # pty_create, pty_exec, pty_write, pty_read
│   │       ├── memory.js        # Gestión de memoria para MCP
│   │       ├── telegram.js      # Integración Telegram para MCP
│   │       ├── webchat.js       # Integración WebChat para MCP
│   │       ├── critter.js       # Control remoto P2P (channel: 'p2p')
│   │       ├── critter-status.js   # Estado de critter (global, sin channel)
│   │       ├── critter-registry.js # Registry de peers P2P conectados
│   │       ├── location.js      # server_info, server_location, weather_get
│   │       ├── userLocation.js  # user_location_save/get/forget (geocoding OSM)
│   │       ├── environment.js   # air_quality, sun, moon_phase, uv_index, holiday_check, is_weekend
│   │       ├── arFinance.js     # dolar_ar, currency_convert, crypto_price, wikipedia, recipes, joke
│   │       ├── briefs.js        # day_summary, morning_brief, bedtime_brief, week_ahead
│   │       ├── household.js     # grocery_*, family_event_*, house_note_*, service_*, inventory_* (Fase B)
│   │       └── routines.js      # routine_morning_set/bedtime_set/weather_alert/disable/list (Fase C)
│   ├── mcp-oauth-providers/     # Handlers OAuth auto-registrables (Google/GitHub/Spotify)
│   │   ├── index.js             # registerAll({mcpAuthService, systemConfigRepo})
│   │   ├── google.js            # Calendar/Gmail/Drive/Tasks (un par client_id/secret)
│   │   ├── github.js
│   │   └── spotify.js
│   ├── mcps.js                  # Gestión de servidores MCP externos
│   ├── tts.js                   # Módulo TTS central
│   ├── tts-config.js            # Configuración de proveedores TTS
│   ├── agents.js                # CRUD de agentes
│   ├── skills.js                # Skills locales + búsqueda ClawHub
│   ├── memory.js                # Memoria persistente por agente (SQLite + índices)
│   ├── memory-consolidator.js   # Consolidación periódica de memoria
│   ├── embeddings.js            # Embeddings para búsqueda semántica
│   ├── tools.js                 # Adaptador MCP → formatos provider (Anthropic, Gemini, OpenAI)
│   ├── reminders.js             # Recordatorios/alarmas programadas
│   ├── transcriber.js           # Transcripción audio con Whisper
│   ├── provider-config.js       # Configuración de proveedores IA
│   ├── nodriza.js               # Conexión a nodriza (señalización P2P + WebRTC)
│   ├── nodriza-config.js        # Configuración de nodriza (env + JSON)
│   ├── mcp-system-prompt.txt    # System prompt para Claude Code en modo MCP
│   ├── events.js                # EventEmitter global (legacy)
│   ├── ecosystem.config.js      # Configuración PM2
│   └── test/                    # Tests unitarios
├── client/
│   ├── .env                     # VITE_SERVER_URL=localhost:3001
│   └── src/
│       ├── App.jsx
│       ├── config.js              # Config centralizada (SERVER_HOST, API_BASE, WS_URL)
│       └── components/
│           ├── Dashboard.jsx          # Mission Control (landing default) — métricas + clima + agentes
│           ├── HouseholdPanel.jsx     # Hogar: 5 tabs (mercadería/eventos/notas/servicios/inventario)
│           ├── UserLocationSection.jsx # Geocoding via OSM (en ProfilePanel)
│           ├── UserRoutinesSection.jsx # Morning/bedtime/weather alert (en ProfilePanel)
│           ├── TerminalPanel.jsx      # Terminal xterm.js (con cleanup de listeners)
│           ├── TabBar.jsx
│           ├── AgentsPanel.jsx
│           ├── ProvidersPanel.jsx
│           ├── CommandBar.jsx
│           ├── TelegramPanel.jsx
│           ├── WebChatPanel.jsx       # Chat web con ConversationService
│           ├── WebChatPanel.css
│           ├── layout/
│           │   ├── Sidebar.jsx        # NAV_GROUPS labeled + scroll
│           │   ├── AppHeader.jsx      # Brand + search + health pill + bell con badge pendientes
│           │   ├── StatusFooter.jsx   # CPU/RAM/DISK/uptime permanente (poll 5s)
│           │   └── sectionMeta.js     # SECTION_META + NAV_GROUPS + SECTION_FLAGS
│           ├── admin/
│           │   ├── UsersPanel.jsx     # Status badges + Approve/Reject/Reactivate + modal Invitar
│           │   └── OAuthCredentialsPanel.jsx  # Google/GitHub/Spotify desde UI
│           └── features/
│               ├── IntegrationsPanel.jsx  # Hub catálogo de servicios externos
│               ├── DevicesPanel.jsx       # Home Assistant (setup guide + status MCP)
│               └── MusicPanel.jsx         # Spotify (setup guide + status MCP)
├── ROADMAP.md                    # 9 sesiones de implementación priorizadas
└── docs/                          # Documentación del proyecto
```

## Comandos

```bash
# Server (desarrollo)
cd server && npm install && npm start  # http://localhost:3001

# Server (producción con PM2)
cd server && pm2 start ecosystem.config.js  # auto-restart, logs en ~/.pm2/logs/

# Client
cd client && npm install && npm run dev  # http://localhost:5173

# PM2 útil
pm2 logs clawmint    # ver logs en vivo
pm2 restart clawmint # reiniciar
pm2 stop clawmint    # parar
pm2 status           # estado
pm2 save             # guardar estado para auto-arranque
```

## Convenciones

- Todo el backend es CommonJS (`require`, `module.exports`), NO ES Modules.
- Los archivos `agents.json`, `bots.json`, `logs.json`, `server.log`, `memory/`, `skills/` se generan en runtime y NO se versionan.
- El stack de node-pty se aumenta con `--stack-size=65536` para evitar crash en WSL2.
- Se eliminan `CLAUDECODE` y `CLAUDE_CODE_ENTRYPOINT` del env al spawner PTYs.
- Telegram edits tienen throttle de 1500ms (límite de la API).
- **Arquitectura modular**: `index.js` es solo orquestador (~170 LOC). Rutas REST en `routes/`, WS handlers en `ws/`. Cada módulo recibe dependencias por inyección (factory function → Router).
- **SQLite usa sql.js (WASM)**, no better-sqlite3 — no requiere compilación nativa.
  - El wrapper `storage/sqlite-wrapper.js` expone API compatible con better-sqlite3.
  - La DB vive en memoria y se auto-persiste a disco con debounce de 500ms.
  - Índices en `notes(agent_key)`, `consolidation_queue(status)`, `note_links`, `note_embeddings`.
  - La inicialización es async (`await Database.initialize()` en `memory.initDBAsync()`).
- **spawn de `claude` CLI** usa `shell: true` en Windows para resolver `.cmd`.
- **Persistencia de sesión Claude**: se guarda `claudeSessionId`, `messageCount`, `cwd` y `claudeMode` en SQLite. `--resume` al reiniciar.
- **Persistencia de historial API**: `aiHistory` se guarda en SQLite (`ai_history` en `chat_settings`). Se carga al reconectar. Se compacta automáticamente cuando supera 30 mensajes (sliding window con resumen).
- **Modos de permisos** (`ask`/`auto`/`plan`): funcionan para TODOS los providers (no solo Claude Code).
  - `auto`: ejecuta tools sin preguntar. Status: pensando → ejecutando → listo → respuesta.
  - `ask`: botones ✅/❌ en Telegram antes de cada tool. Timeout 60s → auto-rechazo.
  - `plan`: tools no se ejecutan, solo describe qué haría.
- **TTS multi-proveedor**: configurado en `tts-config.js`/`tts-config.json`. Edge TTS y Piper funcionan offline.
- **Providers IA**: 6 proveedores. Cada uno implementa `async *chat()` generator con streaming + tool-use + usage tracking.
  - Todos los providers SDK soportan **tool calling** — reciben `executeTool` desde `ConversationService`.
  - Ollama usa modo **non-streaming** cuando hay tools (workaround para bug de Ollama con streaming + tools).
  - Ollama carga los modelos disponibles **dinámicamente** desde `/api/tags` (cache 30s).
  - Todos los providers emiten `{ type: 'usage', promptTokens, completionTokens }` para tracking.
- **MCP**: 130+ herramientas modulares en `mcp/tools/` (32 archivos):
  - **Core**: `bash`, `git` (12 acciones), `read_file`/`write_file`/`edit_file`/`list_dir`/`search_files`, `pty_create`/`pty_exec`/`pty_write`/`pty_read`, `memory_list/read/write/append/delete`.
  - **Channels**: `telegram_send_*` (message/photo/document/voice/video/edit/delete) + `webchat_*` (idem) + `telegram_list_bots`/`webchat_list_sessions`.
  - **P2P**: `critter_*` (con `channel: 'p2p'` — solo visible en sesiones P2P) + `critter_status` (global).
  - **Productividad**: `task_*`, `skill_*` (list/invoke), `cron_*` (cron jobs), `typed_memory_*`, `hooks_*`, `glob`/`grep`/`webfetch`/`websearch`, `notebook_edit`, `enter_plan_mode`/`exit_plan_mode`, `monitor_process`, `push_notification`.
  - **Server info**: `server_info` (hostname/platform/cpu/uptime), `server_location` (LAN+Tailscale+IP pública+manual override), `weather_get` (Open-Meteo, prioriza user pref > server location).
  - **Datos del entorno**: `air_quality_get`, `sun_get` (cálculo nativo), `moon_phase` (cálculo nativo), `uv_index_get`, `holiday_check` (date.nager.at), `is_weekend`.
  - **Finanzas/cultura**: `dolar_ar` (blue/oficial/MEP/CCL), `currency_convert` (open.er-api), `crypto_price` (coingecko), `wikipedia_summary`, `recipe_random`/`recipe_search` (themealdb), `joke_get` (jokeapi), `feriados_ar`.
  - **Briefs proactivos**: `day_summary`, `morning_brief`, `bedtime_brief` (lenguaje natural), `week_ahead`.
  - **User location**: `user_location_save` (geocoding OSM auto), `user_location_get`, `user_location_forget`.
  - **Hogar (Fase B)**: `grocery_*` (mercadería), `family_event_*` (eventos con alerta), `house_note_*` (notas), `service_*` (vencimientos), `inventory_*` (despensa), `household_summary`.
  - **Pro-actividad (Fase C)**: `routine_morning_set`, `routine_bedtime_set`, `routine_weather_alert`, `routine_disable`, `routine_list` — wrappers sobre Scheduler que generan crons + payloads listos.
  - **OAuth MCP**: `mcp_authenticate`, `mcp_complete_authentication`, `mcp_list_authenticated`.
  - **LSP**: `lsp_go_to_definition`/`find_references`/`hover`/`document_symbols`/`workspace_symbols`/`diagnostics`.
  - **Filtrado por channel**: cada tool puede tener `channel` opcional (ej. critter='p2p').
  - **Filtrado por env**: `MCP_DISABLED_TOOLS` (CSV) para rollback sin rebuild.
- **ConversationService**: motor unificado de conversación con IA.
  - Retry 3x con exponential backoff para errores transitorios (429, 500, timeout).
  - No reintenta si ya ejecutó tools (previene side effects duplicados).
  - Timeout global 120s por request.
  - Rate limit 10 msgs/min por chat.
  - Sliding window: compresión automática de historial >30 msgs.
  - System prompt con instrucciones de tools según canal (Telegram/WebChat/P2P).
  - Tracking de costo por provider (`/costo`).
- **Estabilidad**:
  - PtySession: idle timeout 30min + cleanup de buffer y listeners.
  - ShellSession: idle timeout 30min + removeAllListeners en destroy.
  - Logger: rotación automática cuando >50MB (máx 2 rotados).
  - TerminalPanel: cleanup de `term.onData()` disposable al desmontar.
- **DynamicCallbackRegistry**: soporta tipos `message`, `command`, `prompt`, `url`, `func`.
- **Config centralizada del client**: `client/.env` con `VITE_SERVER_URL`. `client/src/config.js` expone `SERVER_HOST`, `API_BASE`, `WS_URL`.
- **PM2**: `ecosystem.config.js` con 3 perfiles: `clawmint` (dev con watch), `clawmint-client-dev` (vite HMR :5173), `clawmint-prod` (sin watch, NODE_ENV=production, autorestart, max-memory 1GB, logs separados en `server/logs/prod-*.log`). `--stack-size=65536`.

- **Multi-usuario con aprobación**: tabla `users` tiene columna `status` con valores `active`/`pending`/`disabled`.
  - Primer usuario en DB vacía → `role='admin'` + `status='active'` automático.
  - Usuarios subsiguientes → `role='user'` + `status='pending'` (no reciben tokens al registrar; HTTP 202 con mensaje "espera aprobación").
  - Login valida `status='active'`; pending → 403 con `code: 'pending'`; disabled → 403 con `code: 'disabled'`.
  - Admin aprueba/rechaza desde `Configuración → Usuarios`. Aprobar = `setStatus('active')`. Rechazar = soft-delete (`status='disabled'`, conserva email).

- **Onboarding por invitación**: admin genera código de un solo uso desde el modal del UsersPanel. TTL configurable (1h-1sem). Se comparte como link `?invite=CODE` o QR. El invitado se registra y queda **activo automáticamente** (bypass del pending). Tabla `invitations` con soft-revoke + cleanup.

- **Instalable sin `.env`**: la app es packageable y funciona en primer arranque sin configuración manual.
  - `JWT_SECRET` se auto-genera en primer arranque y persiste en `${CONFIG_DIR}/.jwt-secret.key` (mode 0600). Mismo patrón que `tokenCrypto`.
  - OAuth credentials de providers MCP (Google/GitHub/Spotify) se setean desde el panel admin `OAuthCredentialsPanel`. Se guardan cifradas en `system_config` (TokenCrypto). Los handlers `mcp-oauth-providers/` leen dinámicamente — no requiere restart.
  - Fallback a env vars (`GOOGLE_CLIENT_ID/SECRET`, etc.) si están seteadas.

- **Datos compartidos del hogar (Fase B)**: tabla `household_data` flexible con `kind` (grocery_item/family_event/house_note/service/inventory). Cualquier user `status='active'` puede leer/escribir via `/api/household/:kind`. Acceso desde Telegram/WebChat via 18 MCP tools (`grocery_*`, `family_event_*`, etc.). Panel "Hogar" en sidebar (grupo "Familia") con 5 tabs.

- **Pro-actividad (Fase C)**: tools `routine_morning_set({time})`, `routine_bedtime_set`, `routine_weather_alert({rain_threshold})`. Wrappers que crean `scheduled_actions` con cron derivado de la hora HH:MM. Scheduler tick cada 30s detecta y dispara `_executeAiTask` con payload natural language → el agente despacha `morning_brief` + `telegram_send_message`.

- **LocationService**: combina LAN (`os.networkInterfaces`) + Tailscale (rango 100.64.0.0/10) + IP pública via ipwho.is (cache 24h, free sin key) + override manual (admin desde UI). Usado por tools `weather_get`/`sun_get`/`air_quality_get` para auto-resolver coords (prioridad: user pref > server location > args).

- **Sidebar nav (NAV_GROUPS)**: 7 grupos labeled — `Overview` (Dashboard) · `Control` (Terminal/Chat) · `Comms` (Telegram/Contactos) · `Familia` (Hogar) · `Productividad` (Tasks/Scheduler/Skills) · `Servicios` (Integraciones/Dispositivos/Música) · `Settings` (Configuración con 24+ tabs). Items gated por feature flags (`SECTION_FLAGS`).

- **Paleta visual**: warm-only — `--accent-orange #f97316` (primary brand), `--accent-red #ef4444`, `--accent-amber #fbbf24` (alias `--accent-cyan`), `--accent-peach #fb923c` (alias `--accent-blue`), `--accent-yellow #f59e0b`. Mission Control near-black background `#0a0a0c`.

- **WS reconnect infinito** con cap de 30s entre intentos (antes se rendía a los 5). Listeners `visibilitychange` + `online` fuerzan reconexión inmediata cuando user vuelve a la tab. `wsConnected` default `false` para no mostrar "Health OK" engañoso al bootstrap.

## Nodriza (P2P con deskcritter)

Terminal-live actúa como "server" en nodriza para aceptar conexiones P2P de clients como deskcritter.

### Configuración

Variables de entorno (`.env`) tienen prioridad sobre `nodriza-config.json`:

```env
NODRIZA_ENABLED=true
NODRIZA_URL=ws://localhost:3000/signaling
NODRIZA_SERVER_ID=<id del server en nodriza>
NODRIZA_API_KEY=<api key del server>
```

### Flujo P2P

```
terminal-live ──ws──→ nodriza ←──ws── deskcritter
     │                                    │
     │════════ P2P DataChannel ═══════════│
     │                                    │
     │←─ {type:"init", sessionType:"ai"} ─│
     │──→ {type:"output", data:"..."} ────│
```

### REST API

```
GET  /api/nodriza/config    — config actual (apiKey censurada)
PUT  /api/nodriza/config    — actualizar config
GET  /api/nodriza/status    — { connected, peers }
POST /api/nodriza/reconnect — forzar reconexión
```

## Telegram

### Comandos principales

- `/nueva` — nueva conversación (limpia historial en RAM + SQLite)
- `/provider [nombre]` — cambiar provider (limpia historial)
- `/modelo [nombre]` — cambiar modelo
- `/modo [ask|auto|plan]` — modo de permisos (funciona con todos los providers)
- `/costo` — costo estimado de la sesión (tokens + USD)
- `/agentes` — listar agentes
- `/consola` — modo consola bash
- `/estado` — estado detallado del chat
- `/ayuda` — todos los comandos

### Critter Tools (control remoto P2P)

Herramientas MCP para controlar remotamente el PC de un usuario conectado via deskcritter. Solo disponibles en sesiones P2P (`channel: 'p2p'`).

| Tool | Descripción |
|------|------------|
| `critter_bash` | Ejecutar comando en el PC remoto (PowerShell/bash) |
| `critter_read_file` | Leer archivo del PC remoto |
| `critter_write_file` | Escribir archivo en el PC remoto |
| `critter_edit_file` | Editar archivo (reemplazo de texto) |
| `critter_list_files` | Listar directorio |
| `critter_grep` | Buscar por patrón en archivos |
| `critter_screenshot` | Capturar pantalla (retorna base64 PNG) |
| `critter_clipboard_read` | Leer portapapeles |
| `critter_clipboard_write` | Escribir al portapapeles |
| `critter_screen_info` | Info del monitor (resolución, escala) |
| `critter_status` | Verificar si hay critter conectado (**global**, disponible en todos los canales) |

- **`mcp/tools/critter.js`** — Definición de tools con `channel: 'p2p'`.
- **`mcp/tools/critter-registry.js`** — Singleton que gestiona peers conectados. Envía acciones via DataChannel y espera resultados con timeout (30s por defecto).
- **`mcp/tools/critter-status.js`** — Tool global (sin `channel`) que permite a la IA verificar si hay un critter conectado desde cualquier canal.

Flujo: IA invoca `critter_bash({ command })` → registry envía `{ type: 'action', tool: 'bash', args }` al peer via DataChannel → critter ejecuta y responde con `{ type: 'action_result', id, result }` → registry resuelve la promesa → IA recibe el resultado.

### Envío de multimedia (REST)

```
POST /api/telegram/bots/:key/chats/:chatId/photo
POST /api/telegram/bots/:key/chats/:chatId/document
POST /api/telegram/bots/:key/chats/:chatId/voice
POST /api/telegram/bots/:key/chats/:chatId/video
```

## Health check + system info

```
GET /api/health             → { ok, uptime, startedAt, pid, node }                 (público)
GET /api/system/stats       → { system: {cpu, ram, disk, uptime, host}, server, ws,
                                 sessions, telegram, providers, nodriza }            (auth)
GET /api/system/location    → { hostname, lan, tailscale, public, manual, resolved } (auth)
GET /api/system/lan-addresses → { addresses: [{address, interface, isTailscale}] }   (auth)
PUT /api/system/location    → admin-only, body { latitude, longitude, name }
```

`/api/system/stats` lo consume el Dashboard (Mission Control) con polling 3s + el StatusFooter con 5s. Usa `fs.statfsSync` (Node 18.15+) para disk — no spawnea procesos en Windows (evita flash de consola).

## Auth + multi-user (REST)

```
POST /api/auth/register         body { email, password, name, inviteCode? }
                                → 201 { user, accessToken, refreshToken } (admin o invitado)
                                → 202 { user, pending: true, message }     (pending)
POST /api/auth/login            → 200 ok | 403 { code: 'pending'|'disabled' }
POST /api/auth/admin/users/:id/{approve,reject,reactivate}  (admin)
GET  /api/auth/admin/users/pending/count                     (admin) — para badge
POST /api/auth/admin/invitations         body { ttlHours?, role?, familyRole? }  (admin)
GET  /api/auth/admin/invitations         → list con status                       (admin)
DELETE /api/auth/admin/invitations/:code → soft revoke                           (admin)
GET  /api/auth/invitations/:code         → { valid, status, family_role, role }  (público)
```

## SystemConfig (admin)

```
GET /api/system-config/oauth                → status por provider (sin secrets)
PUT /api/system-config/oauth/:provider      body { client_id, client_secret }
DELETE /api/system-config/oauth/:provider
GET/PUT/DELETE /api/system-config/:key      → CRUD genérico key/value
```

## Household (auth user activo)

```
GET  /api/household/summary                  → counts + upcoming
GET  /api/household/upcoming?days=7
GET  /api/household/:kind                    → list (qs: includeCompleted, upcomingOnly, limit)
POST /api/household/:kind                    body { title, data, dateAt, alertDaysBefore }
PATCH/DELETE /api/household/:kind/:id
POST /api/household/:kind/:id/{complete,uncomplete}
```

`:kind` ∈ `grocery_item | family_event | house_note | service | inventory`.

## WebChat

Panel de chat web (`WebChatPanel.jsx`) que usa `ConversationService` — mismo motor que Telegram.

- **WebSocket**: tipo `webchat` — envía `{ type: 'chat', text, provider, agent }`
- **Status**: recibe `{ type: 'chat_status', status, detail }` (pensando/tool/listo)
- **Comandos**: `/provider`, `/agente`, `/modelo`, `/cd`, `/nueva`, `/modo`, `/estado`, `/ayuda`
- **Streaming**: chunks via `{ type: 'chat_chunk', text }`, fin con `{ type: 'chat_done', text }`
