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
│   ├── index.js                # HTTP, WebSocket, rutas REST (puerto 3002)
│   ├── bootstrap.js            # Inicialización de módulos (Telegram, TTS, etc.)
│   ├── sessionManager.js       # PtySession + pool de sesiones
│   ├── channels/
│   │   ├── BaseChannel.js      # Clase base para canales de mensajería
│   │   ├── p2p/
│   │   │   └── P2PBotAdapter.js # Adaptador DataChannel → interfaz TelegramBot
│   │   └── telegram/
│   │       ├── TelegramChannel.js     # TelegramBot + manejo de mensajes
│   │       ├── CommandHandler.js      # Comandos /start, /cd, /consola, etc.
│   │       ├── CallbackHandler.js     # Callbacks de botones inline
│   │       └── PendingActionHandler.js # Acciones pendientes (whitelist, etc.)
│   ├── core/
│   │   ├── ClaudePrintSession.js # Sesión Claude CLI con persistencia
│   │   ├── ConsoleSession.js     # Sesión de consola bash
│   │   ├── EventBus.js           # Bus de eventos centralizado
│   │   ├── Logger.js             # Logger con niveles y archivo
│   │   └── systemStats.js        # Stats del sistema (CPU, RAM, uptime)
│   ├── services/
│   │   └── ConversationService.js # Lógica de conversación con IA
│   ├── providers/
│   │   ├── index.js             # Registry de proveedores IA
│   │   ├── anthropic.js         # Anthropic SDK directo
│   │   ├── claude-code.js       # Claude Code CLI (claude -p)
│   │   ├── gemini.js            # Google Gemini
│   │   ├── openai.js            # OpenAI ChatGPT
│   │   ├── grok.js              # Grok (xAI)
│   │   └── ollama.js            # Ollama (modelos locales)
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
│   │   ├── ChatSettingsRepository.js # Persistencia: provider, cwd, sesión, modo
│   │   └── BotsRepository.js    # Persistencia de configuración de bots
│   ├── mcp/
│   │   ├── index.js             # Router MCP (herramientas expuestas)
│   │   └── ShellSession.js      # Sesión shell para MCP
│   ├── mcps.js                  # Gestión de servidores MCP externos
│   ├── tts.js                   # Módulo TTS central
│   ├── tts-config.js            # Configuración de proveedores TTS
│   ├── agents.js                # CRUD de agentes
│   ├── skills.js                # Skills locales + búsqueda ClawHub
│   ├── memory.js                # Memoria persistente por agente (SQLite)
│   ├── memory-consolidator.js   # Consolidación periódica de memoria
│   ├── embeddings.js            # Embeddings para búsqueda semántica
│   ├── tools.js                 # Herramientas disponibles para agentes
│   ├── reminders.js             # Recordatorios/alarmas programadas
│   ├── transcriber.js           # Transcripción audio con Whisper
│   ├── provider-config.js       # Configuración de proveedores IA
│   ├── nodriza.js               # Conexión a nodriza (señalización P2P + WebRTC)
│   ├── nodriza-config.js        # Configuración de nodriza (env + JSON)
│   ├── nodriza-config.json      # Config nodriza persistida (auto-generado)
│   ├── events.js                # EventEmitter global (legacy)
│   ├── ecosystem.config.js      # Configuración PM2
│   └── test/                    # Tests unitarios
└── client/
    └── src/
        ├── App.jsx
        └── components/
            ├── TerminalPanel.jsx
            ├── TabBar.jsx
            ├── AgentsPanel.jsx
            ├── ProvidersPanel.jsx
            ├── CommandBar.jsx
            └── TelegramPanel.jsx
```

## Comandos

```bash
# Server (desarrollo)
cd server && npm install && npm start  # http://localhost:3002

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
- **SQLite usa sql.js (WASM)**, no better-sqlite3 — no requiere compilación nativa (funciona en Windows y Linux sin Visual Studio Build Tools).
  - El wrapper `storage/sqlite-wrapper.js` expone API compatible con better-sqlite3 (`prepare().run/get/all`, `pragma()`, `exec()`).
  - La DB vive en memoria y se auto-persiste a disco con debounce de 500ms.
  - La inicialización es async (`await Database.initialize()` en `memory.initDBAsync()`).
