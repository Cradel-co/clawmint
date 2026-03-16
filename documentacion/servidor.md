> Última modificación: 2026-03-16

# Módulo Servidor

Backend Node.js que expone una API REST, un servidor WebSocket para terminales PTY y la integración con Telegram.

---

## Índice

- [Estructura de archivos](#estructura-de-archivos)
- [Variables de entorno](#variables-de-entorno)
- [Módulos](#módulos)
  - [index.js — HTTP y WebSocket](#indexjs--http-y-websocket)
  - [sessionManager.js — Sesiones PTY](#sessionmanagerjs--sesiones-pty)
  - [telegram.js — Bot de Telegram](#telegramjs--bot-de-telegram)
  - [agents.js — Agentes de rol](#agentsjs--agentes-de-rol)
  - [providers/ — Providers de IA](#providers--providers-de-ia)
  - [provider-config.js — Configuración de API keys](#provider-configjs--configuración-de-api-keys)
  - [skills.js — Skills](#skillsjs--skills)
  - [memory.js — Memoria por agente](#memoryjs--memoria-por-agente)
  - [events.js — EventEmitter global](#eventsjs--eventemitter-global)
- [API REST](#api-rest)
  - [Sesiones](#sesiones)
  - [Agentes](#agentes)
  - [Providers](#providers)
  - [Skills](#skills)
  - [Memoria](#memoria)
  - [Telegram](#telegram)
  - [Logs](#logs)
- [WebSocket](#websocket)
- [Comandos del bot de Telegram](#comandos-del-bot-de-telegram)

---

## Estructura de archivos

```
server/
├── index.js            # Punto de entrada: HTTP, WebSocket, rutas REST
├── sessionManager.js   # PtySession, pool de sesiones, I/O PTY
├── telegram.js         # TelegramBot, ClaudePrintSession, BotManager
├── agents.js           # CRUD de agentes (AgentManager)
├── providers/          # Adaptadores de providers de IA
│   ├── anthropic.js
│   ├── gemini.js
│   ├── openai.js
│   └── claude-code.js
├── provider-config.js  # Lectura/escritura de provider-config.json
├── skills.js           # Skills locales + búsqueda en ClawHub
├── memory.js           # Archivos de memoria por agente
├── events.js           # EventEmitter global (telegram:session, etc.)
├── tools.js            # Herramientas disponibles para agentes con tool use
├── mcps.js             # Integración MCP
├── .env.example        # Plantilla de variables de entorno
└── package.json
```

---

## Variables de entorno

Crear `server/.env` copiando `server/.env.example`. El servidor las carga con `--env-file-if-exists` (Node 22, sin dependencia de dotenv).

| Variable | Descripción | Default |
|---|---|---|
| `BOT_TOKEN` | Token del bot de Telegram ([@BotFather](https://t.me/BotFather)) | — |
| `BOT_KEY` | Identificador interno del bot | `dev` |
| `BOT_DEFAULT_AGENT` | Agente por defecto para chats nuevos | `claude` |
| `BOT_WHITELIST` | Chat IDs autorizados separados por coma | *(sin restricción)* |
| `BOT_RATE_LIMIT` | Segundos mínimos entre mensajes por usuario | `30` |
| `BOT_RATE_LIMIT_KEYWORD` | Palabra clave que saltea el rate limit | — |
| `PORT` | Puerto del servidor HTTP/WS | `3001` |

> Si `bots.json` no existe al arrancar, el servidor lo crea automáticamente desde estas variables. Si ya existe, las variables son ignoradas para el bot.

---

## Módulos

### index.js — HTTP y WebSocket

Punto de entrada. Inicializa Express, el servidor HTTP y el WebSocketServer. Carga todos los demás módulos y los expone vía API REST.

**Sesión AI (`startAISession`):** maneja conversaciones con providers de IA directamente sobre el WebSocket, sin PTY. Persiste el historial en el Map `aiSessionHistories` (en memoria, hasta 24h) para que las reconexiones retomen la conversación.

### sessionManager.js — Sesiones PTY

Gestiona instancias de `PtySession`, cada una con un proceso PTY real (`node-pty`). Las sesiones persisten aunque el WebSocket se cierre — el cliente puede volver a adjuntarse con el mismo `sessionId`.

Métodos principales: `create()`, `get()`, `list()`, `destroy()`.

### telegram.js — Bot de Telegram

Tres capas:

| Clase | Responsabilidad |
|---|---|
| `ClaudePrintSession` | Ejecuta `claude -p` en modo no-interactivo y streamea la respuesta por chunks |
| `TelegramBot` | Maneja un bot individual: long polling, comandos, routing de mensajes, rate limit |
| `BotManager` | Singleton que gestiona múltiples bots, persistencia en `bots.json` |

**Routing de mensajes:** `_sendToSession()` determina el provider a usar según:
1. `chat.provider` (configurado por el usuario)
2. `chat.activeAgent?.provider` (provider del agente activo)
3. `'claude-code'` (default)

Si el provider no es `claude-code`, usa `_sendToApiProvider()` con el provider de IA seleccionado.

### agents.js — Agentes de rol

CRUD persistido en `agents.json`. Cada agente tiene:

| Campo | Tipo | Descripción |
|---|---|---|
| `key` | string | Identificador único (letras, números, `_`, `-`) |
| `command` | string\|null | Comando de shell a ejecutar (null = bash) |
| `description` | string | Descripción corta |
| `prompt` | string | System prompt del agente |
| `provider` | string | Provider de IA (`anthropic`, `gemini`, `openai`, `claude-code`) |
| `memoryFiles` | string[] | Archivos de memoria a inyectar |

Los agentes en `server/agents/` (archivos `.json` individuales) tienen prioridad sobre `agents.json`.

### providers/ — Providers de IA

Cada provider exporta una función `chat({ systemPrompt, history, apiKey, model })` que es un generador async con eventos:

| Evento | Datos |
|---|---|
| `{ type: 'text', text }` | Chunk de texto acumulado |
| `{ type: 'tool_call', name, args }` | Llamada a herramienta |
| `{ type: 'tool_result', result }` | Resultado de herramienta |
| `{ type: 'done', fullText }` | Respuesta completa |

### provider-config.js — Configuración de API keys

Lee y escribe `provider-config.json`. Expone `getApiKey(name)`, `setProvider(name, { apiKey, model })` y `setDefault(name)`.

### skills.js — Skills

Skills locales en `server/skills/<slug>/SKILL.md`. Se inyectan como contexto adicional al system prompt del agente. Soporta búsqueda e instalación desde ClawHub (`searchClawHub(q)`, `installSkill(slug)`).

### memory.js — Memoria por agente

Archivos de texto en `server/memory/<agentKey>/`. Se inyectan al inicio de cada conversación. El agente puede escribir en memoria usando la sintaxis `<memory:write file="nombre">contenido</memory:write>` en su respuesta.

### events.js — EventEmitter global

Permite comunicación desacoplada entre módulos. Eventos actuales:

| Evento | Payload | Emisor |
|---|---|---|
| `telegram:session` | `{ sessionId, from, text }` | `telegram.js` |

---

## API REST

Base URL: `http://localhost:3001`

### Sesiones

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/sessions` | Listar sesiones activas |
| `POST` | `/api/sessions` | Crear sesión `{ type?, command?, cols?, rows? }` |
| `GET` | `/api/sessions/:id` | Info de sesión |
| `DELETE` | `/api/sessions/:id` | Cerrar sesión |
| `POST` | `/api/sessions/:id/input` | Enviar input raw `{ text }` |
| `POST` | `/api/sessions/:id/message` | Enviar mensaje y esperar respuesta `{ text }` → `{ response, raw }` |
| `GET` | `/api/sessions/:id/stream` | SSE: output en tiempo real |
| `GET` | `/api/sessions/:id/output?since=0` | Output buffereado desde timestamp |

### Agentes

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/agents` | Listar agentes |
| `POST` | `/api/agents` | Crear agente `{ key, command?, description?, prompt?, provider? }` |
| `PATCH` | `/api/agents/:key` | Actualizar agente (mismos campos, todos opcionales) |
| `DELETE` | `/api/agents/:key` | Eliminar agente |

### Providers

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/providers` | Listar providers con estado y modelo actual |
| `GET` | `/api/providers/config` | Config completa (API keys parcialmente ocultadas) |
| `PUT` | `/api/providers/default` | Cambiar provider por defecto `{ provider }` |
| `PUT` | `/api/providers/:name` | Configurar provider `{ apiKey?, model? }` |

### Skills

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/skills` | Listar skills instalados |
| `POST` | `/api/skills/install` | Instalar skill `{ slug }` |
| `GET` | `/api/skills/search?q=` | Buscar en ClawHub |
| `DELETE` | `/api/skills/:slug` | Eliminar skill |

### Memoria

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/memory/:agentKey` | Listar archivos de memoria |
| `GET` | `/api/memory/:agentKey/:filename` | Leer archivo → `{ content }` |
| `PUT` | `/api/memory/:agentKey/:filename` | Escribir archivo `{ content }` |
| `POST` | `/api/memory/:agentKey/:filename/append` | Agregar al final `{ content }` |
| `DELETE` | `/api/memory/:agentKey/:filename` | Eliminar archivo |

### Telegram

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/telegram/bots` | Listar bots |
| `POST` | `/api/telegram/bots` | Agregar bot `{ key, token }` |
| `DELETE` | `/api/telegram/bots/:key` | Eliminar bot |
| `POST` | `/api/telegram/bots/:key/start` | Iniciar bot |
| `POST` | `/api/telegram/bots/:key/stop` | Detener bot |
| `PATCH` | `/api/telegram/bots/:key` | Configurar `{ defaultAgent?, whitelist?, rateLimit?, rateLimitKeyword? }` |
| `GET` | `/api/telegram/bots/:key/chats` | Listar chats del bot |
| `POST` | `/api/telegram/bots/:key/chats/:chatId/session` | Vincular sesión PTY `{ sessionId? }` |
| `DELETE` | `/api/telegram/bots/:key/chats/:chatId` | Desconectar chat |

### Logs

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/logs/config` | Ver estado del logger |
| `POST` | `/api/logs/config` | Cambiar estado `{ enabled: bool }` |
| `GET` | `/api/logs/tail?lines=100` | Últimas N líneas del log |
| `DELETE` | `/api/logs` | Limpiar log |

---

## WebSocket

Conectar a `ws://localhost:3001`.

### Mensaje de inicio (`init`)

```json
{
  "type": "init",
  "sessionType": "pty",
  "sessionId": "uuid-opcional",
  "command": "bash",
  "cols": 80,
  "rows": 24
}
```

| `sessionType` | Comportamiento |
|---|---|
| `pty` | Crea o retoma una sesión PTY |
| `ai` | Sesión de conversación IA (sin PTY) |
| `listener` | Solo recibe broadcasts, sin PTY |

El servidor responde con `{ type: "session_id", id: "uuid" }`. El cliente debe guardar ese ID para retomar la sesión en reconexiones.

### Mensajes del servidor → cliente

| Tipo | Datos |
|---|---|
| `session_id` | `{ id }` |
| `output` | `{ data: string }` |
| `exit` | `{}` |
| `telegram_session` | `{ sessionId, from, text }` |

### Mensajes del cliente → servidor

| Tipo | Datos |
|---|---|
| `input` | `{ data: string }` |
| `resize` | `{ cols, rows }` |

---

## Comandos del bot de Telegram

| Comando | Descripción |
|---|---|
| `/start` | Saludo e inicio de sesión |
| `/nueva` | Nueva conversación (resetea contexto) |
| `/modelo [nombre]` | Ver o cambiar modelo de Claude |
| `/agentes` | Listar agentes disponibles |
| `/<key>` | Activar agente de rol |
| `/basta` | Desactivar agente de rol |
| `/skills` | Ver skills instalados |
| `/buscar-skill` | Buscar e instalar skills de ClawHub |
| `/estado` | Estado de la sesión actual |
| `/costo` | Costo acumulado de la sesión |
| `/memoria` | Ver archivos de memoria del agente activo |
| `/status-vps` | CPU, RAM y disco del servidor |
| `/ls [path]` | Navegar el sistema de archivos |
| `/dir [path]` | Alias de `/ls` |
| `/cat [archivo]` | Ver contenido de archivo |
| `/mkdir [path]` | Crear directorio |
| `/monitor` | Estado de procesos del sistema |
| `/id` | Ver tu chat ID de Telegram |
