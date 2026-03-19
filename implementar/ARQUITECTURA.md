# Clawmint — Arquitectura e Implementación

> Documento de referencia para entender, extender o reimplementar el sistema.

---

## Resumen del sistema

**Clawmint** es un servidor de terminales en tiempo real accesible desde el navegador y desde Telegram. Combina:

- **PTY virtual** (`node-pty`) para ejecutar procesos reales del sistema operativo.
- **WebSocket** para streaming bidireccional de terminal (xterm.js en el cliente).
- **HTTP REST API** para operaciones sobre sesiones, agentes, skills, memoria y bots.
- **SSE** (Server-Sent Events) para output en tiempo real sin WebSocket.
- **6 proveedores de IA** (Anthropic, Claude Code CLI, Gemini, OpenAI, Grok, Ollama).
- **Bot de Telegram** modular con polling, streaming progresivo y persistencia completa.
- **Sistema TTS multi-proveedor** con 6 engines de voz.
- **Servidor MCP** integrado con herramientas expuestas.
- **Persistencia SQLite** (sql.js WASM) para sesiones, settings, memoria y modo de permisos.

---

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Runtime | Node.js 22+ (CommonJS, `'use strict'`) |
| HTTP / WS | Express 4 + `ws` |
| Terminal | `node-pty` (spawn PTY real) |
| IA — Providers | Anthropic SDK, Claude Code CLI, Gemini, OpenAI, Grok (xAI), Ollama |
| TTS | Edge TTS, Piper TTS, SpeechT5, ElevenLabs, OpenAI TTS, Google TTS |
| Cliente | React 18 + Vite + xterm.js |
| Persistencia | SQLite via sql.js (WASM) + JSON planos |
| Skills | Archivos `SKILL.md` con frontmatter YAML |
| Mensajería | Telegram Bot API (long polling) |
| Transcripción | Whisper (Xenova/whisper-medium) |
| Procesos | PM2 + systemd (auto-arranque) |

---

## Estructura de archivos

