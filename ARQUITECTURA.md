# terminal-live — Arquitectura e Implementación

> Documento de referencia para reimplementar o extender el proyecto con cualquier proveedor de IA (Anthropic Claude, Google Gemini, OpenAI ChatGPT).

---

## Resumen del sistema

**terminal-live** es un servidor de terminales en tiempo real accesible desde el navegador y desde Telegram. Combina:

- **PTY virtual** (`node-pty`) para ejecutar procesos reales del sistema operativo.
- **WebSocket** para streaming bidireccional de terminal (xterm.js en el cliente).
- **HTTP REST API** para operaciones sobre sesiones, agentes, skills y bots de Telegram.
- **SSE** (Server-Sent Events) para output en tiempo real sin WebSocket.
- **Sesiones de IA** directas (sin PTY) que conectan al LLM elegido.
- **Bot de Telegram** con polling que actúa como frontend alternativo.

---

## Stack tecnológico actual

| Capa | Tecnología |
|---|---|
| Runtime | Node.js (CommonJS, `'use strict'`) |
| HTTP / WS | Express 4 + `ws` |
| Terminal | `node-pty` (spawn PTY real) |
| IA actual | Anthropic SDK (`@anthropic-ai/sdk`) vía `claude-opus-4-6` |
| IA CLI | `claude -p` (modo print, stream-json) — wrapper `ClaudePrintSession` |
| Cliente | React + Vite + xterm.js |
| Persistencia | JSON planos (`agents.json`, `bots.json`) |
| Skills | Archivos `SKILL.md` con frontmatter YAML |
| Mensajería | Telegram Bot API (long polling, HTTPS nativo) |

---

## Estructura de archivos

```
terminal-live/
├── server/
│   ├── index.js          # Punto de entrada: HTTP, WebSocket, rutas
│   ├── sessionManager.js # Clase PtySession + Map de sesiones activas
│   ├── agents.js         # CRUD de agentes (JSON + carpeta agents/)
│   ├── telegram.js       # Bot Telegram: TelegramBot + ClaudePrintSession
│   ├── skills.js         # Listar, parsear y buscar skills en ClawHub
│   ├── events.js         # EventEmitter global (telegram:session, etc.)
│   ├── agents.json       # Persistencia de agentes
│   ├── bots.json         # Persistencia de bots Telegram
│   └── skills/           # Skills instalados (cada uno: slug/SKILL.md)
└── client/
    ├── src/
    │   ├── App.jsx               # Estado global + tabs + layout
    │   ├── components/
    │   │   ├── TerminalPanel.jsx # xterm.js + WebSocket
    │   │   ├── TabBar.jsx        # Barra de pestañas de sesiones
    │   │   ├── CommandBar.jsx    # Barra inferior con acciones rápidas
    │   │   ├── AgentsPanel.jsx   # CRUD de agentes desde la UI
    │   │   └── TelegramPanel.jsx # Gestión de bots Telegram desde la UI
    └── vite.config.js
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

**Patrón de estabilización en `sendMessage`:**
Espera `stableMs` ms sin nueva salida antes de resolver. Útil para agentes CLI que no indican fin de mensaje.

---

### `agents.js` — AgentManager

Registro de agentes disponibles. Un agente = `{ key, command, description, prompt }`.

- `command: null` → bash puro (shell por defecto)
- `command: 'claude'` → lanza el CLI de Claude
- `prompt` → string de system prompt para agentes de rol en Telegram

Persistencia dual: `agents.json` (editable en UI) + carpeta `agents/` (archivos `.json` privados con prioridad).

---

### `skills.js` — Skills

Los skills son fragmentos de instrucciones en Markdown que se inyectan en el system prompt de los agentes de rol.

**Formato de un skill (`SKILL.md`):**
```markdown
---
name: Nombre del Skill
description: Qué hace
---
Instrucciones para el agente...
```

Fuente de skills: [clawhub.ai](https://clawhub.ai) (búsqueda e instalación desde Telegram o la API).

`buildAgentPrompt(agentDef)` → concatena el prompt del agente + todos los skills instalados.

---

### `telegram.js` — Bot Telegram

**Dos modos de sesión según el agente:**

#### Modo 1: Claude-based (agentes con `command.includes('claude')`)
Usa `ClaudePrintSession`: ejecuta `claude -p <texto> --output-format stream-json` en un PTY para forzar flush inmediato. Parsea eventos JSON del stream. Soporta continuación de contexto con `--continue`.

```
ClaudePrintSession
├── id, createdAt, messageCount
├── model: string | null
├── totalCostUsd, lastCostUsd
└── claudeSessionId: string | null

