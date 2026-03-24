# Roadmap Clawmint — Implementación por sesiones

## Estado actual (post sesión 2026-03-24)

### Completado
- [x] MCP tools para todos los providers API (32 tools)
- [x] Flujo status pensando/tool_use/listo (como claude-code)
- [x] Modos ask/auto/plan para providers API
- [x] Tracking de costo por provider (/costo)
- [x] Sliding window: compresión automática de historial (>30 msgs)
- [x] edit_file: edición con diffs (buscar/reemplazar)
- [x] pty_create + pty_exec: terminal interactiva persistente
- [x] git tool: 12 acciones (status, diff, log, commit, push, etc.)
- [x] Fix duplicado mensajes Telegram
- [x] deleteWebhook al iniciar polling
- [x] /modo habilitado para todos los providers
- [x] Sesión 1: PtySession idle timeout, ShellSession cleanup, log rotation, índices SQLite, TerminalPanel cleanup
- [x] Sesión 2: Retry 3x con backoff, rate limit 10/min, timeout 120s, resume tras restart (aiHistory en SQLite)
- [x] Sesión 3: Refactor index.js 1704→170 LOC (11 routes/ + 3 ws/ modules)

### Issues abiertos GitHub
- #45 Memory leak: streams audio sin cleanup — **ya resuelto en código actual** (cleanup correcto)
- #46 Event listeners acumulados sin cleanup en TerminalPanel — **resuelto** (onData disposable)
- #48 Timer interval grabación sin cleanup — **ya resuelto en código actual**
- #47 Race condition en chat_chunks WebChatPanel (critical)
- #48 Timer interval grabación sin cleanup (critical)
- #49-57 Accesibilidad, UX, performance, responsive, Lighthouse

---

## ~~Sesión 1 — Estabilidad crítica~~ ✅ COMPLETADA

### 1.1 PtySession timeout de inactividad
- Agregar `lastAccessAt` en PtySession
- Actualizar en cada `input()`, `getOutputSince()`, `sendMessage()`
- Intervalo cada 5min: destruir sesiones idle >30min
- **Archivo**: `server/sessionManager.js`

### 1.2 ShellSession cleanup
- Agregar idle timeout 30min en ShellSession pool
- Destruir shell inactiva (stdin.end, kill proceso)
- **Archivo**: `server/mcp/ShellSession.js`

### 1.3 Log rotation
- En Logger.js: si server.log > 50MB → rotar a .bak
- Máximo 3 archivos rotados
- **Archivo**: `server/core/Logger.js`

### 1.4 Índices SQLite
- `CREATE INDEX idx_notes_agent ON notes(agent_key)`
- `CREATE INDEX idx_queue_status ON consolidation_queue(status)`
- `CREATE INDEX idx_note_links ON note_links(source_id)`
- Ejecutar en `memory.initDBAsync()`
- **Archivo**: `server/memory.js`

### 1.5 Issues #45-48 (frontend critical)
- #45: Cleanup de MediaStream en WebChatPanel al desmontar
- #46: removeEventListener en TerminalPanel al desmontar
- #47: Race condition chat_chunks — mutex o queue
- #48: clearInterval del timer de grabación al desmontar
- **Archivos**: `client/src/components/WebChatPanel.jsx`, `TerminalPanel.jsx`

---

## ~~Sesión 2 — Resiliencia de providers~~ ✅ COMPLETADA
**Objetivo**: Los providers API no fallan silenciosamente.

### 2.1 Retry con exponential backoff
- Wrapper en `_processApiProvider`: 3 reintentos, backoff 1s→2s→4s
- Solo para errores transitorios (429, 500, 503, timeout)
- No reintentar errores de auth (401, 403) ni de input (400)
- **Archivo**: `server/services/ConversationService.js`

### 2.2 Rate limiting por chat
- Máximo 10 mensajes/minuto por chatId
- Cola de espera si se excede (no rechazar, encolar)
- **Archivo**: `server/services/ConversationService.js`

### 2.3 Resume tras restart (persistir historial)
- Guardar `aiHistory` en SQLite después de cada respuesta (debounced 5s)
- Nueva tabla `chat_history(bot_key, chat_id, history_json, updated_at)`
- Al iniciar: cargar history → si >30 msgs, compactar con provider
- **Archivos**: `server/storage/ChatSettingsRepository.js`, `server/channels/telegram/TelegramChannel.js`