- **spawn de `claude` CLI** usa `shell: true` en Windows (`process.platform === 'win32'`) para resolver `.cmd`.
- **Persistencia de sesión Claude**: se guarda `claudeSessionId`, `messageCount`, `cwd` y `claudeMode` en SQLite. Al reiniciar el servidor, se restaura la sesión con `--resume`. Si `--resume` falla, se reintenta como nueva sesión automáticamente.
- **Persistencia de modo de permisos**: `claudeMode` (`ask`/`auto`/`plan`) se guarda en `chat_settings` y se restaura al reconectar.
- **TTS multi-proveedor**: configurado en `tts-config.js`/`tts-config.json`. Cada proveedor implementa `synthesize(text, opts)` → `Buffer`. Edge TTS y Piper funcionan offline.
- **Providers IA**: 6 proveedores (Anthropic, Claude Code, Gemini, OpenAI, Grok, Ollama). Cada uno implementa `sendMessage(messages, opts)` con streaming. Se seleccionan por chat desde Telegram.
- **MCP**: servidor MCP integrado (`mcp/index.js`) que expone herramientas del sistema. `mcps.js` gestiona conexiones a MCPs externos.
- **PM2**: el servidor se gestiona con PM2 en producción. `ecosystem.config.js` carga `.env` automáticamente y usa `--stack-size=65536`. Auto-arranque con systemd.

## Nodriza (P2P con deskcritter)

Terminal-live actúa como "server" en nodriza para aceptar conexiones P2P de clients como deskcritter.

### Configuración

Variables de entorno (`.env`) tienen prioridad sobre `nodriza-config.json`:

```env
NODRIZA_ENABLED=true                            # activar/desactivar
NODRIZA_URL=ws://localhost:3000/signaling        # endpoint de nodriza
NODRIZA_SERVER_ID=<id del server en nodriza>     # ID obtenido del dashboard
NODRIZA_API_KEY=<api key del server>             # API key obtenida al crear el server
```

En producción se usa `nodriza-config.json` (patrón idéntico a `provider-config.js`).

### Módulos

- **`nodriza-config.js`** — Config con patrón env > JSON. Funciones: `getConfig()`, `setConfig(partial)`, `isEnabled()`.
- **`nodriza.js`** — Clase `NodrizaConnection`:
  - Conecta al WebSocket de nodriza `/signaling` y se autentica como `role: "server"`
  - Escucha `peer:connected`/`peer:disconnected` para crear/cerrar RTCPeerConnection
  - Usa `node-datachannel` (WebRTC nativo para Node.js) para crear DataChannels
  - Cuando un DataChannel se abre, crea un `P2PBotAdapter` que adapta el DataChannel a la interfaz de TelegramBot
  - Reconexión automática con backoff exponencial (2s → 30s)
- **`channels/p2p/P2PBotAdapter.js`** — Adaptador que expone la interfaz de TelegramBot sobre DataChannel P2P:
  - Reutiliza `CommandHandler` y `CallbackHandler` de Telegram (mismos comandos /start, /cd, etc.)
  - Soporta transcripción de audio recibido por P2P (reenvía a Whisper del server)
  - Soporta TTS sobre P2P (envía audio sintetizado al client por DataChannel)

### Flujo P2P

```
terminal-live ──ws──→ nodriza ←──ws── deskcritter
     │                                    │
     │── signal:offer ──→ nodriza ──→─────│
     │←── signal:answer ──← nodriza ←─────│
     │←→── ice-candidate ──→←─────────────│
     │                                    │
     │════════ P2P DataChannel ═══════════│
     │                                    │
     │←─ {type:"init", sessionType:"ai"} ─│
     │──→ {type:"session_id"} ────────────│
     │←─ {type:"input", data:"..."} ──────│
     │──→ {type:"output", data:"..."} ────│
```

El DataChannel transporta el mismo protocolo JSON que el WebSocket directo.

### REST API

```
GET  /api/nodriza/config    — config actual (apiKey censurada)
PUT  /api/nodriza/config    — actualizar config { url, serverId, apiKey, enabled }
GET  /api/nodriza/status    — { connected, peers: [...] }
POST /api/nodriza/reconnect — forzar reconexión
```

### DI (bootstrap.js)

`NodrizaConnection` se instancia en `bootstrap.js` si `isEnabled()` es true y se expone como `_container.nodriza`. Se inicia en `index.js` después de que el server HTTP esté escuchando.

## Arquitectura detallada

Ver `implementar/ARQUITECTURA.md` para documentación completa de módulos, API REST, protocolo WebSocket, plan multi-proveedor y notas de implementación.