sendMessage(text, onChunk?) → Promise<string>
  ↳ lanza `claude -p` con node-pty
  ↳ parsea stream_event / assistant / result
  ↳ llama onChunk(partial) para edición progresiva en Telegram
```

#### Modo 2: Agentes PTY (bash, python, etc.)
Crea una `PtySession` normal y usa `sendMessage` con estabilización.

**Comandos de Telegram implementados:**

| Comando | Descripción |
|---|---|
| `/start` | Saludo e inicio |
| `/nueva` / `/reset` | Nueva conversación |
| `/compact` | Compactar contexto Claude |
| `/bash` | Nueva sesión bash |
| `/modelo [nombre]` | Ver/cambiar modelo LLM |
| `/costo` | Costo acumulado de la sesión |
| `/estado` | Estado detallado de sesión |
| `/memoria` | Leer archivos CLAUDE.md / MEMORY.md |
| `/dir` | Directorio de trabajo actual |
| `/agentes` | Listar agentes de rol con prompt |
| `/<key>` | Activar agente de rol |
| `/basta` | Desactivar agente de rol activo |
| `/skills` | Skills instalados |
| `/buscar-skill` | Buscar e instalar skill de ClawHub |
| `/agente [key]` | Ver/cambiar agente activo del bot |
| `/id` | Ver el chat ID propio |
| `/ayuda` | Ayuda completa |

**Rate limiting:** por chat, por ventana de 1 hora. Configurable. Soporta keyword de reseteo.

**Whitelist:** lista de chat IDs permitidos (vacía = todos).

**Edición progresiva:** al recibir un mensaje, envía `⏳` inmediatamente y edita el mismo mensaje con cada chunk (throttle 1500ms), evitando spam de mensajes.

---

### `index.js` — Servidor principal

**HTTP API:**

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/sessions` | Listar sesiones activas |
| POST | `/api/sessions` | Crear sesión `{type, command, cols, rows}` |
| GET | `/api/sessions/:id` | Info de sesión |
| DELETE | `/api/sessions/:id` | Cerrar sesión |
| POST | `/api/sessions/:id/input` | Input raw `{text}` |
| POST | `/api/sessions/:id/message` | Send + esperar respuesta `{text}` |
| GET | `/api/sessions/:id/stream` | SSE: output en tiempo real |
| GET | `/api/sessions/:id/output?since=0` | Pull del buffer desde timestamp |
| GET/POST/PATCH/DELETE | `/api/agents/...` | CRUD de agentes |
| GET/POST/DELETE | `/api/skills/...` | Gestión de skills |
| GET | `/api/skills/search?q=` | Buscar en ClawHub |
| GET/POST/DELETE/PATCH | `/api/telegram/bots/...` | Gestión de bots Telegram |

**WebSocket:** protocolo de mensajes JSON:

```
Cliente → Servidor:
  { type: 'init', sessionId?, sessionType?, command?, cols?, rows?, systemPrompt? }
  { type: 'input', data: string }
  { type: 'resize', cols, rows }

Servidor → Cliente:
  { type: 'session_id', id }
  { type: 'output', data: string }
  { type: 'exit' }
  { type: 'telegram_session', sessionId, from, text }  ← broadcast global
```

