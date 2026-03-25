# Roadmap Clawmint — Implementación por sesiones

## Estado actual (post sesión 5 — 2026-03-25)

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
- [x] Sesión 4: Refactor TelegramChannel 1580→~400 LOC, webhook mode, outbound throttle (PRs #74, #78, #79, #80, #85)
- [x] Sesión 5: DirPicker a11y, responsive móvil, color tokens, empty states, WebChat status/ask-permission (PRs #81, #82, #84, #86, #89)

### Issues cerrados en sesión 4+
- ~~#45~~ Memory leak: streams audio sin cleanup — ✅ resuelto
- ~~#46~~ Event listeners acumulados sin cleanup en TerminalPanel — ✅ resuelto
- ~~#47~~ Race condition en chat_chunks WebChatPanel — ✅ resuelto
- ~~#48~~ Timer interval grabación sin cleanup — ✅ resuelto
- ~~#49~~ Accesibilidad: controles sin aria-label — ✅ resuelto (PR #81)
- ~~#50~~ Contraste insuficiente en textos secundarios — ✅ resuelto (PR #81)
- ~~#51~~ DirPicker: semántica de diálogo y cierre con Escape — ✅ resuelto (PR #89)
- ~~#52~~ Error handling silencioso — ✅ resuelto (PR #66)
- ~~#53~~ Performance: componentes sin React.memo — ✅ resuelto (PRs #75, #76, #84)
- ~~#54~~ Responsive: WebChat móvil + paneles colapsables — ✅ resuelto (PRs #82, #89)
- ~~#55~~ Inconsistencia visual: colores y estilos entre componentes — ✅ resuelto (PR #89)
- ~~#56~~ UX: empty states sin acciones claras — ✅ resuelto (PR #89)

### Issues abiertos GitHub
- #57 Lighthouse Performance: score 54 → build producción + sourcemaps off
- #63 feat: Orquestación multi-agente con AgentOrchestrator
- #64 feat: Live Canvas — workspace visual generado por agentes IA

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

## ~~Sesión 4 — Telegram optimización~~ ✅ COMPLETADA
**Objetivo**: Telegram no se bloquea y escala mejor.

### 4.1 Paralelizar handlers ✅
- `Promise.allSettled(updates.map(u => this._handleUpdate(u)))`
- En vez de `for...of` serial
- **PR**: #78 (refactor/telegram-session4)

### 4.2 Refactor TelegramChannel (1580 LOC) ✅
- Extraído a módulos: `MessageProcessor`, `ResponseRenderer`, `MediaHandler`
- TelegramChannel → TelegramBot como orquestador (~400 LOC)
- **PRs**: #78, #85 (refactor/telegram-bot-split)

### 4.3 Webhook mode ✅
- Alternativa a long polling para producción
- Express endpoint `/webhook/:botKey`
- Configurable via env: `TELEGRAM_MODE=webhook|polling`
- **PR**: #80 (feat/telegram-webhook-mode)

### 4.4 Throttle inteligente ✅
- Outbound throttle con rate limit y retry en 429
- Queue de mensajes outbound
- **PR**: #79 (feat/telegram-outbound-throttle)

---

## ~~Sesión 5 — Frontend (issues #49-57)~~ ✅ COMPLETADA
**Objetivo**: WebClient usable, accesible, performante.

### 5.1 Performance (#53, #57) ✅
- React.memo en componentes puros (TabBar, AgentsPanel, ProvidersPanel) — PR #75
- Code splitting, source maps, favicon — PR #76
- Lazy loading y syntax highlighting ligero — PR #84
- ARIA, focus styles, semantic HTML — PR #77
- **Prod build + vite preview + sourcemaps off** — PR actual (#57)

### 5.2 Responsive (#54) ✅
- WebChat usable en móvil (<768px) — PRs #82, #89
- Paneles colapsables en <1000px — PR #89
- Touch-friendly controls — PR #89

### 5.3 Accesibilidad (#49, #50, #51) ✅
- aria-label en todos los controles — PR #81
- Contraste WCAG AA en textos secundarios — PR #81
- CSS design tokens — PR #81
- DirPicker semántica de diálogo + Escape para cerrar — PR #89

### 5.4 UX (#55, #56) ✅
- Error handling visible (#52) — PR #66
- Colores primarios consistentes entre componentes — PR #89
- Empty states con acciones claras — PR #89

### 5.5 WebChat status display ✅
- Mostrar `chat_status` events (pensando/tool/listo) en el UI
- Mostrar `chat_ask_permission` con botones approve/reject
- **PR**: #86 (feat/webchat-status-ask-permission)

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
Sesión 4 — Telegram optimización    ████████████ ✅ COMPLETADA
Sesión 5 — Frontend issues          ████████████ ✅ COMPLETADA
Sesión 6 — Búsqueda avanzada        ░░░░░░░░░░░░ SIGUIENTE
Sesión 7 — Base de datos            ░░░░░░░░░░░░ BAJA (escala)
Sesión 8 — Seguridad                ░░░░░░░░░░░░ BAJA
Sesión 9 — Multi-agente             ░░░░░░░░░░░░ FUTURO
```

## Progreso: 5/9 sesiones completadas
