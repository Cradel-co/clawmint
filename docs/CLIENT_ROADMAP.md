# Roadmap — Cliente Clawmint (refactor visual + paridad feature con server)

**Leyenda:** `[ ]` pendiente · `[~]` en progreso · `[x]` hecho · `[!]` bloqueado

---

## Contexto

El cliente React de Clawmint (`client/`) tiene hoy ~15 panels CRUD que cubren **~60% de la superficie del server**. El resto son features que existen en el server pero NO están expuestas en UI: RBAC, hooks, metrics, session sharing, tasks, scheduled actions, typed memory, orchestration workflows, y más.

Además, el **aspecto visual** está desactualizado comparado con OpenCode (referencia en `C:\Users\padil\Documents\wsl\opencode\packages\ui\`): no hay design system unificado, tool calls se renderizan como texto plano, no hay diff viewer, no hay command palette, ni status bar con context %.

Este roadmap refactoriza el cliente en **5 fases incrementales**, cada una mergeable a `main` independientemente detrás de un flag/feature toggle. Objetivo: **paridad visual con OpenCode + 100% de la superficie del server cubierta** en ~9-13 días.

---

## Pre-requisitos

- Server corriendo (pm2 clawmint) — los paneles nuevos consumen endpoints existentes.
- Node 22 + cliente con deps instaladas (`cd client && npm install`).
- **Nuevas dependencias** a agregar al `client/package.json`:
  - `shiki@^1.24.0` — syntax highlight (~2 MB, import async si el bundle size preocupa)
  - `motion@^11.15.0` — animaciones (~20 KB, reemplaza framer-motion)
  - `cmdk@^1.0.4` — command palette (~30 KB)
  - `@dnd-kit/core@^6.1.0` + `@dnd-kit/sortable@^8.0.0` — drag-drop sessions (~50 KB)
  - `recharts@^2.13.0` — gráficos para MetricsDashboard (~60 KB)

---

## Fase A — Design system estilo OpenCode (2-3 días)

> Base visual. Sin esto, las fases B/C/D/E van a quedar inconsistentes. **No agrega features**, solo refresca.

**Entry:** cliente actual funcional (sin cambios en server).
**Exit:** todo el cliente usa una paleta OC-2 unificada + componentes base reutilizables para tool calls, code blocks, diffs y status bar.

### A.1 Paleta y tokens CSS (`client/src/styles/`)

- [ ] `client/src/styles/theme.css` — CSS variables de OC-2 portadas, light + dark mode.
  - Bases: `--bg-base`, `--bg-elevated`, `--bg-weak`, `--fg-strong`, `--fg-base`, `--fg-muted`.
  - Semánticas: `--interactive`, `--success`, `--warning`, `--error`, `--accent`.
  - Diff: `--diff-add-bg`, `--diff-add-fg`, `--diff-del-bg`, `--diff-del-fg`.
  - Syntax: 16 slots para Shiki (`--syntax-keyword`, `--syntax-string`, etc).
- [ ] `client/src/styles/typography.css` — Inter 400/500/600 + JetBrains Mono 400/500. Escalas: `xs/sm/base/lg/xl/2xl`. Line-height: 1.3/1.5/1.8.
- [ ] `client/src/styles/spacing.css` — base 4px, escalas `0/1/2/3/4/6/8/12/16/24` (mult x4px).
- [ ] Reemplazar hardcoded colors en CSS Modules existentes por `var(--...)`.
- [ ] Toggle light/dark en `ThemeContext` actual — persistir en `user_preferences`.

### A.2 Componentes base reusables (`client/src/components/primitives/`)

- [ ] `<ToolCall />` — card colapsable con header (icono + nombre + args resumen + status) + body (full args + output). Animación spring con `motion`. Estados: `pending/running/completed/error`. Spinner si running. Basado en `BasicTool` de OpenCode.
- [ ] `<CodeBlock />` — wrapper sobre Shiki. Props: `{ code, lang, showLineNumbers?, highlight? }`. Lazy import de Shiki para no inflar el bundle inicial.
- [ ] `<DiffViewer />` — 2-column side-by-side o unified con `+/-` color-coded. Consume el output de `edit_file` parseado.
- [ ] `<StatusBar />` — footer sticky con: model actual, provider, context % (tokens consumidos / ventana), session id, latency del último turn. Se conecta al `chatStore`.
- [ ] `<Kbd />` — chip para shortcuts (`<Kbd>Cmd+K</Kbd>`).
- [ ] `<Collapsible />` — primitive genérico con animación.

### A.3 Layout 3-panel con resize

- [ ] Refactor `App.jsx` → grid 3-panel (sidebar-left + main + right-dock opcional).
- [ ] `<ResizeHandle />` primitive con drag. Persistir tamaños en localStorage + `user_preferences` sync.
- [ ] `right-dock` colapsable: por default oculto, se abre cuando hay "contexto extra" (p.ej. visualización de workflow de orchestration, diff review, logs streaming).

### A.4 Integración de los primitives en panels existentes

- [ ] `WebChatPanel` y `ChatMessage` — tool calls renderizadas con `<ToolCall />`, code blocks con `<CodeBlock />`, edit_file con `<DiffViewer />`.
- [ ] `ChatHeader` → `<StatusBar />` en el bottom, con info de model + context %.
- [ ] `TerminalPanel` — header con `<StatusBar />` reducido (sin context %).

### A.5 Tests + rollback

- [ ] Visual regression manual (screenshots before/after).
- [ ] Flag: `VITE_FEATURE_NEW_UI=false` default → usa CSS Modules legacy. Flip a true gradual.

---

## Fase B — Paneles admin-only (2-3 días)

> Cierra los gaps de **control/observabilidad** que hoy requieren SSH al host. Sin estos, el admin no puede operar Clawmint sin tocar DB a mano.

**Entry:** Fase A (usa `<ToolCall>`, `<StatusBar>` etc).
**Exit:** todo feature admin del server tiene UI. 0 operaciones requieren SSH.

### B.1 `PermissionsPanel`

- [ ] `client/src/components/config/PermissionsPanel.jsx`
- [ ] Listar reglas desde `GET /api/permissions` (admin).
- [ ] Crear regla: scope (`chat`/`user`/`role`/`channel`/`global`) + scope_id + tool_pattern (con autocomplete de tools conocidas) + action (`auto`/`ask`/`deny`) + reason.
- [ ] Editar / eliminar regla.
- [ ] Preview: "con estas reglas, la tool `X` en chat `Y` → `deny`". Usa `resolve` del server.
- [ ] Flag `PERMISSIONS_ENABLED` visible arriba + toggle con warning.

### B.2 `HooksPanel`

- [ ] `client/src/components/config/HooksPanel.jsx`
- [ ] Listar hooks desde `GET /api/hooks`.
- [ ] Crear hook: type (`js`/`shell`/`http`) + trigger (`pre_tool_call`/`post_tool_call`/`chat.params`/...) + match (jsonpath: tool name, regex) + handler/code/url + timeout_ms + orden.
- [ ] Editor de código con syntax highlight (`<CodeBlock />` en modo edit con CodeMirror o similar).
- [ ] Enable/disable toggle por hook.
- [ ] Botón "Reload hooks" (`POST /api/hooks/reload`).
- [ ] Ver hooks built-in (`audit_log`, `block_dangerous_bash`) read-only.

### B.3 `MetricsDashboard`

- [ ] `client/src/components/config/MetricsDashboard.jsx`
- [ ] Consume `GET /api/metrics/json` cada 10s.
- [ ] Gráficos con `recharts`:
  - Line chart: provider latency (p50/p95/p99) últimas 24h.
  - Bar chart: tool usage count por nombre.
  - Stacked area: tokens consumidos por provider.
  - Donut: cache hit rate (hits vs misses).
  - Counter: compact triggers, retries, errors.
- [ ] Export Prometheus format (`GET /api/metrics` raw).
- [ ] Filtros: agentKey, channel, botKey, time range.

### B.4 `UsersPanel` (admin-only)

- [ ] `client/src/components/config/UsersPanel.jsx`
- [ ] Listar usuarios desde `GET /api/auth/admin/users` (NUEVO endpoint — agregar en server).
- [ ] Cambiar role (`user`/`admin`) con confirmación.
- [ ] Ver identidades linkeadas (Telegram, WebChat, OAuth) por user.
- [ ] Banear / desbanear.
- [ ] Ver last_active.

### B.5 `WorkspacesPanel` (admin-only)

- [ ] `client/src/components/config/WorkspacesPanel.jsx`
- [ ] Consume tool `workspace_status` via `/mcp/tools/invoke` o endpoint nuevo `/api/workspaces`.
- [ ] Listar workspaces activos: git-worktrees, Docker containers, SSH sessions.
- [ ] Stop / cleanup manual.
- [ ] Config de adaptors visibles: `WORKSPACE_ADAPTORS_ENABLED`, `DOCKER_WORKSPACE_IMAGE`, SSH creds.

### B.6 Server-side additions para Fase B

- [ ] `GET /api/auth/admin/users` (admin) — lista `usersRepo.listAll()` + identidades + last_active.
- [ ] `PATCH /api/auth/admin/users/:id` (admin) — cambiar role, banear.
- [ ] `GET /api/workspaces` (admin) — espejo de `workspace_status` tool.

---

## Fase C — Features activos sin UI (2-3 días)

> Expone funcionalidad que **ya existe y funciona** en el server pero que nadie puede usar salvo via MCP tool o curl directo.

**Entry:** Fase A (usa primitives).
**Exit:** tasks, scheduled actions, typed memory, session sharing, skills y MCP OAuth son usables desde la UI.

### C.1 `TasksPanel`

- [ ] `client/src/components/TasksPanel.jsx` — nueva sección top-level o dentro de Config.
- [ ] Consume `GET /api/tasks` (NUEVO — agregar endpoint que espeje `TaskRepository`).
- [ ] Listar tasks con filtros: status, owner, created_at.
- [ ] Crear task manual (subject + description + owner).
- [ ] Editar status (`pending/in_progress/completed/deleted`).
- [ ] Dependencias (blockedBy / blocks).
- [ ] Integración con chat: botón "agregar esta tool call como task".

### C.2 `SchedulerPanel`

- [ ] `client/src/components/SchedulerPanel.jsx`
- [ ] Tab 1 — **Cron jobs** (`/api/scheduled` + tools `cron_*`):
  - Listar: trigger_type, cron_expr, next_run, status, last_run.
  - Crear cron: visual builder (horas/días/meses) o crontab expr raw.
  - Pausar / activar / eliminar.
- [ ] Tab 2 — **Scheduled actions** (ai_task, notification):
  - Listar acciones con creator, target, trigger, next_fire.
  - Crear: tipo + prompt + target (chat/user) + cron/once.
- [ ] Tab 3 — **Resumable sessions** (`schedule_wakeup`):
  - Listar pending con chat_id, trigger_at, resume_prompt.
  - Cancelar.

### C.3 `TypedMemoryPanel` (reemplazo o complemento al `MemoryPanel` actual)

- [ ] `client/src/components/TypedMemoryPanel.jsx`
- [ ] Consume `GET /api/typed-memory` (NUEVO — agregar endpoint).
- [ ] Listar por tipo: `user`, `feedback`, `project`, `reference`.
- [ ] Filtros: agentKey, scope (global/agent/chat/user).
- [ ] Editar / borrar memoria tipada.
- [ ] El MemoryPanel actual queda como "File Memory" (MEMORY.md files).
- [ ] Visualización del graph de memoria (`GET /api/memory/graph` que ya existe).

### C.4 `SessionsPanel` con share

- [ ] Ampliar `TerminalPanel` o nuevo `SessionsPanel`.
- [ ] Tab "Active" — sesiones activas con info (cwd, provider, agent, started_at).
- [ ] Tab "Shared" — tokens de share creados + revoke.
- [ ] Botón "Share" en cada sesión → modal con opciones (ttlHours, permissions) → genera token + QR.
- [ ] Live viewer de session compartida: input de token → suscribe via WS `sessionType: shared`.

### C.5 `SkillsPanel` mejorado

- [ ] Ampliar `client/src/components/config/SkillsPanel.jsx` (crear si no existe).
- [ ] Listar skills locales (`GET /api/skills`).
- [ ] Search en registry (`GET /api/skills/search?q=...`).
- [ ] Install desde registry (`POST /api/skills/install`).
- [ ] Uninstall (`DELETE /api/skills/:slug`).
- [ ] Ver SKILL.md de cada skill con `<CodeBlock lang="markdown" />`.
- [ ] Docs: cómo invocar con `/slug` en cualquier chat.

### C.6 `McpOAuthWizard`

- [ ] `client/src/components/config/McpOAuthWizard.jsx` (dentro de McpsPanel como modal).
- [ ] Consume `GET /api/mcp-auth/providers` — lista providers con handler registrado.
- [ ] Botón "Conectar X" → `POST /api/mcp-auth/start/:provider` → abre `auth_url` en window.open.
- [ ] Espera callback (state validado server-side) → polling cada 2s a `GET /api/mcp-auth/status/:state` (NUEVO).
- [ ] Muestra status: "esperando...", "conectado ✓", "error: ...".

### C.7 Server-side additions para Fase C

- [ ] `GET /api/tasks` + `POST/PATCH/DELETE /api/tasks/:id` — expose TaskRepository.
- [ ] `GET /api/typed-memory` + CRUD — expose TypedMemoryRepository.
- [ ] `GET /api/scheduled` — ya existe (scheduled_actions).
- [ ] `GET /api/mcp-auth/status/:state` (NUEVO) — para polling del OAuth flow.

---

## Fase D — UX productividad estilo OpenCode (2 días)

> Features que transforman la UX de "funciona" a "se siente pulido". **No agrega features del server**, mejora cómo se usa lo existente.

**Entry:** Fase A (primitives) + Fase B+C (paneles).
**Exit:** command palette, keybindings, sidebar de sesiones, logs streaming.

### D.1 Command palette (Cmd+K)

- [ ] `client/src/components/CommandPalette.jsx` usando `cmdk`.
- [ ] Global hotkey Cmd+K / Ctrl+K → abre modal overlay.
- [ ] Comandos indexados:
  - Navegación: "Ir a Agents", "Ir a Metrics", etc (todas las secciones + subsecciones).
  - Acciones: "Nueva sesión PTY", "Nuevo chat con Claude", "Abrir logs", "Reload hooks".
  - Búsqueda: "Buscar contacto...", "Buscar memoria...".
- [ ] Fuzzy search.
- [ ] Docs inline: "Tip: Cmd+K para navegar rápido".

### D.2 Keybindings customizables

- [ ] `client/src/components/config/KeybindingsPanel.jsx`.
- [ ] Listar bindings default + overrides del user.
- [ ] Capturar: input de "nueva combinación", valida no conflicts.
- [ ] Persiste en `user_preferences` con key `keybindings`.
- [ ] Applied globalmente via context/hook `useKeybindings()`.
- [ ] Reset to defaults.

### D.3 Sidebar de sesiones con drag-drop

- [ ] Refactor `Sidebar.jsx` para incluir panel "Sessions" con árbol:
  - Grupo 1: PTY sessions activas.
  - Grupo 2: AI chats activos.
  - Grupo 3: Telegram conversations (últimas 10).
- [ ] Drag-drop para reordenar grupos (persistir).
- [ ] Drag session → split view (drop en zona derecha).

### D.4 Logs streaming en vivo

- [ ] WS endpoint nuevo `/ws/logs` (server-side, admin only) — stream de logs line-by-line.
- [ ] `LogsPanel` refactorizado: tab "Stream" vs "Tail file".
- [ ] Auto-scroll con pausa on-hover.
- [ ] Filtros: level, scope, search.
- [ ] Highlight de palabras buscadas.

### D.5 Reasoning summaries colapsables en chat

- [ ] Si el provider emite `thinking` blocks (Anthropic extended thinking), renderizar colapsados por default.
- [ ] Toggle "Show reasoning" en settings del chat (persist en user_preferences).

### D.6 Server-side additions para Fase D

- [ ] WS `/ws/logs` handler con filtros por query params.
- [ ] Hook en `Logger` para emitir cada línea al WS si hay suscriptores.

---

## Fase E — Config avanzada (1-2 días)

> Exponer en UI los flags/tuning del server que hoy solo son env vars.

**Entry:** Fase B (admin-only paneles).
**Exit:** 90% de env vars no-críticas tienen UI.

### E.1 `CompactionSettingsPanel`

- [ ] Toggles: `REACTIVE_COMPACT_ENABLED`, `MICROCOMPACT_ENABLED`.
- [ ] Tuning: `MICROCOMPACT_EVERY_TURNS`, `MICROCOMPACT_KEEP_LAST_K`, `AUTOCOMPACT_BUFFER_TOKENS`.
- [ ] Live stats: triggers count, last_trigger_at, tokens ahorrados.
- [ ] Setting guardado en `chat_settings` global → persist + runtime reload.

### E.2 `ModelTiersPanel`

- [ ] Editor visual del `MODEL_TIERS_JSON`.
- [ ] 3 columnas (cheap/balanced/premium) × 6 providers.
- [ ] Auto-detecta modelos disponibles via `/api/providers`.
- [ ] Botón "reset to defaults".

### E.3 `ToolsFilterPanel`

- [ ] Lista completa de tools registradas (core + MCP + lsp).
- [ ] Toggle on/off individual (persist en `MCP_DISABLED_TOOLS` o DB).
- [ ] Filtrar por categoría, admin-only, coordinator-only.
- [ ] Preview: "con estos filtros, el modelo ve N tools".

### E.4 `LSPStatusPanel`

- [ ] Consume `GET /api/lsp/status` (NUEVO — espeja `LSPServerManager.listServers()`).
- [ ] Muestra servers config'd con status (disponible / falta binario).
- [ ] Instrucciones de install por cada language server faltante.
- [ ] Botón "re-detect" (llama a `detectAvailableServers({force:true})`).

### E.5 `OrchestrationPanel` (opcional)

- [ ] Listar workflows activos via `GET /api/orchestration/workflows` (admin).
- [ ] Tree view: coordinator → delegated subagents (tipo + status + task).
- [ ] Ver resultado de cada delegation.
- [ ] Cancelar workflow en curso.

### E.6 Server-side additions para Fase E

- [ ] `GET /api/lsp/status` — expose LSPServerManager.
- [ ] `GET/PUT /api/config/compaction` — toggle y tuning de compactors.
- [ ] `GET/PUT /api/config/model-tiers` — editor del JSON.
- [ ] `GET /api/tools/all` — lista completa con metadata de filtros.

---

## Timeline consolidado

| Fase | Tiempo | Entregable | Depende de |
|------|--------|------------|-----------|
| A — Design system | 2–3 días | Paleta OC-2 + 6 primitives + layout 3-panel + integración | — |
| B — Paneles admin | 2–3 días | PermissionsPanel + HooksPanel + MetricsDashboard + UsersPanel + WorkspacesPanel | A |
| C — Features activos | 2–3 días | TasksPanel + SchedulerPanel + TypedMemoryPanel + SessionsPanel con share + SkillsPanel + McpOAuthWizard | A |
| D — UX productividad | 2 días | Command palette + keybindings + sidebar sessions + logs streaming + reasoning summaries | A, B, C |
| E — Config avanzada | 1–2 días | 5 paneles más (compaction, model tiers, tools filter, LSP status, orchestration) | B |

**Total: 9–13 días.**

Cada fase es mergeable a `main` independientemente. **Rollback:** cada feature agregada va detrás de un flag env `VITE_FEATURE_<NAME>` con default off → flip gradual post-validación.

---

## Flags de rollout (cliente)

Agregar a `client/.env.local` (o build-time):

```env
# Fase A
VITE_FEATURE_NEW_UI=false          # default mientras se migra

# Fase B
VITE_FEATURE_PERMISSIONS_PANEL=false
VITE_FEATURE_HOOKS_PANEL=false
VITE_FEATURE_METRICS_DASHBOARD=false
VITE_FEATURE_USERS_PANEL=false
VITE_FEATURE_WORKSPACES_PANEL=false

# Fase C
VITE_FEATURE_TASKS_PANEL=false
VITE_FEATURE_SCHEDULER_PANEL=false
VITE_FEATURE_TYPED_MEMORY_PANEL=false
VITE_FEATURE_SESSION_SHARING_UI=false
VITE_FEATURE_MCP_OAUTH_WIZARD=false

# Fase D
VITE_FEATURE_COMMAND_PALETTE=false
VITE_FEATURE_KEYBINDINGS_PANEL=false
VITE_FEATURE_LOGS_STREAMING=false

# Fase E
VITE_FEATURE_COMPACTION_PANEL=false
VITE_FEATURE_MODEL_TIERS_PANEL=false
VITE_FEATURE_TOOLS_FILTER_PANEL=false
VITE_FEATURE_LSP_PANEL=false
```

Cada componente chequea el flag al montar y muestra el panel viejo si false.

---

## Success criteria

**Cuantitativos:**
- [ ] 100% de endpoints `/api/*` del server tienen al menos un consumer en el client.
- [ ] 100% de flags env no-críticas son modificables desde UI.
- [ ] Bundle size del client < 500 KB gzipped inicial (lazy-load de Shiki + recharts).
- [ ] Lighthouse score ≥ 90 (performance + accessibility).

**Cualitativos:**
- [ ] Un admin sin acceso SSH al host puede operar Clawmint completamente (configurar, monitorear, debuggear).
- [ ] La UI se ve moderna y coherente (paleta OC-2 aplicada consistente).
- [ ] Tool calls, code blocks y diffs se ven igual que OpenCode (con el tema adaptado).
- [ ] Command palette reduce clicks para tareas comunes en ≥60%.

---

## Archivos críticos (refactor)

- `client/src/App.jsx` — layout 3-panel, integración de command palette.
- `client/src/styles/theme.css` — **NUEVO**, paleta OC-2.
- `client/src/components/primitives/*.jsx` — **NUEVOS**, ToolCall/CodeBlock/DiffViewer/StatusBar/Kbd/Collapsible.
- `client/src/components/ChatMessage.jsx` — integración de primitives.
- `client/src/components/config/*.jsx` — 12 paneles nuevos (ver cada fase).
- `client/src/stores/uiStore.js` — persistir layout sizes + theme + feature flags.
- `client/src/api/*.js` — módulos nuevos: tasks.js, scheduler.js, permissions.js, hooks.js, metrics.js, typedMemory.js, workspaces.js, mcpAuth.js, lsp.js.

## Archivos críticos (server additions)

Para soportar los gaps, el server necesita agregar:

- `server/routes/admin.js` — **NUEVO**. Endpoints `/api/auth/admin/users` (GET/PATCH).
- `server/routes/tasks.js` — **NUEVO**. CRUD REST sobre `TaskRepository`.
- `server/routes/typedMemory.js` — **NUEVO**. CRUD REST sobre `TypedMemoryRepository`.
- `server/routes/workspaces.js` — **NUEVO**. Espeja `workspace_status` tool.
- `server/routes/lsp.js` — **NUEVO**. Espeja `LSPServerManager.listServers()`.
- `server/routes/config.js` — **NUEVO**. Compaction/model-tiers/tools-filter settings.
- `server/routes/mcp-auth.js` — extender con `GET /status/:state` para polling.
- `server/ws/logs-handler.js` — **NUEVO**. WS `/ws/logs` streaming.

---

## Bugs / deudas técnicas oportunas

| Bug | Fix durante qué fase |
|---|---|
| `client/src/config.js` fallback roto a puerto 3002 (ya fixeado en sesión de packaging) | ✅ fixeado |
| TabBar horizontal no escala > 10 sesiones | Fase D (sidebar sessions) |
| Logs panel hace polling en vez de streaming | Fase D |
| Memory panel lista files pero no distingue typed vs .md | Fase C |
| No hay forma de ver qué permission rule matcheó (solo el resultado) | Fase B (PermissionsPanel con preview) |
| Welcome wizard no valida API key (solo la guarda) | Fase B (ProvidersPanel mejorado con test button real) |

---

## Parked para v2

- **Collaborative editing** de memory files (multi-user simultáneo con OT/CRDT).
- **Mobile-first design** — hoy es responsive pero sin layout mobile dedicado.
- **Theming custom** — el user puede crear themes además de light/dark.
- **Extensions API** del client — para que plugins externos agreguen paneles.
- **i18n** — hoy todo está en español, parked traducción a inglés/portugués.
- **Analytics dashboard** propio (al estilo Datadog) con alertas.