**Sesión Claude API (WebSocket sin PTY):**
Cuando `sessionType === 'claude'`, no se crea PTY. El servidor instancia el SDK de Anthropic directamente y hace streaming de tokens al cliente como si fuera output de terminal (con ANSI colors para el prompt).

---

## Abstracciones para multi-proveedor

El sistema actual acopla el LLM en dos lugares:

### Lugar 1: `startClaudeSession()` en `index.js`
Sesión interactiva vía WebSocket. Usa Anthropic SDK con streaming.

### Lugar 2: `ClaudePrintSession` en `telegram.js`
Sesión no-interactiva para Telegram. Actualmente usa `claude -p` (CLI).

---

## Plan de reimplementación multi-proveedor

### Interfaz unificada de proveedor de IA

Para hacer el sistema agnóstico al proveedor, se debe extraer una interfaz común:

```javascript
// Contrato que debe cumplir cualquier proveedor
class AIProvider {
  constructor(config) {}

  // Streaming de texto. Llama onChunk(text) por cada token.
  // Retorna el texto completo al resolver.
  async streamMessage(messages, systemPrompt, onChunk) → Promise<string>

  // Metadatos opcionales (costo, modelo activo, etc.)
  getMetadata() → { model, costUsd, ... }

  // Nombre del proveedor (para logs y UI)
  get name() → string
}
```

### Implementación por proveedor

#### Anthropic (actual)
```javascript
// Dependencia: @anthropic-ai/sdk
// Config: { apiKey, model: 'claude-sonnet-4-6' }
stream = client.messages.stream({
  model, max_tokens: 4096,
  system: systemPrompt,
  messages,
})
// Evento: content_block_delta / text_delta
```

#### OpenAI / ChatGPT
```javascript
// Dependencia: openai
// Config: { apiKey, model: 'gpt-4o' }
stream = await client.chat.completions.create({
  model, stream: true,
  messages: [{ role: 'system', content: systemPrompt }, ...messages],
})
// Evento: choices[0].delta.content
```

#### Google Gemini
```javascript
// Dependencia: @google/generative-ai
// Config: { apiKey, model: 'gemini-2.0-flash' }
const model = genAI.getGenerativeModel({ model })
const chat = model.startChat({ history: messages, systemInstruction: systemPrompt })
const result = await chat.sendMessageStream(lastMessage)
// Iteración: for await (const chunk of result.stream)
//   chunk.text()
```

### Variables de entorno sugeridas

```env
AI_PROVIDER=anthropic          # anthropic | openai | gemini
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...
AI_MODEL=                      # vacío = default del proveedor
```

### Cambios necesarios en el código

1. **`server/ai-provider.js`** ← nuevo archivo con la interfaz y las 3 implementaciones.

2. **`server/index.js` — `startClaudeSession()`**
   Reemplazar `new Anthropic()` por `new AIProvider(config)`.
   El ciclo de streaming cambia según proveedor pero la lógica WS queda igual.

3. **`server/telegram.js` — `ClaudePrintSession`**
   Esta clase hoy lanza el CLI `claude -p`. Para soporte multi-proveedor:
   - Reemplazarla por una clase `AISession` que use `AIProvider.streamMessage()` directamente (SDK, no CLI).
   - Esto también elimina la dependencia de tener instalado el CLI de Claude.
   - El campo `--continue` de Claude CLI se reemplaza por mantener `history[]` en memoria (igual que hace `startClaudeSession`).

4. **`server/agents.js`**
   Agregar campo `provider?: string` por agente para soporte de proveedor por agente.

---

## Flujo de datos completo

```
Usuario (browser/Telegram)
       │
       ▼
   WebSocket / HTTP / Telegram API
       │
       ▼
   index.js (router)
       │
       ├──→ PtySession (node-pty)
       │         │
       │         ▼
       │    Proceso del OS (bash, python, etc.)
       │
       └──→ AISession (sin PTY)
                 │
                 ▼
            AIProvider
                 │
                 ├──→ Anthropic SDK (streaming)
                 ├──→ OpenAI SDK (streaming)
                 └──→ Gemini SDK (streaming)
```

