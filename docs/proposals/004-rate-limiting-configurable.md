# 004 — Límites Configurables (Rate Limiting + Sesiones)

> Estado: `propuesta` | Fecha: 2026-03-28

## Problema

Los límites del sistema están hardcodeados en múltiples archivos y no se pueden ajustar sin tocar código. Hay dos tipos de límites independientes:

1. **Rate limiting** — cuántos mensajes puede enviar un usuario en un período
2. **Duración de sesión CLI** — cada cuántos mensajes se resetea la sesión de Claude/Gemini

Ninguno de los dos es configurable de forma granular por bot, usuario, canal o agente.

---

## Estado actual

### A. Rate Limiting

#### Capa 1: Bot-level (solo Telegram)

| | |
|---|---|
| **Archivo** | `server/channels/telegram/TelegramBot.js` → `_checkRateLimit()` |
| **Scope** | Per-chat, per-bot |
| **Default** | 30 msgs/hora |
| **Ventana** | 1 hora (`RATE_WINDOW_MS = 3600000`) |
| **Configurable** | Sí — `PATCH /api/telegram/bots/:key` con `{ rateLimit, rateLimitKeyword }` |
| **Persistencia** | SQLite (tabla `bots`, campos `rate_limit`, `rate_limit_keyword`) |
| **Bypass** | El usuario puede enviar el `rateLimitKeyword` para resetear el contador |
| **Aplica a** | Solo Telegram |

#### Capa 2: ConversationService (todos los canales)

| | |
|---|---|
| **Archivo** | `server/services/ConversationService.js` → `processMessage()` línea 289 |
| **Scope** | Per-chat, global |
| **Default** | **10 msgs/min (HARDCODED)** |
| **Ventana** | 1 minuto |
| **Configurable** | No |
| **Persistencia** | Ninguna — Map en memoria |
| **Excepciones** | No aplica a providers CLI (`claude-code`, `gemini-cli`) |
| **Aplica a** | Telegram, WebChat, P2P |

```javascript
// ConversationService.js:289-306
const MAX_PER_MIN = 10; // ← HARDCODED
```

#### Capa 3: Outbound Queue (compliance API Telegram)

| | |
|---|---|
| **Archivo** | `server/channels/telegram/OutboundQueue.js` |
| **Default** | 30 calls/seg global, 1 msg/seg per-chat |
| **Configurable** | No — cumplimiento de la API de Telegram, no tocar |

### B. Duración de sesión CLI

| | |
|---|---|
| **Archivo** | `server/services/ConversationService.js` líneas 400 y 553 |
| **Default** | **10 mensajes (HARDCODED en 2 lugares)** |
| **Configurable** | No |
| **Aplica a** | Sesiones `claude-code` y `gemini-cli` |
| **Efecto** | Al llegar a 10 mensajes, se destruye la sesión CLI y se crea una nueva |
| **Continuidad** | Guarda un resumen en `last-session-summary.md` del agente vía memoria |

```javascript
// _processGeminiCli (línea 400)
const MAX_SESSION_MESSAGES = 10; // ← HARDCODED

// _processClaudeCode (línea 553)
const MAX_SESSION_MESSAGES = 10; // ← HARDCODED (duplicado)
```

**Flujo del auto-reset:**
```
mensaje #10 llega
    → guarda resumen en memoria (last-session-summary.md)
    → destruye sesión CLI
    → crea nueva sesión
    → inyecta contexto previo
    → procesa mensaje
```

### C. Otros límites hardcodeados relacionados

| Límite | Archivo | Valor | Descripción |
|--------|---------|-------|-------------|
| Sliding window historial API | `ConversationService.js` | 30 msgs | Compresión automática del historial cuando supera 30 mensajes |
| WebChat messages por sesión | `WebchatMessagesRepository.js:10` | 100 msgs | Máximo de mensajes persistidos por sesión webchat |
| Retry attempts | `ConversationService.js` | 3 | Reintentos en errores transitorios (429, 500, timeout) |
| Request timeout | `ConversationService.js` | 120s | Timeout global por request al provider |

---

## Flujo completo de un mensaje

```
Usuario envía mensaje
    │
    ▼
[ Capa 1 ] TelegramBot._checkRateLimit()    ← 30/hora per-chat (configurable per-bot)
    │ pasa                                      Solo Telegram. WebChat no tiene.
    ▼
ConversationService.processMessage()
    │
    ▼
[ Capa 2 ] Rate limit 10 msg/min            ← HARDCODED, no configurable
    │ pasa                                      Solo providers API (no CLI)
    ▼
¿Es provider CLI?
    │
    ├─ Sí → [ Session limit ] 10 msgs        ← HARDCODED, no configurable
    │        Si excede → reset sesión            Aplica a claude-code y gemini-cli
    │
    ├─ No → Provider API procesa directo
    │
    ▼
Respuesta generada
    │
    ▼
[ Capa 3 ] OutboundQueue                     ← 30/seg + 1/seg per-chat (Telegram API)
    │
    ▼
Respuesta enviada
```

---

## Problemas identificados