### 2.4 Timeout global por request
- Si provider no responde en 120s → abortar y enviar error al usuario
- AbortController para fetch-based providers
- **Archivos**: `server/providers/*.js`

---

## ~~Sesión 3 — Refactor index.js~~ ✅ COMPLETADA
**Objetivo**: Partir el monolito de 1704 LOC.

### 3.1 Extraer rutas REST
- `server/routes/sessions.js` — CRUD sesiones PTY
- `server/routes/agents.js` — CRUD agentes
- `server/routes/providers.js` — config providers
- `server/routes/telegram.js` — API telegram (bots, send photo/doc)
- `server/routes/mcp.js` — endpoints MCP
- `server/routes/system.js` — health, stats, logs
- `server/routes/nodriza.js` — config/status nodriza
- **Archivo**: `server/index.js` → queda solo app setup + server.listen

### 3.2 Extraer WebSocket handler
- `server/websocket.js` — connection, message routing, session attach
- **Archivo**: `server/index.js`

### 3.3 Extraer AI session handler
- `server/ai-session.js` — aiSessionHistories, message handling
- **Archivo**: `server/index.js`

### 3.4 Resultado esperado
- `index.js` pasa de 1704 → ~200 LOC (setup + imports)
- Cada módulo testeable independientemente

---

## Sesión 4 — Telegram optimización (4-6h)
**Objetivo**: Telegram no se bloquea y escala mejor.

### 4.1 Paralelizar handlers
- `Promise.allSettled(updates.map(u => this._handleUpdate(u)))`
- En vez de `for...of` serial
- **Archivo**: `server/channels/telegram/TelegramChannel.js`

### 4.2 Refactor TelegramChannel (1580 LOC)
- Extraer `_sendToSession` → `MessageProcessor.js`
- Extraer `_sendResult` + `_startDotAnimation` → `ResponseRenderer.js`
- Extraer `_handleVoiceMessage` + `_handlePhotoMessage` → `MediaHandler.js`
- TelegramChannel queda como orquestador (~400 LOC)

### 4.3 Webhook mode (opcional)
- Alternativa a long polling para producción
- Express endpoint `/webhook/:botKey`
- Configurable via env: `TELEGRAM_MODE=webhook|polling`
- **Archivos**: nuevos en `server/channels/telegram/`

### 4.4 Throttle inteligente
- Rate limit de edits por mensaje (ya existe 1500ms)
- Rate limit de mensajes por chat (anti-flood)
- Queue de mensajes outbound con retry

---

## Sesión 5 — Frontend (issues #49-57) (4-6h)
**Objetivo**: WebClient usable, accesible, performante.

### 5.1 Performance (#53, #57)
- React.memo en componentes puros (TabBar, AgentsPanel, ProvidersPanel)
- Lazy loading de paneles (React.lazy + Suspense)
- Code splitting por ruta
- Lighthouse target: >75

### 5.2 Responsive (#54)
- WebChat usable en móvil (<768px)
- Paneles colapsables en <1000px
- Touch-friendly controls

### 5.3 Accesibilidad (#49, #50, #51)
- aria-label en todos los controles
- Contraste WCAG AA en textos secundarios
- DirPicker: semántica de diálogo + Escape para cerrar
- Focus management en modales