---

## Notas de implementación importantes

### stripAnsi / cleanPtyOutput
Hay dos variantes. `cleanPtyOutput` en `telegram.js` es más sofisticada: simula carriage return real y filtra líneas decorativas del TUI de Claude Code. Usar esta versión como canónica.

### Persistencia de sesiones ante desconexión WS
Las `PtySession` no se destruyen cuando el WebSocket se cierra. Persisten en el `Map` del `sessionManager`. El cliente puede reconectarse con `{ type: 'init', sessionId: 'uuid-existente' }` para adjuntarse a la sesión viva.

### Broadcast de eventos Telegram
Cuando llega un mensaje de Telegram en una sesión PTY, se emite `events.emit('telegram:session', {...})`. Todos los clientes WS conectados reciben `{ type: 'telegram_session' }` para poder abrir automáticamente la pestaña correspondiente.

### Rate limit de Telegram edits
Telegram permite aproximadamente 1 edición de mensaje por segundo por chat. El throttle está en 1500ms para estar dentro del límite con margen.

### node-pty para `claude -p`
Se usa `pty.spawn` (en lugar de `child_process.spawn`) para ejecutar `claude -p` porque el CLI detecta si está en un TTY y hace flush de línea. Sin TTY, puede buffear la salida y nunca llegar al proceso.

### WSL2 + node-pty: stack overflow (0xC00000FD)

En WSL2, `node-pty` puede crashear el proceso de Node.js con el código `0xC00000FD` (`STATUS_STACK_OVERFLOW`). Causas posibles:

1. **Stack insuficiente**: Node.js arranca con ~1 MB de stack por defecto. El addon nativo de node-pty puede superarlo al inicializar PTYs.
2. **Binario pre-compilado incorrecto**: `npm install` descarga un `.node` pre-built para una plataforma/versión de Node específica. Si hay mismatch (ej: binario compilado para Win32 corriendo en WSL2), crashea al cargarse.

**Fix aplicado en `package.json`:**
```json
"start": "node --stack-size=65536 index.js"
```
`--stack-size=65536` le asigna 64 MB de stack a Node (valor en KB).

**Fix complementario — rebuild del módulo nativo:**
```bash
cd server
npm rebuild node-pty
```
Recompila el addon C++ de node-pty en la máquina local, para la versión exacta de Node instalada. Elimina cualquier mismatch de binario pre-built.

**Cuándo ejecutar el rebuild:**
- Al cambiar la versión de Node.js
- Al clonar el repo en una máquina nueva
- Después de `npm install` si el crash persiste

### Eliminar variables de entorno al lanzar PTY
Se eliminan `CLAUDECODE` y `CLAUDE_CODE_ENTRYPOINT` del env antes de spawner para evitar que los procesos hijos hereden el contexto de Claude Code y entren en modo interactivo inesperado.

---

## Dependencias mínimas del servidor

```json
{
  "express": "^4",
  "ws": "^8",
  "node-pty": "^1",
  "cors": "^2",
  "@anthropic-ai/sdk": "^0.78"
}
```

**Para multi-proveedor agregar según necesidad:**
```json
{
  "openai": "^4",
  "@google/generative-ai": "^0.21"
}
```

---

## Checklist de implementación futura

- [ ] Extraer `AIProvider` a `server/ai-provider.js` con interfaz unificada
- [ ] Reemplazar `ClaudePrintSession` (CLI) por `AISession` (SDK directo)
- [ ] Agregar campo `provider` al schema de agentes
- [ ] Leer `AI_PROVIDER` desde env en arranque
- [ ] UI: selector de proveedor/modelo en `AgentsPanel`
- [ ] UI: mostrar costo estimado por sesión (disponible en Anthropic y OpenAI)
- [ ] Persistencia de historial de conversaciones (actualmente solo en memoria)
- [ ] Reconexión automática de WebSocket en el cliente
- [ ] Autenticación básica para la API HTTP (actualmente abierta)