1. **Capa 2 no configurable** — 10 msgs/min hardcoded para todos los canales y usuarios
2. **Duración de sesión CLI no configurable** — 10 mensajes para todos, sin importar el contexto
3. **`MAX_SESSION_MESSAGES` duplicado** — definido 2 veces en el mismo archivo (líneas 400 y 553)
4. **WebChat no tiene capa 1** — no hay rate limiting a nivel de canal web
5. **No hay límite por usuario** — un usuario con múltiples chats/bots no tiene tope global
6. **No hay límite por provider** — un provider caro (Anthropic) tiene el mismo límite que uno barato
7. **Contadores se pierden al reiniciar** — no hay persistencia de estado de rate limit
8. **Las capas no se conocen** — el bot permite 30/hora pero ConversationService corta a 10/min

---

## Propuesta

### Nueva tabla `limits`

```sql
CREATE TABLE IF NOT EXISTS limits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,     -- 'rate' | 'session'
  scope      TEXT NOT NULL,     -- 'global' | 'channel' | 'bot' | 'user' | 'agent' | 'provider'
  scope_id   TEXT,              -- id del scope (NULL = default para ese scope)
  max_count  INTEGER NOT NULL,  -- cantidad máxima
  window_ms  INTEGER,           -- ventana en ms (solo para type='rate', NULL para 'session')
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
  UNIQUE(type, scope, scope_id)
);
```

### Resolución por prioridad

Más específico gana. Si no hay regla específica, sube al siguiente nivel:

```
provider > agent > user > bot > channel > global
```

### Ejemplos de registros

#### Rate limiting (`type = 'rate'`)

| scope | scope_id | max_count | window_ms | Efecto |
|-------|----------|-----------|-----------|--------|
| global | NULL | 10 | 60000 | Default: 10/min para todos |
| channel | telegram | 30 | 3600000 | Telegram: 30/hora |
| channel | webchat | 20 | 60000 | WebChat: 20/min |
| bot | chibi2026_bot | 60 | 3600000 | Este bot: 60/hora |
| user | uuid-marcos | 100 | 3600000 | Marcos: 100/hora |
| provider | anthropic | 5 | 60000 | Anthropic: max 5/min |

#### Duración de sesión (`type = 'session'`)

| scope | scope_id | max_count | window_ms | Efecto |
|-------|----------|-----------|-----------|--------|
| global | NULL | 10 | NULL | Default: reset cada 10 msgs |
| provider | claude-code | 20 | NULL | Claude CLI: 20 msgs antes de reset |
| provider | gemini-cli | 5 | NULL | Gemini CLI: 5 msgs |
| agent | mi-agente | 50 | NULL | Este agente: 50 msgs |
| user | uuid-marcos | 30 | NULL | Marcos: 30 msgs |

### API REST

```
GET    /api/limits              — listar todas las reglas
GET    /api/limits?type=rate    — filtrar por tipo
GET    /api/limits?scope=bot    — filtrar por scope
POST   /api/limits              — crear regla { type, scope, scope_id, max_count, window_ms }
PATCH  /api/limits/:id          — editar regla
DELETE /api/limits/:id          — eliminar regla
```

### Cambios necesarios

| Archivo | Cambio |
|---------|--------|
| `server/storage/LimitsRepository.js` | **Nuevo** — CRUD + `resolve(type, context)` que devuelve el límite más específico |
| `server/routes/limits.js` | **Nuevo** — Router REST para CRUD de reglas |
| `server/bootstrap.js` | Instanciar `LimitsRepository`, inyectar en `ConversationService` |
| `server/services/ConversationService.js` | Reemplazar `MAX_PER_MIN` y `MAX_SESSION_MESSAGES` hardcodeados por lectura del repo |
| `server/channels/telegram/TelegramBot.js` | Opcional: unificar `_checkRateLimit` con el mismo sistema |
| `server/channels/web/WebChannel.js` | Agregar rate limiting (hoy no tiene) |

### Método `resolve(type, context)`

```javascript
// context = { provider, agentKey, userId, botKey, channel }
// Busca la regla más específica que aplique

resolve('rate', { provider: 'anthropic', userId: 'uuid-marcos', botKey: 'chibi', channel: 'telegram' })
// → Busca en orden: provider=anthropic → user=uuid-marcos → bot=chibi → channel=telegram → global
// → Retorna la primera que encuentre: { max_count, window_ms }

resolve('session', { provider: 'claude-code', agentKey: 'claude' })
// → Busca: provider=claude-code → agent=claude → global
// → Retorna: { max_count }
```

### Consideraciones

- **Contadores en memoria** — los contadores de rate limit siguen siendo Maps en RAM (son efímeros, no tiene sentido persistirlos)
- **Configuración en SQLite** — las reglas sí se persisten
- **Cache** — cargar reglas en memoria al arrancar, invalidar al modificar vía API (evitar query en cada mensaje)
- **Capa 3 intacta** — OutboundQueue no se toca (compliance con API Telegram)
- **Backward compatible** — si no hay reglas en la DB, usar los defaults actuales (10/min rate, 10 msgs session)
- **Unificar `MAX_SESSION_MESSAGES`** — eliminar la duplicación en líneas 400 y 553