```
clawmint/
├── server/
│   ├── index.js                 # HTTP, WebSocket, rutas REST (puerto 3002)
│   ├── bootstrap.js             # Inicialización de módulos (Telegram, TTS, etc.)
│   ├── sessionManager.js        # PtySession + pool de sesiones
│   │
│   ├── channels/
│   │   ├── BaseChannel.js       # Clase base para canales de mensajería
│   │   └── telegram/
│   │       ├── TelegramChannel.js      # Bot principal + envío/recepción
│   │       ├── CommandHandler.js       # /start, /cd, /modo, /permisos, etc.
│   │       ├── CallbackHandler.js      # Callbacks de botones inline
│   │       └── PendingActionHandler.js # Acciones pendientes (whitelist, etc.)
│   │
│   ├── core/
│   │   ├── ClaudePrintSession.js  # Sesión Claude CLI con persistencia
│   │   ├── ConsoleSession.js      # Sesión de consola bash
│   │   ├── EventBus.js            # Bus de eventos centralizado
│   │   ├── Logger.js              # Logger con niveles y archivo
│   │   └── systemStats.js         # Stats del sistema (CPU, RAM, uptime)
│   │
│   ├── services/
│   │   └── ConversationService.js # Orquestador de conversación con IA
│   │
│   ├── providers/
│   │   ├── index.js              # Registry + factory de proveedores
│   │   ├── anthropic.js          # Anthropic SDK directo
│   │   ├── claude-code.js        # Claude Code CLI (claude -p)
│   │   ├── gemini.js             # Google Gemini
│   │   ├── openai.js             # OpenAI ChatGPT
│   │   ├── grok.js               # Grok (xAI) con streaming
│   │   └── ollama.js             # Ollama (modelos locales)
│   │
│   ├── voice-providers/
│   │   ├── index.js              # Registry de proveedores TTS
│   │   ├── edge-tts.js           # Microsoft Edge TTS (offline)
│   │   ├── piper-tts.js          # Piper TTS (offline, español nativo)
│   │   ├── speecht5.js           # SpeechT5 (@huggingface/transformers)
│   │   ├── elevenlabs.js         # ElevenLabs API
│   │   ├── openai-tts.js         # OpenAI TTS API
│   │   └── google-tts.js         # Google Cloud TTS
│   │
│   ├── storage/
│   │   ├── sqlite-wrapper.js     # Wrapper sql.js compatible con better-sqlite3
│   │   ├── DatabaseProvider.js   # Inicialización y acceso a la DB
│   │   ├── ChatSettingsRepository.js # provider, cwd, sesión, modo por chat
│   │   └── BotsRepository.js     # Configuración persistente de bots
│   │
│   ├── mcp/
│   │   ├── index.js              # Router MCP (herramientas expuestas)
│   │   └── ShellSession.js       # Sesión shell para MCP
│   │
│   ├── mcps.js                   # Gestión de servidores MCP externos
│   ├── tts.js                    # Módulo TTS central
│   ├── tts-config.js             # Configuración de proveedores TTS
│   ├── agents.js                 # CRUD de agentes
│   ├── skills.js                 # Skills locales + búsqueda ClawHub
│   ├── memory.js                 # Memoria persistente por agente (SQLite)
│   ├── memory-consolidator.js    # Consolidación periódica de memoria
│   ├── embeddings.js             # Embeddings para búsqueda semántica
│   ├── tools.js                  # Herramientas disponibles para agentes
│   ├── reminders.js              # Recordatorios/alarmas programadas
│   ├── transcriber.js            # Transcripción audio con Whisper
│   ├── provider-config.js        # Configuración de proveedores IA
│   ├── events.js                 # EventEmitter global (legacy)
│   ├── ecosystem.config.js       # Configuración PM2
│   └── test/                     # Tests unitarios
│
└── client/
    └── src/
        ├── App.jsx
        └── components/
            ├── TerminalPanel.jsx   # xterm.js + WebSocket
            ├── TabBar.jsx          # Pestañas de sesiones
            ├── AgentsPanel.jsx     # CRUD de agentes
            ├── ProvidersPanel.jsx  # Selector de proveedor IA
            ├── CommandBar.jsx      # Acciones rápidas
            └── TelegramPanel.jsx   # Gestión de bots
```

---

## Módulos del servidor

### `sessionManager.js` — PtySession

Clase central. Cada instancia representa un proceso vivo en el OS.

```
PtySession
├── id: UUID
├── type: 'pty'
├── title: string (command o shell)
├── active: boolean
├── _pty: node-pty instance
├── _outputBuffer: [{ts, data}]   ← ring buffer (MAX 5000 entradas)
└── _outputListeners: Map<id, cb>

Métodos:
  input(text)                       → escribe al PTY
  injectOutput(text)                → inyecta al buffer SIN tocar el PTY
  resize(cols, rows)                → redimensiona
  sendMessage(text, opts)           → envía + espera estabilización (Promise)
  onOutput(cb) → unsub()            → suscripción push al output
  getOutputSince(ts) → string       → pull del buffer desde timestamp
  destroy()                         → mata el PTY
```

---

### `providers/` — Sistema multi-proveedor de IA

6 proveedores implementados. Cada uno expone `sendMessage(messages, opts)` con streaming.

| Provider | Archivo | Dependencia | Streaming |
|----------|---------|-------------|-----------|
| Anthropic | `anthropic.js` | `@anthropic-ai/sdk` | ✅ SSE |
| Claude Code | `claude-code.js` | CLI `claude -p` | ✅ stream-json via PTY |
| Gemini | `gemini.js` | `@google/generative-ai` | ✅ chunk iterator |
| OpenAI | `openai.js` | `openai` | ✅ SSE |
| Grok | `grok.js` | HTTP directo (xAI API) | ✅ SSE |
| Ollama | `ollama.js` | HTTP directo (localhost) | ✅ NDJSON |

