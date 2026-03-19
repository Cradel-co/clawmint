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
- **IA:** Anthropic SDK + `claude -p` (CLI) + Grok (xAI) + Ollama (local)
- **TTS:** Edge TTS, Piper TTS, SpeechT5, ElevenLabs, OpenAI TTS, Google TTS
- **Persistencia:** SQLite via sql.js (WASM) + JSON planos (`agents.json`, `bots.json`)
- **Mensajería:** Telegram Bot API (long polling)
- **Procesos:** PM2 (auto-restart, logs, monitoreo)

## Estructura

```
clawmint/
├── server/
│   ├── index.js              # HTTP, WebSocket, rutas REST (puerto 3002)
│   ├── bootstrap.js          # Inicialización de módulos (Telegram, TTS, etc.)
│   ├── sessionManager.js     # PtySession + pool de sesiones
│   ├── channels/
│   │   └── telegram/
│   │       ├── TelegramChannel.js   # TelegramBot + manejo de mensajes
│   │       ├── CommandHandler.js    # Comandos /start, /cd, /consola, etc.
│   │       └── CallbackHandler.js   # Callbacks de botones inline
│   ├── services/
│   │   └── ConversationService.js   # Lógica de conversación con IA
│   ├── providers/
│   │   ├── index.js          # Registry de proveedores
│   │   ├── grok.js           # Provider Grok (xAI)
│   │   └── ollama.js         # Provider Ollama (local)
│   ├── voice-providers/
│   │   ├── index.js          # Registry de proveedores TTS
│   │   ├── edge-tts.js       # Microsoft Edge TTS
│   │   ├── piper-tts.js      # Piper TTS (offline, español nativo)
│   │   ├── speecht5.js       # SpeechT5 (@huggingface/transformers)
│   │   ├── elevenlabs.js     # ElevenLabs API
│   │   ├── openai-tts.js     # OpenAI TTS API
│   │   └── google-tts.js     # Google Cloud TTS
│   ├── storage/
│   │   └── sqlite-wrapper.js # Wrapper sql.js compatible con better-sqlite3
│   ├── core/
│   │   └── ClaudePrintSession.js # Sesión Claude CLI con persistencia
│   ├── tts.js                # Módulo TTS central
│   ├── tts-config.js         # Configuración de proveedores TTS
│   ├── agents.js             # CRUD de agentes
│   ├── skills.js             # Skills locales + búsqueda ClawHub
│   ├── memory.js             # Memoria persistente por agente
│   ├── transcriber.js        # Transcripción audio con Whisper
│   ├── events.js             # EventEmitter global
│   └── ecosystem.config.js   # Configuración PM2
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
- **Persistencia de sesión Claude**: se guarda `claudeSessionId`, `messageCount` y `cwd` en SQLite. Al reiniciar el servidor, se restaura la sesión con `--resume`. Si `--resume` falla, se reintenta como nueva sesión automáticamente.
- **TTS multi-proveedor**: configurado en `tts-config.js`/`tts-config.json`. Cada proveedor implementa `synthesize(text, opts)` → `Buffer`. Edge TTS y Piper funcionan offline.
- **PM2**: el servidor se gestiona con PM2 en producción. `ecosystem.config.js` carga `.env` automáticamente y usa `--stack-size=65536`.

## Arquitectura detallada

Ver `implementar/ARQUITECTURA.md` para documentación completa de módulos, API REST, protocolo WebSocket, plan multi-proveedor y notas de implementación.
