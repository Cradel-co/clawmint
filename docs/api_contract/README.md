> Última actualización: 2026-03-17

# API Contract

Todos los endpoints expuestos por `server/index.js` en `http://localhost:3001`.

**Formato de respuesta:** JSON. Errores con `{ error: string }` y código HTTP apropiado.

---

## Índice

| Recurso | Prefijo | Descripción |
|---------|---------|-------------|
| [Sesiones PTY](#sesiones-pty) | `/api/sessions` | Crear, listar y operar sesiones de terminal |
| [Agentes](#agentes) | `/api/agents` | CRUD de agentes de IA |
| [Skills](#skills) | `/api/skills` | Gestión de skills (locales + ClawHub) |
| [Memoria](#memoria) | `/api/memory` | Leer, escribir y buscar memoria por agente |
| [Logs](#logs) | `/api/logs` | Configuración y consulta de logs del servidor |
| [Telegram](#telegram) | `/api/telegram` | Gestión de bots Telegram |
| [Providers](#providers) | `/api/providers` | Configuración de providers de IA |
| [WebSocket](#websocket) | `ws://localhost:3001` | Streaming bidireccional de terminal |

---

## Sesiones PTY

### `GET /api/sessions`
Lista todas las sesiones activas.

**Response 200:**
```json
[
  { "id": "uuid", "type": "pty", "title": "bash", "createdAt": 1710000000000, "active": true }
]
```

---

### `POST /api/sessions`
Crea una nueva sesión PTY.

**Body:**
| Campo | Tipo | Default | Descripción |
|-------|------|---------|-------------|
| `type` | string | `"pty"` | `"pty"` \| `"listener"` |
| `command` | string | `"bash"` | Comando a ejecutar |
| `cols` | number | `80` | Columnas del terminal |
| `rows` | number | `24` | Filas del terminal |

**Response 201:**
```json
{ "id": "uuid", "type": "pty", "title": "bash", "createdAt": 1710000000000, "active": true }
```

---

### `GET /api/sessions/:id`
Obtiene info de una sesión.

**Response 404:** `{ "error": "Session not found" }`

---

### `DELETE /api/sessions/:id`
Cierra y destruye una sesión PTY.

**Response 200:** `{ "ok": true }`

---

### `POST /api/sessions/:id/input`
Envía input raw al PTY (no espera respuesta).

**Body:** `{ "text": "ls -la\n" }`

**Response 200:** `{ "ok": true }`

---

### `POST /api/sessions/:id/message`
Envía un mensaje y espera la respuesta completa (con timeout de estabilización).

**Body:** `{ "text": "¿Qué es Node.js?" }`

**Response 200:**
```json
{ "response": "Node.js es...", "raw": "Node.js es...\r\n$ " }
```

---

### `GET /api/sessions/:id/stream`
SSE stream del output de la sesión en tiempo real.

**Events:**
```
data: {"data": "output parcial\r\n"}
event: exit
data: {}
```

---

### `GET /api/sessions/:id/output?since=0`
Pull de output desde un timestamp (milisegundos).

**Response 200:**
```json
{ "raw": "output...", "response": "output limpio", "ts": 1710000005000 }
```

---

## Agentes

### `GET /api/agents`
Lista todos los agentes definidos.

**Response 200:**
```json
[
  {
    "key": "claude",
    "command": "claude",
    "description": "Claude CLI",
    "prompt": "# System prompt",
    "provider": null
  }
]
```

---

### `POST /api/agents`
Crea un agente.

**Body:**
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `key` | string | Sí | Identificador único (slug) |
| `command` | string | No | Comando a ejecutar (`null` = bash puro) |
| `description` | string | No | Descripción visible en UI |
| `prompt` | string | No | System prompt del agente |
| `provider` | string | No | Fuerza un provider específico |

**Response 201:** Agente creado. **409** si `key` ya existe.

---

### `PATCH /api/agents/:key`
Actualiza campos de un agente. Todos los campos son opcionales.

**Response 200:** Agente actualizado. **404** si no existe.

---

### `DELETE /api/agents/:key`
Elimina un agente.

**Response 200:** `{ "ok": true }`. **404** si no existe.

---

## Skills

### `GET /api/skills`
Lista los skills instalados localmente.

**Response 200:**
```json
[{ "slug": "git-commit", "name": "Git Commit Helper", "description": "..." }]
```

---

### `POST /api/skills/install`
Instala un skill desde ClawHub.

**Body:** `{ "slug": "git-commit" }`

**Response 200:** `{ "ok": true, "slug": "git-commit" }`

---

### `GET /api/skills/search?q=texto`
Busca skills en ClawHub.

**Response 200:**
```json
[{ "slug": "git-commit", "name": "Git Commit Helper", "description": "...", "score": 0.92 }]
```

---

### `DELETE /api/skills/:slug`
Desinstala un skill.

**Response 200:** `{ "ok": true }`

---

## Memoria

### `GET /api/memory/debug?agentKey=xxx`
Estadísticas de debug del sistema de memoria.

**Response 200:**
```json
{
  "stats": { "totalNotes": 5, "totalTags": 23, "totalLinks": 8 },
  "topAccessed": [{ "filename": "laboral.md", "access_count": 12 }],
  "topLinks": [{ "from": "laboral.md", "to": "skills.md", "weight": 5 }],
  "allTags": ["trabajo", "python", "kubernetes"]
}
```

---

### `GET /api/memory/graph?agentKey=xxx`
Grafo de notas y sus conexiones (para visualización).

**Response 200:**
```json
{
  "nodes": [{ "id": 1, "filename": "laboral.md", "title": "Info laboral" }],
  "links": [{ "source": 1, "target": 2, "weight": 3 }]
}
```

---

### `GET /api/memory/:agentKey`
Lista los archivos de memoria del agente.

**Response 200:**
```json
[{ "filename": "laboral.md", "size": 256, "updatedAt": 1710000000000 }]
```

---

### `GET /api/memory/:agentKey/search?tags=python,trabajo&q=texto`
Busca notas por tags y/o texto (spreading activation).

**Response 200:**
```json
[{ "filename": "laboral.md", "title": "Info laboral", "score": 0.87, "tags": ["trabajo"] }]
```

---

### `GET /api/memory/:agentKey/:filename`
Lee el contenido de un archivo de memoria.

**Response 200:** `{ "content": "---\ntitle: ...\n---\nContenido..." }`

---

### `PUT /api/memory/:agentKey/:filename`
Escribe (sobreescribe) un archivo de memoria.

**Body:** `{ "content": "---\ntitle: ...\n---\nContenido..." }`

**Response 200:** `{ "ok": true }`

---

### `POST /api/memory/:agentKey/:filename/append`
Agrega contenido al final de un archivo.

**Body:** `{ "content": "\nNueva línea." }`

**Response 200:** `{ "ok": true }`

---

### `DELETE /api/memory/:agentKey/:filename`
Elimina un archivo de memoria.

**Response 200:** `{ "ok": true }`

---

## Logs

### `GET /api/logs/config`
Lee la configuración de logging.

**Response 200:** `{ "enabled": true }`

---

### `POST /api/logs/config`
Habilita o deshabilita el logging (hot-reload, sin reinicio).

**Body:** `{ "enabled": false }`

**Response 200:** `{ "enabled": false }`

---

### `GET /api/logs/tail?lines=100`
Lee las últimas N líneas del log.

**Response 200:** `{ "lines": ["[2026-03-17T...] [INFO ] Servidor..."] }`

---

### `DELETE /api/logs`
Limpia el archivo de log.

**Response 200:** `{ "ok": true }`

---

## Telegram

### `GET /api/telegram/bots`
Lista todos los bots configurados.

**Response 200:**
```json
[
  {
    "key": "dev",
    "running": true,
    "botInfo": { "id": 123, "username": "MiBot" },
    "defaultAgent": "claude",
    "whitelist": [],
    "groupWhitelist": [],
    "rateLimit": 30,
    "chats": []
  }
]
```

---

### `POST /api/telegram/bots`
Agrega y arranca un nuevo bot.

**Body:**
| Campo | Tipo | Requerido |
|-------|------|-----------|
| `key` | string | Sí |
| `token` | string | Sí |

**Response 200:** `{ "ok": true, "username": "MiBot" }`

---

### `DELETE /api/telegram/bots/:key`
Para y elimina un bot.

**Response 200:** `{ "ok": true }`

---

### `POST /api/telegram/bots/:key/start`
Arranca un bot previamente detenido.

**Response 200:** `{ "ok": true, "username": "MiBot" }`

---

### `POST /api/telegram/bots/:key/stop`
Detiene el polling de un bot.

**Response 200:** `{ "ok": true }`

---

### `PATCH /api/telegram/bots/:key`
Actualiza la configuración de un bot.

**Body (todos opcionales):**
| Campo | Tipo | Descripción |
|-------|------|-------------|
| `defaultAgent` | string | Agente por defecto |
| `whitelist` | number[] | IDs de chats privados permitidos |
| `groupWhitelist` | number[] | IDs de grupos permitidos |
| `rateLimit` | number | Mensajes/hora (0 = sin límite) |
| `rateLimitKeyword` | string | Palabra para resetear el límite |

**Response 200:** Bot actualizado.

---

### `GET /api/telegram/bots/:key/chats`
Lista los chats activos del bot.

**Response 200:** Array de estados de chat.

---

### `POST /api/telegram/bots/:key/chats/:chatId/session`
Vincula o crea una sesión PTY para un chat de Telegram.

**Body (opcional):** `{ "sessionId": "uuid-existente" }`

**Response 200:** `{ "ok": true, "sessionId": "uuid" }`

---

### `DELETE /api/telegram/bots/:key/chats/:chatId`
Desconecta un chat (elimina estado de sesión en memoria).

**Response 200:** `{ "ok": true }`

---

## Providers

### `GET /api/providers`
Lista los providers disponibles y su configuración actual (sin exponer las API keys completas).

**Response 200:**
```json
{
  "providers": [
    { "name": "anthropic", "label": "Anthropic", "models": ["claude-opus-4-6", "claude-sonnet-4-6"], "configured": true },
    { "name": "gemini", "label": "Google Gemini", "models": ["gemini-2.0-flash"], "configured": false }
  ],
  "default": "claude-code"
}
```

---

### `GET /api/providers/config`
Lee la configuración completa de providers (API keys enmascaradas).

**Response 200:**
```json
{
  "default": "claude-code",
  "providers": {
    "anthropic": { "model": "claude-opus-4-6", "hasKey": true },
    "gemini":    { "model": "gemini-2.0-flash", "hasKey": false }
  }
}
```

---

### `PUT /api/providers/default`
Cambia el provider por defecto.

**Body:** `{ "provider": "anthropic" }`

**Response 200:** `{ "ok": true, "default": "anthropic" }`

---

### `PUT /api/providers/:name`
Actualiza la API key y/o modelo de un provider.

**Body (todos opcionales):**
| Campo | Tipo | Descripción |
|-------|------|-------------|
| `apiKey` | string | API key del provider |
| `model` | string | Modelo a usar por defecto |

**Response 200:** `{ "ok": true }`

---

## WebSocket

**Endpoint:** `ws://localhost:3001`

### Mensajes cliente → servidor

```jsonc
// Inicializar sesión (primer mensaje obligatorio)
{
  "type": "init",
  "sessionType": "pty",        // "pty" | "listener" | "ai"
  "sessionId": "uuid",         // reconectar a sesión existente (opcional)
  "command": "bash",           // comando (solo sessionType pty)
  "cols": 80,
  "rows": 24,
  "provider": "anthropic",     // solo sessionType ai
  "agentKey": "claude",        // inyectar contexto de memoria
  "model": "claude-opus-4-6",  // sobrescribe modelo del provider
  "systemPrompt": "Sos..."     // system prompt extra
}

// Input al terminal
{ "type": "input", "data": "ls -la\n" }

// Redimensionar
{ "type": "resize", "cols": 120, "rows": 30 }
```

### Mensajes servidor → cliente

```jsonc
// ID de sesión asignado
{ "type": "session_id", "id": "uuid" }

// Output del terminal (PTY o AI)
{ "type": "output", "data": "texto parcial\r\n" }

// Fin de proceso
{ "type": "exit" }

// Broadcast: Telegram vinculó un chat a esta sesión
{ "type": "telegram_session", "sessionId": "uuid", "from": "usuario", "text": "mensaje" }
```

### Reconexión

El cliente debe reconectarse con `{ type: "init", sessionId: "uuid-anterior" }` para recuperar la sesión PTY activa. El servidor mantiene la sesión viva mientras no se destruya explícitamente.