`providers/index.js` actúa como registry: `providers.get(name)` → instancia del provider.

El provider se selecciona **por chat** desde Telegram (`/provider`) o por agente.

---

### `services/ConversationService.js` — Orquestador

Punto central de conversación con IA. Responsabilidades:

- Seleccionar provider según chat/agente
- Construir contexto (system prompt + memoria + skills)
- Manejar `--resume` para Claude Code (con fallback automático si falla)
- Extraer y aplicar operaciones de memoria del response
- Retornar respuesta + metadata (costo, tokens)

---

### `channels/telegram/` — Bot de Telegram

Arquitectura modular con 4 componentes:

| Componente | Responsabilidad |
|------------|-----------------|
| `TelegramChannel.js` | Bot principal: polling, envío/recepción, edición progresiva, persistencia |
| `CommandHandler.js` | Parsing y ejecución de `/comandos` (40+ comandos) |
| `CallbackHandler.js` | Menú inline con botones (config, modelo, provider, voz, permisos) |
| `PendingActionHandler.js` | Flujos multi-paso (agregar whitelist, etc.) |

**Persistencia completa en SQLite** (`ChatSettingsRepository`):
- `provider` y `model` por chat
- `cwd` (directorio de trabajo)
- `claude_session_id` + `message_count` (resume tras reinicio)
- `claude_mode` (`ask`/`auto`/`plan`) — sobrevive reinicios

**Edición progresiva:** envía `⏳` inmediatamente, edita el mismo mensaje con cada chunk (throttle 1500ms).

---

### `core/ClaudePrintSession.js` — Sesión Claude CLI

Ejecuta `claude -p <texto> --output-format stream-json` en un PTY. Soporta:

- `--resume <sessionId>` para continuar contexto
- `--permission-mode` configurable (`ask`/`auto`/`plan`)
- Fallback automático: si `--resume` falla, reintenta como sesión nueva
- Persistencia de `sessionId`, `messageCount` y `cwd` en SQLite

---

### `storage/` — Capa de persistencia

| Componente | Tabla/Función |
|------------|---------------|
| `sqlite-wrapper.js` | Wrapper sql.js con API compatible better-sqlite3 |
| `DatabaseProvider.js` | Singleton de inicialización de DB |
| `ChatSettingsRepository.js` | `chat_settings`: provider, model, cwd, session, mode |
| `BotsRepository.js` | Configuración persistente de bots Telegram |

La DB vive en memoria y se auto-persiste a disco con debounce de 500ms.

---

### `voice-providers/` — Sistema TTS

6 proveedores. Cada uno implementa `synthesize(text, opts)` → `Buffer`.

| Provider | Offline | Español nativo |
|----------|---------|----------------|
| Edge TTS | ✅ | ✅ |
| Piper TTS | ✅ | ✅ |
| SpeechT5 | ✅ | ❌ |
| ElevenLabs | ❌ | ✅ |
| OpenAI TTS | ❌ | ✅ |
| Google TTS | ❌ | ✅ |

Configuración en `tts-config.js` / `tts-config.json`.

---

### `mcp/` — Servidor MCP

- `index.js`: router que expone herramientas del sistema como MCP tools
- `ShellSession.js`: sesión shell dedicada para operaciones MCP
- `mcps.js`: gestión de conexiones a servidores MCP externos (configs en `server/mcps/`)

---

### Otros módulos

| Módulo | Función |
|--------|---------|
| `memory.js` | Memoria por agente en SQLite (notes, tags, links, grafo) |
| `memory-consolidator.js` | Consolidación periódica cada 2 min |
| `embeddings.js` | Embeddings para búsqueda semántica en memoria |
| `tools.js` | Herramientas que los agentes pueden invocar |
| `reminders.js` | Recordatorios/alarmas (`/recordar`, `/recordatorios`) |
| `transcriber.js` | Transcripción de audio con Whisper (mensajes de voz Telegram) |
| `agents.js` | CRUD de agentes (JSON + carpeta `agents/`) |
| `skills.js` | Skills en Markdown + búsqueda en ClawHub |
| `bootstrap.js` | Inicialización ordenada de todos los módulos |

