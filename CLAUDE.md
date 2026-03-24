# Clawmint

Terminal en tiempo real accesible desde el navegador y Telegram. Combina PTY virtual (node-pty), WebSocket, REST API, y un bot de Telegram como frontend alternativo para Claude Code y otros agentes.

## Instrucciones de comunicación

- Responder siempre en **español**.
- Ser conciso y directo, sin relleno.
- Usar siempre **rutas absolutas** (base: `/home/marcos/marcos/clawmint/`) para no perder contexto del directorio de trabajo.
- No explicar lo obvio; el usuario conoce el proyecto.

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
│   │   └── ConversationService.js # Motor de conversación con IA (retry, rate limit, modos, costo, compresión)
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
│   │   └── BotsRepository.js    # Persistencia de configuración de bots
│   ├── mcp/
│   │   ├── index.js             # Router MCP (herramientas expuestas)
│   │   ├── ShellSession.js      # Sesión shell para MCP (idle timeout 30min)
│   │   └── tools/
│   │       ├── index.js         # Registry de herramientas MCP (32 tools)
│   │       ├── bash.js          # Shell con estado persistente
│   │       ├── git.js           # Git: 12 acciones (status, diff, log, commit, push, etc.)
│   │       ├── files.js         # read_file, write_file, edit_file, list_dir, search_files
│   │       ├── pty.js           # pty_create, pty_exec, pty_write, pty_read
│   │       ├── memory.js        # Gestión de memoria para MCP
│   │       ├── telegram.js      # Integración Telegram para MCP
│   │       ├── webchat.js       # Integración WebChat para MCP
│   │       ├── critter.js       # Control remoto P2P (channel: 'p2p')
│   │       ├── critter-registry.js # Registry de critters conectados
│   │       └── critter-status.js   # Estado de critter P2P
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
│           ├── TerminalPanel.jsx  # Terminal xterm.js (con cleanup de listeners)
│           ├── TabBar.jsx
│           ├── AgentsPanel.jsx
│           ├── ProvidersPanel.jsx
│           ├── CommandBar.jsx
│           ├── TelegramPanel.jsx
│           ├── WebChatPanel.jsx   # Chat web con ConversationService
│           └── WebChatPanel.css
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
- **spawn de `claude` CLI** usa `shell: true` en Windows para resolver `.cmd`.
- **Persistencia de sesión Claude**: se guarda `claudeSessionId`, `messageCount`, `cwd` y `claudeMode` en SQLite. `--resume` al reiniciar.
- **Persistencia de historial API**: `aiHistory` se guarda en SQLite (`ai_history` en `chat_settings`). Se carga al reconectar. Se compacta automáticamente cuando supera 30 mensajes (sliding window con resumen).
- **Modos de permisos** (`ask`/`auto`/`plan`): funcionan para TODOS los providers (no solo Claude Code).
  - `auto`: ejecuta tools sin preguntar. Status: pensando → ejecutando → listo → respuesta.
  - `ask`: botones ✅/❌ en Telegram antes de cada tool. Timeout 60s → auto-rechazo.
  - `plan`: tools no se ejecutan, solo describe qué haría.
- **TTS multi-proveedor**: configurado en `tts-config.js`/`tts-config.json`. Edge TTS y Piper funcionan offline.
- **Providers IA**: 6 proveedores. Cada uno implementa `async *chat()` generator con streaming + tool-use + usage tracking.
- **MCP**: 32 herramientas modulares en `mcp/tools/`:
  - `bash` — shell con estado persistente
  - `git` — 12 acciones (status, diff, log, commit, push, pull, branch, checkout, stash, blame, show)
  - `read_file`, `write_file`, `edit_file` (buscar/reemplazar con diffs), `list_dir`, `search_files`
  - `pty_create`, `pty_exec` (ejecutar + esperar resultado), `pty_write`, `pty_read`
  - `memory_list/read/write/append/delete`
  - `telegram_send_message/photo/document/voice/video/edit/delete`, `telegram_list_bots`
  - `webchat_send_message/photo/document/voice/video/edit/delete`, `webchat_list_sessions`
  - `critter_status`
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
- **PM2**: `ecosystem.config.js` carga `.env` automáticamente. `--stack-size=65536`. Client usa `node_modules/vite/bin/vite.js` directo (fix Windows).

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

### Envío de multimedia (REST)

```
POST /api/telegram/bots/:key/chats/:chatId/photo
POST /api/telegram/bots/:key/chats/:chatId/document
POST /api/telegram/bots/:key/chats/:chatId/voice
POST /api/telegram/bots/:key/chats/:chatId/video
```

## Health check

```
GET /api/health → { ok, uptime, startedAt, pid, node }
```

## WebChat

Panel de chat web (`WebChatPanel.jsx`) que usa `ConversationService` — mismo motor que Telegram.

- **WebSocket**: tipo `webchat` — envía `{ type: 'chat', text, provider, agent }`
- **Status**: recibe `{ type: 'chat_status', status, detail }` (pensando/tool/listo)
- **Comandos**: `/provider`, `/agente`, `/modelo`, `/cd`, `/nueva`, `/modo`, `/estado`, `/ayuda`
- **Streaming**: chunks via `{ type: 'chat_chunk', text }`, fin con `{ type: 'chat_done', text }`