### 5.4 UX (#55, #56)
- Colores primarios consistentes entre componentes
- Empty states con acciones claras (ej: "Sin agentes. Crear uno →")
- Error handling visible (no silencioso) en WebChatPanel y AgentsPanel (#52)

### 5.5 WebChat status display
- Mostrar `chat_status` events (pensando/tool/listo) en el UI
- Mostrar `chat_ask_permission` con botones approve/reject
- Indicador de modo actual (ask/auto/plan)

---

## Sesión 6 — Búsqueda y herramientas avanzadas (3-4h)
**Objetivo**: Herramientas de búsqueda al nivel de Claude Code.

### 6.1 grep tool
- `grep(pattern, path?, type?, context_lines?)`
- Usa ripgrep si disponible, fallback a node recursivo
- Retorna matches con líneas de contexto
- **Archivo**: nuevo `server/mcp/tools/grep.js`

### 6.2 glob tool
- `glob(pattern, path?)`
- Búsqueda por nombre de archivo con patrones glob reales
- Usa `fast-glob` o implementación nativa
- **Archivo**: nuevo `server/mcp/tools/glob.js`

### 6.3 Tool filtering por contexto
- No enviar las 32 tools siempre — filtrar por relevancia
- Si el chat es sobre código → priorizar bash, git, files, grep
- Si es casual → solo memory y messaging
- Reducir tokens consumidos en system prompt
- **Archivo**: `server/services/ConversationService.js`

---

## Sesión 7 — Base de datos y persistencia (4-6h)
**Objetivo**: Datos seguros y escalables.

### 7.1 Migrar a better-sqlite3 (opcional)
- Reemplazar sql.js (WASM in-memory) por better-sqlite3 (nativo)
- WAL mode para crash recovery
- Requiere compilación nativa (node-gyp)
- Evaluar si vale la pena vs. portabilidad actual

### 7.2 FTS5 para búsqueda semántica
- Full-text search en notas de memoria
- Reemplazar embeddings por FTS5 (más rápido, sin API calls)
- Fallback a embeddings para búsqueda semántica profunda

### 7.3 Políticas de retención
- Archivar notas >180 días (mover a tabla `notes_archive`)
- Compactar consolidation_queue procesada
- VACUUM automático en boot

### 7.4 Backup automático
- Snapshot de DB a disco cada hora
- Mantener últimos 24 snapshots
- Restaurar desde snapshot en caso de corrupción

---

## Sesión 8 — Seguridad y observabilidad (3-4h)
**Objetivo**: Saber qué pasa y prevenir abusos.

### 8.1 Audit log de tools
- Registrar cada tool call: timestamp, chatId, tool, args, result (truncado)
- Tabla SQLite `tool_audit_log`
- Endpoint GET /api/audit?chatId=&tool=&since=

### 8.2 Dashboard de uso
- Endpoint GET /api/stats → tokens usados, costo estimado, tools más usadas
- Por provider, por chat, por día
- Exponer en WebClient como panel

### 8.3 Sandbox mode (opcional)
- Variable SANDBOX=true → bash tool restringido a directorio de trabajo
- No puede acceder a ~/.ssh, /etc, etc.
- Útil para demos o acceso público

### 8.4 Health check mejorado
- GET /api/health → incluir: memoria RSS, sesiones activas, DB size, bots conectados
- Alertas si memoria > 500MB o sesiones > 50

---

## Sesión 9 — Multi-agente y workflows (4-6h)
**Objetivo**: Agentes especializados que colaboran.

### 9.1 Agentes con tools restringidas
- Cada agente define qué tools puede usar
- `agents.json`: `{ "tools": ["bash", "git", "files"] }`
- ConversationService filtra tools por agente

### 9.2 Handoff entre agentes
- Agente A puede transferir conversación a Agente B
- Tool: `handoff(agent_key, context_summary)`
- El nuevo agente recibe el resumen + toma el chat

### 9.3 Workflows automatizados
- Definir secuencias: "al recibir PR → revisar código → comentar"
- YAML/JSON workflow definitions
- Ejecutar steps secuenciales con agentes

---

## Prioridad de sesiones

```
Sesión 1 — Estabilidad crítica      ████████████ ✅ COMPLETADA
Sesión 2 — Resiliencia providers    ████████████ ✅ COMPLETADA
Sesión 3 — Refactor index.js        ████████████ ✅ COMPLETADA
Sesión 4 — Telegram optimización    ██████░░░░░░ SIGUIENTE
Sesión 5 — Frontend issues          █████░░░░░░░ MEDIA
Sesión 6 — Búsqueda avanzada        ████░░░░░░░░ MEDIA
Sesión 7 — Base de datos            ████░░░░░░░░ BAJA (escala)
Sesión 8 — Seguridad                ███░░░░░░░░░ BAJA
Sesión 9 — Multi-agente             ██░░░░░░░░░░ FUTURO
```

## Progreso: 3/9 sesiones completadas (~12h de 32-46h estimadas)