---

## API REST

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/sessions` | Listar sesiones activas |
| POST | `/api/sessions` | Crear sesión `{type, command, cols, rows}` |
| GET | `/api/sessions/:id` | Info de sesión |
| DELETE | `/api/sessions/:id` | Cerrar sesión |
| POST | `/api/sessions/:id/input` | Input raw `{text}` |
| POST | `/api/sessions/:id/message` | Send + esperar respuesta `{text}` |
| GET | `/api/sessions/:id/stream` | SSE: output en tiempo real |
| GET | `/api/sessions/:id/output?since=0` | Pull del buffer |
| GET/POST/PATCH/DELETE | `/api/agents/...` | CRUD de agentes |
| GET/POST/DELETE | `/api/skills/...` | Gestión de skills |
| GET | `/api/skills/search?q=` | Buscar en ClawHub |
| GET/POST/DELETE/PATCH | `/api/telegram/bots/...` | Gestión de bots |
| GET | `/api/providers` | Listar proveedores IA |
| GET | `/api/memory/graph` | Grafo de memoria (nodos + links) |
| GET | `/api/memory/:agentKey/search` | Búsqueda en memoria |

---

## Protocolo WebSocket

```
Cliente → Servidor:
  { type: 'init', sessionId?, sessionType?, command?, cols?, rows?, systemPrompt? }
  { type: 'input', data: string }
  { type: 'resize', cols, rows }

Servidor → Cliente:
  { type: 'session_id', id }
  { type: 'output', data: string }
  { type: 'exit' }
  { type: 'telegram_session', sessionId, from, text }
```

---

## Flujo de datos

```
Usuario (browser / Telegram / MCP)
       │
       ▼
   WebSocket / HTTP / Telegram API / MCP
       │
       ▼
   index.js + bootstrap.js (router)
       │
       ├──→ PtySession (node-pty) → proceso del OS
       │
       ├──→ ConversationService → Provider IA
       │         │                    ├─→ Anthropic SDK
       │         │                    ├─→ Claude Code CLI
       │         │                    ├─→ Gemini SDK
       │         │                    ├─→ OpenAI SDK
       │         │                    ├─→ Grok HTTP
       │         │                    └─→ Ollama HTTP
       │         │
       │         ├──→ memory.js (contexto + persist)
       │         └──→ tools.js (herramientas)
       │
       ├──→ TTS → voice-providers/ → Buffer audio
       │
       └──→ MCP Router → herramientas expuestas
```

---

## Producción (PM2 + systemd)

```bash
# Arrancar
cd server && pm2 start ecosystem.config.js

# Auto-arranque al encender
pm2 startup    # genera comando sudo
pm2 save       # guarda estado

# Operaciones
pm2 restart clawmint
pm2 logs clawmint
pm2 status
```

`ecosystem.config.js` carga `.env` automáticamente y usa `--stack-size=65536`.

---

## Notas de implementación

- **sql.js (WASM)**: no requiere compilación nativa (funciona en Windows y Linux sin build tools). DB en memoria con auto-persist a disco (debounce 500ms).
- **node-pty + WSL2**: requiere `--stack-size=65536` para evitar stack overflow. Ejecutar `npm rebuild node-pty` al cambiar versión de Node.
- **Claude CLI**: se spawna con `pty.spawn` (no `child_process`) para forzar flush. Se eliminan `CLAUDECODE` y `CLAUDE_CODE_ENTRYPOINT` del env.
- **Telegram edits**: throttle 1500ms (límite de la API).
- **Persistencia de sesión**: `claudeSessionId`, `messageCount`, `cwd` y `claudeMode` en SQLite. Resume automático con fallback a sesión nueva.
