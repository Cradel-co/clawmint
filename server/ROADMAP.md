# Roadmap — Refactor a paridad con Claude Code v2.1.88

Plan maestro: `C:\Users\padil\.claude\plans\frolicking-bubbling-key.md`

**Decisiones confirmadas:**
- Plan completo en fases secuenciales.
- WebSearch vía **Brave Search API** (env `BRAVE_SEARCH_API_KEY`).
- Ripgrep vía paquete **`@vscode/ripgrep`** (binario multiplataforma).

**Leyenda:** `[ ]` pendiente · `[~]` en progreso · `[x]` hecho · `[!]` bloqueado/revisar

---

## Revisión de modularidad (2026-04-18) — ajustes antes de ejecutar Fases 4+

Revisión crítica de las fases pendientes (4–11) con foco en **modularidad y separación de responsabilidades**. Cada ítem marca un ajuste a aplicar **antes de codear la fase correspondiente**. No re-ordena el plan; solo refina los límites entre módulos para que cada uno tenga una responsabilidad clara y pueda testearse aislado.

### Principios que se deben aplicar a Fases 4+

1. **Un módulo = una responsabilidad.** Si un archivo hace 3 cosas, son 3 archivos.
2. **Inyección de dependencias por constructor.** Nada de `require('./X')` dentro de métodos.
3. **Eventos documentados.** Cada evento emitido tiene payload shape en `docs/events.md` o `@typedef`. Los consumidores nunca hardcodean strings.
4. **Flags por feature, no por fase.** Rollback quirúrgico sin revertir todo.
5. **Retrocompat explícita.** Cada cambio dice cuándo se EOL el camino viejo.
6. **Fail-open en funcionalidades opcionales.** Si LSP/hooks/worktrees mueren, el motor sigue.

### Pre-requisitos nuevos antes de Fase 4 y 5 (ahora obligatorios)

- [ ] `docs/fase-4-investigacion.md` — shape actual de `_processApiProvider` (líneas 757–952), callsites de `onChunk`/`onStatus`/`onAskPermission`, y mapa de bugs vivos. Sin este doc revisado, no se abre PR.
- [ ] `docs/fase-5-investigacion.md` — shape actual de `AgentOrchestrator`, cómo fluye `_isDelegated`, dónde se construye el toolset por agente, y si `agents.js` ya tiene concepto de tipo/rol.

### Ajustes a Fase 4 — LoopRunner

- [ ] **Split en sub-módulos** (evita monolito de 5 responsabilidades):
  - `core/LoopRunner.js` — ejecuta una iteración, emite eventos, delega el resto
  - `core/RetryPolicy.js` — `shouldRetry(error, {usedTools, attempt}) → {retry, delayMs}`; clasifica transient vs permanent
  - `core/LoopDetector.js` — ring buffer de `{toolName, argsHash}`, expone `detect(toolCall) → boolean`
  - `core/CallbackGuard.js` — `wrap(cb, {onError}) → safeCb`; emite `callback_error` al event bus
- [ ] **`maxToolIters` configurable por agente**: `agentDef.maxToolIters` con fallback a env `MAX_TOOL_ITERS` (default 25).
- [ ] **Eventos tipados**: exportar `const LOOP_EVENTS = { START, TOOL, RETRY, CANCEL, DONE, CALLBACK_ERROR, LOOP_DETECTED }` desde `core/LoopRunner.js`. Agregar `@typedef` de cada payload.
- [ ] **Error classification fuera del runner**: `RetryPolicy` dueño único de la decisión.

### Ajustes a Fase 5 — Subagentes + permisos

- [ ] **`SubagentRegistry` sin conocer providers**:
  - `SubagentType` (declarativo puro): `{type, description, allowedToolPatterns: string[], defaultModel?: string, maxDelegationDepth?: number}`
  - `SubagentResolver` (inyectable): traduce `type → {provider, model, tools, cwd}` consultando capabilities + permission patterns
- [ ] **Permisos desacoplados de subagentes**: `SubagentRegistry` NO importa `PermissionService`. Es `LoopRunner` el que consulta permisos antes de ejecutar. Fuerza separación.
- [ ] **`PermissionRepository` con índice compuesto**:
  ```sql
  CREATE INDEX idx_permissions_scope_tool ON permissions(scope_type, scope_id, tool_pattern);
  ```
- [ ] **Routes admin en `api/permissions.js`** (módulo HTTP aparte), no en el servicio. `PermissionService` no debe saber de Express.
- [ ] **Resolución de múltiples matches**: documentar explícitamente — **patrón más específico gana** (longitud sin `*`), tie-break por `created_at DESC`. Agregar test dedicado.
- [ ] **Subagente `plan`**: agregar `read_file`, `grep`, `glob` al toolset. Sin eso el plan es abstracto/inútil.
- [ ] **`_delegationDepth` atómico**: documentar que depende del modelo single-threaded de Node. Si en el futuro se usan worker threads, revisar.

### Ajustes a Fase 6 — Hooks

- [ ] **Plugin pattern para executors**:
  ```js
  hookRegistry.registerExecutor('shell', ShellExecutor)
  hookRegistry.registerExecutor('http', HttpExecutor)
  // Fases futuras suman executors sin tocar HookRegistry
  ```
- [ ] **`replace: { args }` en vez de `mutate: { args }`** — inmutable, sin ambigüedad sobre qué handler ganó.
- [ ] **Orden hook ↔ permission**: documentar formalmente — **permission siempre evalúa los args finales post-hook-pre**. Sin ambigüedad.
- [ ] **Timeout per-hook** en `HookRepository.timeout_ms` (default 10s, override por regla).
- [ ] **Hot-reload de hooks**: endpoint `POST /api/hooks/reload` + evento `hook:reloaded`. Sin restart del server para testing.

### Ajustes a Fase 7 — Eficiencia de contexto

- [ ] **Interface `ContextCompactor` única**:
  ```js
  interface ContextCompactor {
    shouldCompact(state): boolean
    compact(history): Promise<compactedHistory>
  }
  ```
  `MicroCompactor`, `ReactiveCompactor`, `SlidingWindowCompactor` (el viejo) implementan. `CompactorPipeline` orquesta en cascada.
- [ ] **Tool `tool_search` separada de `tool_load`**: dos tools independientes en vez de `{query|select}` unión. Más claro, JSON Schema limpio.
- [ ] **Whitelist de tools "siempre visibles" por agente**: `agentDef.alwaysVisibleTools[]` con fallback a env `ALWAYS_VISIBLE_TOOLS` CSV.
- [ ] **`MetricsService` nuevo**: cache hit rate, compact trigger count, provider latency. No mezclar métricas dentro de providers individuales.

### Ajustes a Fase 8 — Memoria tipada + worktrees

- [ ] **Cap de MEMORY.md por scope**: `MEMORY_MAX_TOKENS_PER_SCOPE=500` env. Concatenación con prioridad `chat > user > agent > global` (más específico arriba).
- [ ] **`WorkspaceProvider` interface** (invertir dependencia):
  ```js
  interface WorkspaceProvider {
    acquire(ctx): Promise<{cwd, release(): Promise<void>}>
  }
  ```
  `NullWorkspace` (cwd actual, default), `WorktreeWorkspace` (git worktree). Subagent declara provider.
- [ ] **GC de worktrees reusa `scheduler.js`**: job recurrente cada 6h, no timer interno duplicado.
- [ ] **Alias opaco `$WORKSPACE`** en vez de exponer el path real del worktree al modelo.

### Ajustes a Fase 9 — Tools agénticas

- [ ] **`ResumableSession` en Fase 4** (prerrequisito): contrato entre `LoopRunner` ↔ scheduler para que `schedule_wakeup` sepa cómo re-hidratar la session. Definirlo **ahora** en Fase 4 aunque la tool llegue en Fase 9.
- [ ] **`LoopRunner.suspend(question) → answer`**: API nativa para `ask_user_question`. Diseñar en Fase 4, consumir en 9.
- [ ] **`JobQuotaService`**: limite N crons/usuario + N invocaciones/hora. Aparte del rate limit de websearch.
- [ ] **`enter_plan_mode` con auto-exit**: timeout 5min de inactividad + evento `plan_mode:timeout`. Evita quedar colgado.

### Ajustes a Fase 10 — LSP (opcional)

- [ ] **Empaquetar como plugin externo** (`packages/lsp-tools/` o paquete npm separado), no core de Clawmint. Si el usuario dev-céntrico lo quiere, lo habilita; familias/domótica lo ignoran.
- [ ] **Fail-open si LSP no arranca**: tools `lsp_*` se ocultan (sumadas a `MCP_DISABLED_TOOLS` dinámico) + log warning. No crashear el server.

### Ajustes a Fase 11 — MCP OAuth + slash commands

- [ ] **Parser de slash commands en `ConversationService.processMessage`** (middleware), no en cada canal. Detecta `^/\w+`, resuelve skill, inyecta `<system-reminder>`, strippea `/cmd` del texto. Una sola impl, todos los canales.
- [ ] **Cifrado de tokens MCP**: derivar clave de password del usuario (scrypt) o KMS. Nunca plaintext. Documentar el esquema.
- [ ] **EOL de `server/auth/google-oauth.js`**: mantener 2 releases con warning log antes de remover. Migración gradual.

### Gaps transversales (agregar como fases nuevas o inline)

- [ ] **`docs/events.md`** (o `events.d.ts`): registro central de eventos emitidos por el server. Payload shape por evento. Crear antes de Fase 4.
- [ ] **Fase 5.5 — Observabilidad** (2 días, bloquea Fase 6+):
  - [ ] `core/MetricsService.js` (Prometheus format, endpoint `/metrics`)
  - [ ] `core/StructuredLogger.js` (JSON logs + `correlation_id` por request propagado al ctx de tools)
  - [ ] Sin esto, con 10 fases encima debugear es ciego.
- [ ] **Fase 5.75 — Hardening de seguridad** (1–2 días, bloquea Fase 6 y 11):
  - [ ] Auditoría SSRF en hooks HTTP (reusar SSRF guard de `web.js`)
  - [ ] Prompt injection en skills MD (sanitización de marcadores `<system-reminder>` en body)
  - [ ] Sandboxing de shell hooks (PATH clean, env allowlist, cwd restringido)
  - [ ] Revisión de MCPs externos (whitelist + confirmación admin para instalar nuevos)
- [ ] **Plan de EOL del `legacyShim`**: después de 1 release de prod estable con `PROVIDER_V2_ENABLED_FOR` default activo y sin reports, remover `providers/base/legacyShim.js` + `*.legacy.js` + `getV2`/`isV2` branching. Documentar fecha target.
- [ ] **Cobertura mínima estándar**: cada módulo nuevo tiene 1 happy path + 1 error path + 1 edge case como mínimo (ya aplicado en Fases 0–3; formalizar para 4+).

### Orden recomendado ajustado

```
Fase 4  → LoopRunner (con RetryPolicy, LoopDetector, CallbackGuard separados) + ResumableSession API
Fase 5  → Subagentes + Permisos (decoupled)
Fase 5.5 → Observabilidad (metrics + structured logs + docs/events.md)
Fase 5.75 → Hardening de seguridad
Fase 6  → Hooks (con plugin pattern de executors)
Fase 7  → Eficiencia de contexto (ContextCompactor interface)
Fase 8  → Memoria tipada + worktrees (WorkspaceProvider)
Fase 9  → Tools agénticas (consume ResumableSession de Fase 4)
Fase 10 → LSP (opcional, como paquete separado)
Fase 11 → MCP OAuth + slash middleware
```

Fases 5.5 y 5.75 son **pre-requisitos bloqueantes** para 6+. Sin ellos, la complejidad de 6–11 compuesta es inmanejable.

---

## Fase 0 — Base e infraestructura (1–2 días) ✅ COMPLETADA

**Entry:** código actual estable, tests actuales pasan.
**Exit:** infra v2 en su sitio, cero cambio funcional observable.

### Archivos a crear
- [x] `providers/base/BaseProvider.js` — clase abstracta + contrato `chat()` v2
- [x] `providers/base/ProviderEvents.js` — tipos canónicos (text_delta, tool_call_*, thinking_delta, cache_stats, usage, done, error)
- [x] `providers/base/StreamAdapter.js` — stubs para fromAnthropic/fromOpenAI/fromGemini
- [x] `providers/base/ToolConverter.js` — migra `tools.js` 1:1 + enum + oneOf→anyOf + nested + pattern
- [x] `providers/base/Cancellation.js` — `linkSignals()`, `withTimeout()`
- [x] `providers/base/legacyShim.js` — envuelve providers viejos con firma v2
- [x] `providers/base/ImageContentBuilder.js` — content multimodal uniforme
- [x] `providers/capabilities.js` — mapa `{provider → Capabilities}`
- [x] `test/tool-converter.test.js` — 18 tests passing
- [x] `test/legacy-shim.test.js` — 7 tests passing

### Archivos a modificar
- [x] `providers/index.js` — agregar `getCapabilities(name)`, `getV2(name)`, `isV2(name)`; flag `PROVIDER_V2_ENABLED_FOR`
- [x] `tools.js` — delegar a `ToolConverter` manteniendo API pública
- [x] `mcp-client-pool.js` — reemplazar flag `reconnecting` por `Map<name, Promise>` (fix race)

### Bugs cerrados en esta fase
- [x] Race en flag `conn.reconnecting` (mcp-client-pool.js:125)
- [x] `TOOLS` calculado en load-time sin channel (tools.js:118) — ahora pasa por ToolConverter con opts
- [x] Enum/oneOf/pattern perdidos en conversión — soportados en ToolConverter

**Flag:** `PROVIDER_V2_ENABLED_FOR=[]` (ninguno activo todavía)

**Resultado:** Mis tests 25/25 verdes. Los test suites que fallan en el proyecto (storage.test.js, mcp.router.test.js, mcp.tools.test.js, providers.test.js, tools.test.js) son **preexistentes** — fallan tanto con mis cambios como sin ellos (admin gate en `mcp/tools/index.js` no cubierto por tests viejos, `this._db.prepare` mismatch, expected length 6 vs 8 providers).

---

## Fase 1 — Anthropic v2: streaming + cache + thinking (2–3 días) ✅ COMPLETADA

**Entry:** Fase 0 completa.
**Exit:** Anthropic v2 en prod detrás de flag; rollback vía env.

### Tareas
- [x] `providers/anthropic.legacy.js` — backup del actual
- [x] Reescribir `providers/anthropic.js`:
  - [x] Usar `client.messages.stream({ signal, ...req })` (alto nivel con `finalMessage()`)
  - [x] Procesar SSE: `content_block_delta` (text_delta + thinking_delta), finalMessage() para el ensamblado completo
  - [x] `input_json_delta.partial_json` parseado automáticamente por el SDK en `finalMessage()`
  - [x] `enableCache`: `cache_control: { type: 'ephemeral' }` en último bloque de `system` (si >1000 chars) y fin de `tools`
  - [x] `enableThinking` modos `'adaptive'` | `'enabled'` | número shorthand; `temperature=1` forzado si thinking activo; `budget_tokens ≥ 1024` clamp
  - [x] Preservar bloque `thinking` al reenviar history con tool_use (se pasa `content` completo de finalMessage al assistant turn)
  - [x] `maxTokens` dinámico via `resolveMaxTokens(model)`: 16000 Opus / 8192 Sonnet / 4096 Haiku
  - [x] Emitir `cache_stats` desde `usage.cache_creation_input_tokens` / `cache_read_input_tokens`
  - [x] Cancelación real vía `signal` (pasado a `client.messages.stream(req, { signal })`)
  - [x] Manejo de error: `catch` detecta `signal.aborted` y emite `done` con mensaje "Cancelado"
- [x] `test/anthropic.v2.test.js` — 25 tests passing:
  - [x] stream emite 'text' por chunk (progresivo, no al final)
  - [x] cache hit reporta cache_stats con creation/read
  - [x] thinking_delta emite 'thinking'
  - [x] AbortSignal previo a request → done con "Cancelado"
  - [x] tool_use → executeTool → tool_result round trip
  - [x] max_tokens dinámico según modelo
  - [x] enableThinking → thinking en request + temperature=1
  - [x] Error del SDK → done con mensaje de error

### Archivos a modificar
- [x] `provider-config.js` — warning stderr una sola vez por provider si key en JSON plaintext
- [x] `providers/capabilities.js` — anthropic ahora declara streaming/cache/thinking/cancellation=true

### Bugs cerrados
- [x] `max_tokens: 4096` hardcoded (anthropic.js:32) — ahora dinámico
- [x] API key plaintext (provider-config.json) — warning en stderr al leer
- [x] Timeout 60s interno hardcoded — eliminado (ahora gestionado por caller via signal)
- [x] Imágenes ignoradas silenciosamente (parcial: anthropic soporta imágenes nativas, el resto viene en Fase 2)

**Flags:** `PROVIDER_V2_ENABLED_FOR=anthropic` (env var para activar contrato v2 explícito), `ANTHROPIC_USE_V2=false` (rollback)

**Resultado:** 25/25 tests de anthropic.v2 pasan. Fase 0+1 total: 50/50. ConversationService ahora recibe `text` events en streaming progresivo en vez de un solo blob al final — mejora inmediata de UX sin cambios de API.

---

## Fase 2 — OpenAI, Gemini, DeepSeek, Grok, Ollama v2 (3–5 días) ✅ COMPLETADA

**Entry:** Fase 1 en prod estable.
**Exit:** 8/8 providers con contrato v2.

**Orden aplicado:** openai → deepseek → grok → gemini → ollama

### Helper compartido (no documentado en el plan original)
- [x] `providers/base/openaiCompatChat.js` — helper central usado por `openai.js`, `deepseek.js`, `grok.js` y la rama de tools de `ollama.js`. Centraliza streaming SSE, acumulación de `tool_calls[i].function.arguments` fragmentados por `index`, cancelación vía `AbortSignal`, y emisión de error descriptivo al modelo si `JSON.parse` falla (no silencia con `{}`).

### Por cada provider
- [x] `providers/<name>.legacy.js` — backup creado para los 5 providers
- [x] Reescribir con contrato v2 + streaming + cancelación vía `signal`
- [x] Declarar capabilities reales en `capabilities.js`
- [x] Test: streaming + tool_call + cancelación + error handling

### OpenAI / DeepSeek / Grok (SDK compartido)
- [x] `chat.completions.create({ stream: true, signal })` vía `openaiCompatChat`
- [x] Acumular `delta.tool_calls[i].function.arguments` por `index`
- [x] Parsear JSON al cierre; si falla → emite error descriptivo al modelo con el raw (no silencia con `{}`)
- [x] `DEEPSEEK_TIMEOUT_MS = 60_000` extraído a constante nombrada (deepseek.js:8)

### Gemini
- [x] `ai.models.generateContentStream({ signal })` — cancelación propagada al fetch subyacente
- [x] Loop asincrónico procesando `functionCall` (llega completo, no fragmentado en Gemini)
- [x] `config.systemInstruction` en vez de first message (peculiaridad Gemini)

### Ollama
- [x] Split interno: rama vision (HTTP nativo `/api/chat`, streaming, sin tools) / rama OpenAI-compat (`openaiCompatChat`, con tools, sin vision)
- [x] Si `images && tools.length > 0` → error con `code:'unsupported_combo'` (no silencia)
- [x] `OLLAMA_VISION_TIMEOUT_MS = 300_000` extraído a constante nombrada (ollama.js:26)

### Cleanup adicional
- [x] `providers/base/StreamAdapter.js` eliminado — era código muerto (stubs que throweaban), reemplazado por `openaiCompatChat.js` para OpenAI family y `client.messages.stream()` directo en anthropic.js
- [x] `PROVIDER_V2_ENABLED_FOR` default activo: si env no está seteada, incluye los 6 providers (providers/index.js:22–31). Rollback individual via `ANTHROPIC_USE_V2=false` o env explícita.

### Bugs cerrados
- [x] Imágenes ignoradas silenciosamente → `ImageContentBuilder` + capabilities
- [x] Ollama vision sin tools silencioso → gate explícito `unsupported_combo`
- [x] `JSON.parse` silencioso con `{}` → error descriptivo al modelo via `openaiCompatChat`
- [x] Timeouts inconsistentes → extraídos a constantes nombradas

### Tests (todos passing al cierre)
- [x] `test/tool-converter.test.js` — 18 tests (shape anthropic/openai/gemini + enum/oneOf/nested/pattern)
- [x] `test/legacy-shim.test.js` — 7 tests
- [x] `test/anthropic.v2.test.js` — 25 tests
- [x] `test/gemini.v2.test.js` — 34 tests
- [x] `test/ollama.v2.test.js` — 4 tests
- [x] `test/openai-compat.test.js` — 5 tests
- **Total Fase 0+1+2: 76/76 passing**

**Flag:** `PROVIDER_V2_ENABLED_FOR` default = `['anthropic','openai','deepseek','grok','gemini','ollama']`. Rollback a legacy vía env vacía o override.

---

## Fase 3 — Nuevas tools MCP (2–3 días) ✅ COMPLETADA

**Entry:** Fase 2 completa.
**Exit:** tools nuevas visibles y consumibles por cualquier provider v2.

### Dependencias nuevas
- [x] `npm i @vscode/ripgrep` (binario multiplataforma, v1.15+)
- [x] `npm i turndown` (HTML → Markdown, v7.x)
- [x] Documentar env var `BRAVE_SEARCH_API_KEY`

### `mcp/tools/search.js`
- [x] Tool `glob` — params `{ pattern, path?, limit? }` — usa `rgPath --files -g <pattern>`
- [x] Tool `grep` — params `{ pattern, path?, glob?, type?, mode, -A, -B, -C, multiline }` — flags whitelist
- [x] Timeout 30s, respeta `assertPathAllowed`
- [x] Fix critical: `stdio: ['ignore', 'pipe', 'pipe']` — sin esto, rg detecta stdin=pipe y se cuelga esperando input
- [x] Deprecar `files.js::search_files` con warning en primer uso
- [x] `test/tools.search.test.js` — 13 tests

### `mcp/tools/web.js`
- [x] Tool `webfetch` — params `{ url, extract?: 'text'|'html'|'markdown' }`
- [x] Fetch nativo + timeout 15s + MIME whitelist + SSRF guard (bloquea 127.x/10.x/192.168.x/172.16-31.x/169.254.x/localhost) + límite 100KB post-conversion
- [x] HTML→markdown vía turndown con reglas extra: fenced code con lang, strip de script/style/nav/footer
- [x] Tool `websearch` — params `{ query, limit?: 5 }` — Brave Search API
- [x] Rate limit 1 req/s (in-memory, configurable via `LimitsRepo.resolve('rate', ...)`)
- [x] Si falta `BRAVE_SEARCH_API_KEY` → error explícito con URL para obtener key
- [x] Formato: `N. title\n   url\n   snippet` por línea
- [x] `test/tools.web.test.js` — 21 tests (con stub de global.fetch)

### `mcp/tools/tasks.js` + `storage/TaskRepository.js`
- [x] Schema: `tasks(id, chat_id, user_id, agent_key, title, description, status, parent_id, metadata_json, created_at, updated_at)` + CHECK constraint en status + FK con CASCADE en parent_id
- [x] Migration vía `TaskRepository.init()` + registro en `bootstrap.js` con inyección en `ConversationService` y `ctx` de tools
- [x] Tools: `task_create`, `task_list`, `task_get`, `task_update`, `task_delete`
- [x] Scope por `chat_id` del ctx (admins con `_adminGlobal=true` ven todo)
- [x] Resuelve id post-INSERT via `SELECT last_insert_rowid()` (sqlite-wrapper no expone `lastInsertRowid`)
- [x] `test/tools.tasks.test.js` — 16 tests (CRUD + cascade + aislamiento + validación de status)

### `mcp/tools/skills.js`
- [x] Tool `skill_list` (solo metadata name + description)
- [x] Tool `skill_invoke(slug, input?)`: devuelve body envuelto en `<system-reminder source="skill:<slug>">` — el modelo lo lee en el turno siguiente como tool-result con efecto semántico equivalente a un system-reminder
- [x] Emite evento `skill:invoked` al eventBus si está (para telemetría + futura promoción a system real en Fase 4 LoopRunner)
- [x] Flag `SKILLS_EAGER_LOAD=false` default — `buildAgentPrompt()` ahora solo inyecta índice (slug+description) en vez de body completo de todos los skills. Ahorra tokens masivamente.
- [x] `test/tools.skills.test.js` — 7 tests

### `mcp/ShellSession.js`
- [x] `MAX_BUF_BYTES = 2 * 1024 * 1024` ring buffer con prefijo `[truncado N bytes — últimos 2MB]` — FIFO (descarta inicio)
- [x] Mismo para stderr vía `makeRingBuf()` helper
- [x] Kill SIGKILL si >50MB/s sostenido (detectado con interval 1s + accumulator)
- [x] Tests extendidos en `test/mcp.shell.test.js` — 13 tests (con 2 nuevos: FIFO truncate + runaway kill, skipped en Windows)

### `mcp/tools/index.js`
- [x] Registrar tools nuevas — los 10 tools nuevos visibles en `all()` (total 61 con externos en coordinator mode)
- [x] Filtro `MCP_DISABLED_TOOLS` CSV — aplica tanto en `all()` como en `execute()` (tool rechazada con mensaje explícito)

### Bugs cerrados
- [x] ShellSession sin límite de buffer (riesgo OOM) → ring buffer + kill runaway
- [x] Skills no invocables dinámicamente → tool `skill_invoke` con inyección via marker
- [x] `search_files` glob simple sin ripgrep → nueva tool `glob` con rg + warning deprecado en primer uso
- [x] Eager-load de skills costoso en tokens → flag `SKILLS_EAGER_LOAD=false` default

**Flag:** `MCP_DISABLED_TOOLS` CSV para desactivar selectivamente sin rebuild.

### Tests agregados
- `test/tools.tasks.test.js`   — 16/16 passing
- `test/tools.search.test.js`  — 13/13 passing
- `test/tools.skills.test.js`  — 7/7 passing
- `test/tools.web.test.js`     — 21/21 passing
- `test/mcp.shell.test.js`     — 13/13 passing (2 nuevos skipped en Windows)
- **Total Fase 3: 70 tests nuevos + extensiones**

**Total acumulado (Fases 0+1+2+3): 144 tests del refactor passing.**

---

## Fase 4 — LoopRunner + cancelación real (2–3 días) ✅ COMPLETADA

**Entry:** Fase 3 completa.
**Exit:** `_processApiProvider` reducido a camino runner (+ legacy preservado por flag); `LoopRunner` cubre todos los casos con fixes.

### Diseño modular (revisión 2026-04-18)

Se aplicó el ajuste de modularidad: en vez de un monolito, el loop se divide en 4 módulos con responsabilidad única cada uno.

- [x] `core/RetryPolicy.js` — funciones puras; clasifica errores (transient/permanent) y calcula backoff exponencial con jitter y cap
- [x] `core/LoopDetector.js` — ring buffer de `{name, argsHash}`; detecta N consecutivos idénticos
- [x] `core/CallbackGuard.js` — envuelve callbacks del host; errores → evento `loop:callback_error` sin propagar
- [x] `core/LoopRunner.js` — orquesta los 3 anteriores + stream del provider; emite `LOOP_EVENTS` tipados
- [x] `docs/events.md` — registro central de todos los eventos del server con payload shape
- [x] `docs/fase-4-investigacion.md` — investigación previa con mapa de responsabilidades + bugs vivos confirmados

### `core/LoopRunner.js`
- [x] Extraer lógica de `ConversationService._processApiProvider` (líneas 755–948) a `LoopRunner.run({chatId, provObj, chatArgs, onChunk, onStatus, signal, timeoutMs})`
- [x] `AbortController` por intento, linkeado a signal externo + timeout vía `withTimeout()` de `providers/base/Cancellation.js`
- [x] Timeout ahora cancela el stream: `controller.abort()` → provider recibe `signal.aborted`
- [x] Callbacks envueltos con `CallbackGuard.wrap(name, cb)` → try/catch + emit `loop:callback_error`
- [x] `structuredClone(history)` al inicio en `_cloneChatArgs` — fixea race shallow-copy
- [x] Detección de loops: ring 5 de `{toolName, argsHash}`; 3 consecutivos iguales → emit `loop:loop_detected` + abort con reason `loop_detected`
- [x] Retries exponenciales SOLO si `!usedToolsEver` — garantizado por `RetryPolicy.shouldRetry({usedTools})`
- [x] Emite `loop:start`, `loop:text_delta`, `loop:tool_call`, `loop:tool_result`, `loop:retry`, `loop:cancel`, `loop:loop_detected`, `loop:callback_error`, `loop:done`
- [x] `LoopRunner.EVENTS` exportado + documentado en `docs/events.md`
- [ ] `maxToolIters` default 25 configurable — *parked*: el runner actual no ejecuta tools inline (lo hace el provider vía `executeTool`), así que el límite vive en el agente/provider. Queda pendiente cuando se mueva la ejecución de tools al runner.

### Modificar `ConversationService`
- [x] `_processApiProvider` usa `loopRunner.run()` detrás de flag `USE_LOOP_RUNNER=true` (default)
- [x] Path legacy preservado íntegro para rollback (`USE_LOOP_RUNNER=false`)
- [ ] Rate limiter LRU cap + cleanup on-write (no solo interval) — *parked para Fase 5.5 Observabilidad*

### Tests `test/loop-runner.test.js` — 10/10 passing
- [x] Callback que throwea no rompe loop (emite `loop:callback_error`)
- [x] Deep-clone verificado: mutación externa del history no afecta al runner
- [x] Timeout cancela stream real (mock verifica abort y emite `loop:cancel` con `reason:'timeout'`)
- [x] Parent signal externo aborta → `loop:cancel` con `reason:'signal'`
- [x] 3 tool_calls idénticos consecutivos → `loop:loop_detected` + cancel
- [x] Retry no ocurre si ya se ejecutaron tools
- [x] Retry en error transient: dos intentos, segundo ok
- [x] Error permanente → no retry
- [x] Tests RetryPolicy (15), LoopDetector (10), CallbackGuard (8) → 33 tests extra

### Bugs cerrados
- [x] Timeout global no cancela stream (ConversationService.js:879) → `AbortController` real linkeado al provider via `signal` en chatArgs
- [x] Callbacks que throwean rompen loop (:888, :892) → `CallbackGuard` los captura
- [x] Race en history shallow-copy (:847) → `structuredClone` al entrar
- [x] `_processApiProvider` 190 LOC con 5 responsabilidades → camino runner es ~15 LOC; resto queda para limpieza cuando se apague el path legacy

**Flag:** `USE_LOOP_RUNNER=true` (default cuando `loopRunner` está inyectado); `false` fuerza path legacy.

**Total acumulado (Fases 0+1+2+3+4): 180 tests del refactor passing.**

---

## Fase 5 — Subagentes tipados + permisos granulares (3–4 días) ✅ COMPLETADA

**Entry:** Fase 4 en prod estable.
**Exit:** paridad funcional objetivo alcanzada.

### Diseño modular aplicado (revisión 2026-04-18)

Separación estricta: **`SubagentRegistry` (definición)** ≠ **`SubagentResolver` (instancia)** ≠ **`PermissionService` (gating)**. Ninguno importa al otro directamente; `ConversationService` los compone.

- [x] `docs/fase-5-investigacion.md` — pre-requisito con mapa de archivos, bugs vivos y shape actual.

### `core/SubagentRegistry.js`
- [x] Registry estático hardcoded con 5 tipos `Object.freeze` (inmutable)
- [x] Tipo `explore` — Haiku, read-only (read_file, grep, glob, webfetch, list_dir)
- [x] Tipo `plan` — Sonnet, read-only sin side effects
- [x] Tipo `code` — Opus, toolset completo (`*`), maxDelegationDepth=1
- [x] Tipo `researcher` — Sonnet, webfetch + websearch + memory_* + read_file/glob/grep
- [x] Tipo `general` — hereda del coordinador (allowedToolPatterns=null)
- [x] 12/12 tests passing en `test/subagent-registry.test.js`

### `core/SubagentResolver.js`
- [x] `resolve(typeName, ctx) → {type, agentKey, provider, model, allowedToolPatterns, maxDelegationDepth}`
- [x] Case-insensitive en typeName; error descriptivo si tipo no existe
- [x] `general` hereda `coordinatorAgentKey` del ctx
- [x] Retorna COPIA de `allowedToolPatterns` (consumers pueden push de tools siempre visibles)
- [x] 9/9 tests passing en `test/subagent-resolver.test.js`

### Modificar `core/AgentOrchestrator.js`
- [x] `delegateTask` acepta `subagentType` como alternativa a `targetAgent`
- [x] `parentDelegationDepth` param + propagación de `_delegationDepth = parent + 1` al ctx delegado
- [x] `MAX_DELEGATION_DEPTH=3` hardcoded (tope global recursivo) + `MAX_DELEGATIONS=5` por workflow
- [x] Si subagente tipo tiene `maxDelegationDepth=0` y profundidad > 1 → rechazo explícito
- [x] `askAgent` también acepta `parentDelegationDepth`

### Modificar `services/ConversationService.js`
- [x] `processMessage` firma acepta `_isDelegated`, `_delegationDepth`, `_subagentConfig`
- [x] Bloquea con mensaje si `_delegationDepth > 3` al entrar
- [x] `_processApiProvider` propaga los 3 params hasta el ctx de tools
- [x] `execToolFn` envuelto con **permission gate ANTES del mode wrapper**
- [x] `ctx.allowedToolPatterns` propagado desde `_subagentConfig` → filtrado en `mcp/tools/index.js::execute()`

### `storage/PermissionRepository.js`
- [x] Schema `permissions(id, scope_type, scope_id, tool_pattern, action, reason, created_at, updated_at)` con CHECK constraints
- [x] Índice compuesto `idx_permissions_scope_tool(scope_type, scope_id, tool_pattern)`
- [x] `scope_type ∈ {chat, user, role, channel, global}`
- [x] `tool_pattern` con wildcards: `*`, `prefix_*`, exact match
- [x] `resolve(toolName, ctx) → {action, rule} | null` — orden scope `chat → user → role → channel → global`; dentro del scope gana el más específico (`exact > prefix_* > *`); tie-break por `created_at DESC`
- [x] Resuelve id post-INSERT via `SELECT last_insert_rowid()` (patrón sqlite-wrapper)
- [x] 16/16 tests passing en `test/permission-repository.test.js`

### `core/PermissionService.js`
- [x] Wrapper delgado sobre repo; expone `resolve(toolName, ctx) → 'auto'|'ask'|'deny'`
- [x] Flag `PERMISSIONS_ENABLED=false` default → retorna `'auto'` siempre (bypass)
- [x] Default `'auto'` cuando no hay reglas que matcheen (retrocompat)
- [x] Resuelve `role` vía `usersRepo` si no viene en ctx
- [x] API CRUD delegada al repo: `list`, `create`, `remove`, `getById`, `count`
- [x] 10/10 tests passing en `test/permission-service.test.js`

### Routes admin + middleware
- [x] `middleware/requireAdmin.js` — factory que consulta `usersRepo.getById(userId).role === 'admin'`. Bypass para internal. Monta después de `requireAuth`
- [x] `routes/permissions.js` — Express Router factory con GET /status, GET /, POST /, DELETE /:id
- [x] `index.js` monta `app.use('/api/permissions', requireAuth, requireAdmin, router)`
- [x] 14/14 tests passing en `test/routes.permissions.test.js`

### Integración tools + delegación
- [x] `mcp/tools/index.js::all()` filtra por `opts.isDelegated` (oculta `coordinatorOnly` aunque role='coordinator') y por `opts.allowedToolPatterns` con glob matching
- [x] `mcp/tools/index.js::execute()` **defensive gate**: rechaza `coordinatorOnly` si `ctx._isDelegated=true`, y rechaza tools fuera de `ctx.allowedToolPatterns`
- [x] `mcp/tools/orchestration.js::delegate_task` acepta `subagent_type` como alternativa a `agent`; propaga `ctx._delegationDepth`
- [x] Tool nueva `list_subagent_types` — lista los 5 tipos con descripción

### Permission gate flow en `ConversationService`
1. Construir `rawExecFn` con ctx completo.
2. Envolver con **permission gate** (si `permissionService` está inyectado): `resolve()` → `deny` rechaza, `ask` invoca `onAskPermission`, `auto` pasa.
3. Aplicar **mode wrapper** encima (plan simula, ask legacy solo si `!permissionService.enabled` — evita doble prompt).
4. Pasar `execToolFn` final al provider.

### Flag de rollout
- **`PERMISSIONS_ENABLED=false` default** → `resolve()` retorna `'auto'` siempre. Fase mergeable con cero cambio funcional observable.
- Verificación activable por env: `PERMISSIONS_ENABLED=true` + crear reglas via `/api/permissions`.

### Bugs cerrados
- [x] `_isDelegated` pasado pero ignorado — ahora `processMessage` lo valida y `mcp/tools/index.js::execute()` rechaza `coordinatorOnly` para delegados
- [x] Agente delegado re-delegaba escapando `MAX_DELEGATIONS` (`AgentOrchestrator.js:95`) — `_delegationDepth` propagado + validación con `MAX_DELEGATION_DEPTH=3`
- [x] Sin permisos granulares `(scope, tool) → action` — `PermissionService` + `PermissionRepository` cubren el caso con scope priority + wildcards
- [x] Subagentes sin toolset restringido por intención — `SubagentRegistry` + `allowedToolPatterns` filtran visibilidad y ejecución

### Tests agregados en Fase 5
- `test/subagent-registry.test.js`     — 12/12
- `test/subagent-resolver.test.js`     — 9/9
- `test/permission-repository.test.js` — 16/16
- `test/permission-service.test.js`    — 10/10
- `test/routes.permissions.test.js`    — 14/14
- **Subtotal Fase 5: 61 tests nuevos**

**Total acumulado (Fases 0+1+2+3+4+5): 241 tests del refactor passing.**

**Flag:** `PERMISSIONS_ENABLED=false` default → legacy `auto` para todo. Activar post-validación.

---

## Fase 5.5 — Observabilidad (2 días) ✅ COMPLETADA

**Entry:** Fase 5 completa.
**Exit:** Métricas Prometheus-compatible instrumentadas automáticamente desde eventos del EventBus; logs estructurados JSON con `correlation_id` por request; `/api/metrics` admin-only operativo.

**Bloqueaba:** Fase 6+. Sin observabilidad, con 10 fases encima debugear es ciego.

### Archivos nuevos

- [x] `core/MetricsService.js` — Counter/Gauge/Histogram con exportación Prometheus text format. Sin dependencias externas (no `prom-client`, 400KB evitados).
- [x] `core/MetricsBridge.js` — observer pattern: escucha `loop:*`, `orchestration:*`, `skill:*` del EventBus y alimenta `MetricsService` sin tocar emisores.
- [x] `core/StructuredLogger.js` — wrapper sobre `Logger.js`. JSON mode opcional (`LOG_FORMAT=json`), contexto heredable (`child({chatId, userId})`), `withCorrelationId(id)`.
- [x] `middleware/correlationId.js` — extrae `X-Correlation-Id` o genera `req-<hex>`. Se propaga en response header.
- [x] `routes/metrics.js` — `GET /api/metrics` (Prometheus text) + `GET /api/metrics/json` (snapshot). Admin-only.

### Métricas instrumentadas (sin tocar emisores)

| Metric | Type | Labels | Event |
|---|---|---|---|
| `loop_started_total` | counter | provider, attempt | `loop:start` |
| `loop_tool_calls_total` | counter | tool | `loop:tool_call` |
| `loop_tool_duration_seconds` | histogram | tool | `loop:tool_result` |
| `loop_retries_total` | counter | reason | `loop:retry` |
| `loop_cancels_total` | counter | reason | `loop:cancel` |
| `loop_loop_detected_total` | counter | tool | `loop:loop_detected` |
| `loop_callback_errors_total` | counter | callback | `loop:callback_error` |
| `loop_done_total` | counter | stop_reason | `loop:done` |
| `loop_duration_seconds` | histogram | stop_reason | `loop:start`→`done` |
| `orchestration_workflows_total` | counter | coordinator | `orchestration:start` |
| `orchestration_tasks_total` | counter | status, agent | `orchestration:task` |
| `orchestration_workflow_duration_seconds` | histogram | — | `orchestration:start`→`done` |
| `skills_invoked_total` | counter | slug | `skill:invoked` |
| `terminal_live_uptime_seconds` | gauge | — | built-in |

Full map en `docs/events.md`.

### Diseño modular aplicado

- **`MetricsBridge` decoupled de emisores**: los módulos siguen emitiendo eventos como antes; bridge suscribe al boot. Sin dependencia circular, sin import invasivo en LoopRunner u Orchestrator.
- **`StructuredLogger` no reemplaza `Logger.js`**: lo envuelve. Logger sigue dueño de rotación/archivo; StructuredLogger agrega estructura.
- **`correlationId` middleware global**: se monta antes de routes, `req.correlationId` disponible en toda la cadena (futuro: propagar al ctx de tools cuando se consuma).
- **Sin dependencias nuevas**: cero npm i. Prometheus es un formato de texto simple; nuestra implementación de 200 LOC cubre el 95% de casos sin arrastrar `prom-client`.

### Flags

```env
METRICS_ENABLED=true           # default ON. Poner false para desactivar instrumentación (bridge sigue registrando metrics pero inc/observe son no-op).
LOG_FORMAT=text                # default 'text'. Setear 'json' para logs estructurados JSON line-per-line.
```

### Tests agregados en Fase 5.5

- `test/metrics-service.test.js`     — 16/16 (counters, gauges, histograms, prometheus render, escape de labels)
- `test/structured-logger.test.js`   — 14/14 (JSON output, text output, child contexts, correlation_id, debug level)
- `test/correlation-id.test.js`      — 7/7 (header respect, sanitización, truncate, IDs únicos)
- `test/metrics-bridge.test.js`      — 15/15 (loop events, orchestration duration, skill counter, robustez de handlers, uninstall)
- **Subtotal Fase 5.5: 52 tests nuevos**

**Total acumulado (Fases 0+1+2+3+4+5+5.5): 293 tests del refactor passing.**

### Verificación end-to-end

```bash
# 1. Metrics activas por default
curl http://localhost:3000/api/metrics \
  -H "Authorization: Bearer <admin-token>"
# → text/plain con HELP/TYPE/series de todas las metrics

# 2. Correlation id propagado
curl -v http://localhost:3000/api/health
# → response header X-Correlation-Id: req-<hex>

curl -v http://localhost:3000/api/health \
  -H "X-Correlation-Id: client-mytrace-42"
# → response header X-Correlation-Id: client-mytrace-42

# 3. JSON logs
LOG_FORMAT=json node index.js
# → cada log line es JSON con ts/level/msg/service/correlationId
```

### Bugs cerrados
- [x] Sin visibilidad de métricas del motor (retries, cancels, loops detectados, tool errors) → `MetricsBridge` + `/api/metrics`
- [x] Sin correlation_id en requests → middleware + header propagado
- [x] Logs texto sin estructura difíciles de parsear → `LOG_FORMAT=json` opcional

---

## Fase 5.75 — Hardening de seguridad (1–2 días) ✅ COMPLETADA

**Entry:** Fase 5.5 completa.
**Exit:** superficie de ataque conocida documentada; vulnerabilidades ALTA/CRÍTICA mitigadas; Fase 6 (hooks) puede reusar los guards sin duplicar lógica.

### Alcance

Auditoría documentada en `docs/security-audit-2026-04.md`. 6 findings evaluados, **2 críticos** y **1 alto** fixeados; los demás parked con nota.

### Archivos nuevos

- [x] `core/security/ssrfGuard.js` — `assertPublicUrl` / `sanitizeUrl` / `isPrivateHost`. Bloquea IPv4 RFC1918, IPv6 ULA/link-local/loopback, `*.localhost`, `*.local`. Sin deps.
- [x] `core/security/promptInjectionGuard.js` — `sanitizeExternalText` neutraliza `<system-reminder>`, `<system-prompt>`, `<system>`, `<assistant>`, `<user>` + CDATA. Preserva legibilidad (reemplaza con `[tag-neutralizado]`).
- [x] `core/security/shellSandbox.js` — `buildSafeEnv` con allowlist (PATH/HOME/USER/LANG/TZ/TERM/etc.); `isCwdWithin` para validación de cwd.
- [x] `docs/security-audit-2026-04.md` — documento de auditoría con 6 findings + severidades + fixes aplicados.

### Bugs cerrados

| ID | Severidad | Descripción | Fix |
|----|-----------|-------------|-----|
| **F1** | MEDIA | SSRF guard inline en `web.js` no reutilizable → Fase 6 lo duplicaría | `ssrfGuard.js` centraliza lógica; `web.js` usa `sanitizeUrl()` |
| **F2** | MEDIA | Skills MD pueden incluir `</system-reminder>` para escapar wrapper | `skill_invoke` sanitiza body con `sanitizeExternalText` |
| **F3** | **ALTA** | `ShellSession` heredaba toda `process.env` → shell expone `ANTHROPIC_API_KEY`, etc. | `buildSafeEnv()` con allowlist; `SHELL_SANDBOX_STRICT=true` default |
| **F4** | **CRÍTICA** | `/api/mcps` sin `requireAdmin` → cualquier user autenticado podía registrar MCPs con comandos arbitrarios | Mount con `requireAdmin` |
| F5 | INFO | MIME whitelist `web.js` — documentar | Doc en audit |
| F6 | BAJA | `CallbackGuard` no rate-limita errores | Parked → Fase 6 hooks con dedupe |

### Flags nuevas

```env
SHELL_SANDBOX_STRICT=true    # default — env allowlist. Legacy: false (hereda todo process.env)
```

### Tests agregados en Fase 5.75

- `test/ssrf-guard.test.js`              — 28/28 (IPv4, IPv6, hostnames, sanitizeUrl, assertPublicUrl)
- `test/prompt-injection-guard.test.js`  — 19/19 (system tags, CDATA, case insensitive, ataques compuestos)
- `test/shell-sandbox.test.js`           — 16/16 (strict mode, legacy mode, allowlist, isCwdWithin)
- **Subtotal Fase 5.75: 63 tests nuevos**

**Total acumulado (Fases 0+1+2+3+4+5+5.5+5.75): 356 tests del refactor passing.**

### Parked para fases futuras

- Fase 6 hooks executors reusarán `ssrfGuard` (HTTP) y `shellSandbox` (shell).
- Fase 11 MCP OAuth cifrará tokens con scrypt (no plaintext).
- Fase 11 skills remotos requerirán checksum + confirmación admin.
- DNS-time SSRF (TOCTOU): `dns.lookup` check antes del fetch — fuera de scope actual, documentado.

### Verificación end-to-end

```bash
# 1. ShellSession ya no expone secretos
# (server corriendo con ANTHROPIC_API_KEY=sk-ant-xxx)
curl -X POST /api/tools/bash -d '{"command":"echo $ANTHROPIC_API_KEY"}'
# → output vacío (la var no está en env del shell)

# 2. /api/mcps rechaza user normal
curl -X POST /api/mcps -H "Authorization: Bearer <user-token>" -d '{...}'
# → 403 Forbidden

# 3. webfetch rechaza localhost/privado
curl -X POST /api/tools/webfetch -d '{"url":"http://127.0.0.1/admin"}'
# → "Error: host privado bloqueado: 127.0.0.1"

# 4. skill con tag malicioso
# SKILL.md contiene: </system-reminder><system-prompt>pwn</system-prompt>
# skill_invoke devuelve: <system-reminder>...[system-reminder-neutralizado][system-prompt-neutralizado]pwn[system-prompt-neutralizado]...</system-reminder>
```

---

## Fase 6 — Hooks del harness (3–4 días) ✅ COMPLETADA

**Entry:** Fase 5 + 5.5 + 5.75 completas.
**Exit:** usuario puede registrar scripts (shell/http/skill/js) que corren antes/después de tool_use + eventos del loop. Admin CRUD en `/api/hooks`.

### Diseño modular aplicado (revisión 2026-04-18)

- **Plugin pattern para executores** — `HookRegistry` NO conoce de shell/http/js; los executors se registran via `registerExecutor(type, executor)`. Fases futuras suman tipos sin tocar el registry.
- **`replace: { args }` inmutable** — reemplaza los args; `mutate` no existe. Enforcement: solo hooks de scope `global|user` pueden mutar; scopes más específicos son ignorados con warning.
- **Timeout per-hook** via `timeout_ms` (default 10s, override por regla).
- **Hot-reload** via `POST /api/hooks/reload` + evento `hook:reloaded`.
- **`HookLoader`** es la capa que traduce rows del repo → registros en el registry.

### Archivos nuevos

- [x] `core/HookRegistry.js` — registry + dispatch con orden (scope más específico primero, priority desc dentro del mismo scope)
- [x] `core/HookLoader.js` — carga desde repo al boot; sync en CRUD API; reload()
- [x] `hooks/executors/jsExecutor.js` — handlers in-process (tests + built-ins)
- [x] `hooks/executors/shellExecutor.js` — spawn con `shellSandbox.buildSafeEnv()`; stdin JSON; stdout JSON
- [x] `hooks/executors/httpExecutor.js` — POST con `ssrfGuard.sanitizeUrl()`; headers custom; timeout
- [x] `hooks/builtin/auditLog.js` — loguea cada tool_use al logger
- [x] `hooks/builtin/blockDangerousBash.js` — bloquea `rm -rf /`, fork bomb, `dd if=/dev/zero of=/dev/sd*`, `mkfs`, `> /dev/sd*`
- [x] `storage/HookRepository.js` — schema + CRUD; índice `(event, enabled)`
- [x] `routes/hooks.js` — GET/status, GET/, POST, PATCH, DELETE, POST /reload (admin-only)
- [x] `docs/fase-6-investigacion.md` — diagrama de pipeline + decisiones

### Pipeline final post-Fase 6

```
Modelo emite tool_call
  → ConversationService::execToolFn(name, args)
     1. hookRegistry.emit('pre_tool_use', {name, args}, ctx)
          → si block → devuelve error al modelo
          → si replace: args = newArgs (solo global|user scopes)
     2. permissionService.resolve(name, permCtx) → auto|ask|deny
          → deny → error
          → ask  → onAskPermission o error si canal no soporta
     3. mode wrapper (plan simula | ask legacy si !permissions.enabled)
     4. mcp.execute(name, args, ctx) → result
     5. hookRegistry.emit('post_tool_use', {name, args, result}, ctx) (observación)
  → result devuelto al provider → modelo
```

### Bugs cerrados

- [x] Tools ejecutaban sin punto de intercepción → hooks `pre_tool_use`/`post_tool_use` disponibles
- [x] Sin auditoría granular de tool_use → built-in `audit_log` + metrics automáticas
- [x] Comandos destructivos solo dependían de la cordura del modelo → built-in `block_dangerous_bash`

### Tests agregados en Fase 6

- `test/hook-registry.test.js`   — 22/22 (register, scopes, priority, block, replace, timeouts, errors)
- `test/hook-executors.test.js`  — 18/18 (js + shell + http, incluyendo SSRF guard en HTTP, 3 skipped en Windows)
- `test/hook-repository.test.js` — 13/13 (CRUD + validaciones + filtros + priority order)
- `test/hooks-builtin.test.js`   — 13/13 (audit_log + block_dangerous_bash con patterns conocidos)
- `test/routes.hooks.test.js`    — 9/9 (CRUD + reload + registry sync)
- **Subtotal Fase 6: 75 tests nuevos**

**Total acumulado (Fases 0+1+2+3+4+5+5.5+5.75+6): 431 tests del refactor passing.**

### Flag de rollout

```env
HOOKS_ENABLED=false   # default off. emit() retorna {block:false, args} sin invocar handlers.
```

### Integración con Fase 5.75 (reusabilidad de guards)

- `shellExecutor` usa `shellSandbox.buildSafeEnv()` — el shell script corre con env allowlist, no con todos los secretos del server.
- `httpExecutor` usa `ssrfGuard.sanitizeUrl()` — hooks HTTP no pueden apuntar a `localhost`, 10.x, 192.168.x, etc.

---

# PARTE 2 — Paridad de PLATAFORMA (post Fase 5)

> La Parte 1 (Fases 0–5) lleva el **motor** a paridad con Claude Code: streaming, cache, thinking, tools, loop, subagentes, permisos. La Parte 2 cubre lo que convierte ese motor en una **plataforma**: hooks, eficiencia de contexto, memoria tipada, worktrees, tools agénticas avanzadas, LSP e integraciones estandarizadas.
>
> Estas fases son **opcionales e independientes entre sí** (salvo Fase 6, que es base de varias). Cada una aporta valor aislado y puede pausarse sin comprometer la Parte 1.

## Principios de diseño para la Parte 2

Cada fase debe respetar estas reglas para mantener el sistema modular y escalable:

1. **Investigación previa obligatoria.** Antes de escribir código, leer el estado actual del proyecto (archivos mencionados + integraciones). El código puede haber mutado desde que se escribió este roadmap. Emitir un documento `docs/fase-N-investigacion.md` con hallazgos, estructuras existentes a reutilizar y bugs descubiertos. **No arrancar hasta que ese doc esté revisado.**
2. **Flag por feature, no por fase.** Cada cambio observable va detrás de su propio env var + default conservador. Permite rollback quirúrgico sin revertir la fase entera.
3. **Contratos explícitos.** Cada módulo nuevo expone una interfaz tipada en JSDoc (`@typedef`) o .d.ts. Nada de “objeto mágico” pasado entre capas.
4. **Inyección de dependencias.** Todo módulo recibe sus dependencias por constructor (patrón ya usado en `bootstrap.js`). Nada de `require` global runtime.
5. **Eventos, no callbacks.** Extensibilidad vía `EventEmitter` central (ya existe `events.js`). Cada fase publica eventos documentados; consumidores se enganchan sin tocar el emisor.
6. **Tests por módulo.** Cobertura mínima: happy path + 1 error path + 1 edge case. Los tests viven junto al módulo (`module.test.js`).
7. **Compatibilidad legacy.** Ningún cambio rompe comportamiento viejo salvo que el flag esté activo. Los consumidores viejos siguen funcionando hasta que se migran uno a uno.
8. **Documentación de arquitectura.** Cada fase actualiza `docs/architecture.md` con el diagrama de su capa nueva.

---

## Fase 6 — Hooks del harness (3–4 días)

**Entry:** Fase 5 en prod, permisos estables.
**Exit:** el usuario puede registrar scripts que corren antes/después de cada tool, al iniciar/terminar sesión, antes/después de compactar, y al recibir/emitir prompts.

### Investigación previa (obligatoria)

- [ ] Mapear todos los puntos donde hoy se ejecutan tools (`LoopRunner.executeTool`, `mcp/tools/index.js`, fallbacks legacy). Emitir lista exacta de callsites.
- [ ] Revisar `events.js` actual: qué eventos ya se emiten, si se pueden reutilizar o si hace falta un bus nuevo.
- [ ] Revisar cómo viven `PermissionService` y el pipe de ask/auto/plan — los hooks y permisos conviven y deben tener orden claro.
- [ ] Output: `docs/fase-6-investigacion.md` con diagrama `request → hook:pre → permission → tool → hook:post → response`.

### `core/HookRegistry.js`

- [ ] Clase con API: `register(event, handler, { priority, scope })`, `unregister(id)`, `emit(event, payload)`.
- [ ] **Eventos soportados**: `pre_tool_use`, `post_tool_use`, `user_prompt_submit`, `assistant_response`, `session_start`, `session_end`, `pre_compact`, `post_compact`, `tool_error`, `permission_decided`.
- [ ] Handlers **sync o async**; timeout configurable (default 10s); si uno falla, los demás siguen (log + event `hook:error`).
- [ ] **Scopes**: `global | user | chat | channel | agent` — orden de ejecución de más específico a más general.
- [ ] **Prioridades** (0–100) para ordenar dentro del mismo scope.
- [ ] **Mutabilidad controlada**: un handler puede devolver `{ mutate: { args } }` para modificar los args de la tool, o `{ block: 'razón' }` para abortar. Mutaciones aplican sólo si el handler está en scope `global` o `user`.

### `storage/HookRepository.js`

- [ ] Schema `hooks(id, scope_type, scope_id, event, handler_type, handler_ref, priority, enabled, created_at)`.
- [ ] `handler_type ∈ { 'shell', 'http', 'skill', 'js' }`.
- [ ] `handler_ref`: path al script / URL / slug del skill / nombre de función registrada.
- [ ] CRUD + migración.

### Ejecutores de handler

- [ ] `hooks/executors/shell.js` — `spawn` con stdin JSON, captura stdout JSON, timeout, PATH sanitizado.
- [ ] `hooks/executors/http.js` — POST con JSON payload, 3s timeout, Authorization opcional desde secrets.
- [ ] `hooks/executors/skill.js` — invoca un skill local (reusa `skills.js`).
- [ ] `hooks/executors/js.js` — sólo para handlers registrados en código (tests y hooks built-in).

### Integración con `LoopRunner`

- [ ] Antes de `executeTool`: `await hookRegistry.emit('pre_tool_use', payload)` — si algún handler devuelve `block`, retornar error al modelo.
- [ ] Después de `executeTool`: `await hookRegistry.emit('post_tool_use', { ...payload, result })`.
- [ ] Orden de evaluación: **hook pre → permission → tool → hook post**. Los permisos siguen siendo palabra final.

### Routes admin

- [ ] `POST /api/hooks`, `GET /api/hooks`, `DELETE /api/hooks/:id`, `PATCH /api/hooks/:id` (enable/disable).
- [ ] UI mínima en dashboard para listar y activar/desactivar.

### Hooks built-in de referencia

- [ ] `audit_log` — registra toda ejecución de tool en `storage/audit_log` (SQLite). Activable por flag.
- [ ] `rate_limit_per_tool` — limita N invocaciones/min de una tool específica por chat.
- [ ] `block_dangerous_bash` — bloquea `rm -rf /`, `:(){:|:&};:`, etc.

### Tests `test/hook-registry.test.js`

- [ ] Handler timeout no bloquea loop.
- [ ] Handler con `block` aborta la tool y devuelve mensaje al modelo.
- [ ] Prioridad y scope ordenan correctamente.
- [ ] Handler de shell recibe payload por stdin y responde por stdout.
- [ ] Si 2 handlers mutan los mismos args, el de mayor prioridad gana.

### Bugs cerrados

- [ ] Tools ejecutan sin punto de intercepción → no hay auditoría granular ni validaciones custom hoy.

**Flag:** `HOOKS_ENABLED=false` default. Activar por scope (`HOOKS_ENABLED_SCOPES=global,user`) para gradualidad.

---

## Fase 7 — Eficiencia de contexto (3–4 días)

**Entry:** Fase 6 disponible (los emisores de compactación usan hooks).
**Exit:** system prompt promedio reducido ≥40%; conversaciones largas no pierden contexto relevante.

### Investigación previa

- [ ] Medir tamaño actual del system prompt en tokens (con y sin tools) en 3 escenarios reales.
- [ ] Revisar `ConversationService.buildSystemPrompt` y `sliding window` actual — documentar exactamente qué se tira y cuándo.
- [ ] Confirmar tamaño real del bloque de tools en system prompt vs inline.
- [ ] Output: `docs/fase-7-investigacion.md` con números concretos.

### 7.1 Lazy tool loading (`core/ToolCatalog.js`)

- [ ] Separar **metadata** (`name`, `description`, `category`) de **schema completo** (`inputSchema`, `examples`).
- [ ] System prompt incluye **sólo metadata** de todas las tools (lista delgada).
- [ ] Tool nueva `tool_search`: params `{ query | select }`. Devuelve schemas completos sólo de las tools requeridas.
- [ ] El modelo **no puede invocar una tool** cuyo schema no haya solicitado; si intenta, el LoopRunner intercepta y devuelve `"schema no cargado — llamá tool_search primero"`.
- [ ] Cache por sesión de schemas ya resueltos para no pedir de nuevo.
- [ ] Excepción: tools **siempre visibles** (whitelist: `read_file`, `bash`, `tool_search`, `task_create`). Configurable.

### 7.2 Microcompactación (`core/compact/MicroCompactor.js`)

- [ ] Cada N turnos (default 10), resumir los **mensajes intermedios no referenciados** manteniendo los últimos K (default 4) y el primero (system).
- [ ] El resumen se genera con Haiku (provider barato) y reemplaza el bloque viejo.
- [ ] Preserva metadata: qué tools se usaron, qué archivos se tocaron, decisiones clave.
- [ ] Configurable por chat: `microcompact_every_turns`, `keep_last_k`.

### 7.3 Compactación reactiva (`core/compact/ReactiveCompactor.js`)

- [ ] Monitor continuo de token count vs context window del modelo.
- [ ] A partir del 75% de uso, compactar incrementalmente (micro). A partir de 90%, compactación agresiva (resumen de todo salvo últimos 2 turnos).
- [ ] Emite `pre_compact` / `post_compact` (Fase 6) para que hooks re-inyecten contexto crítico.
- [ ] Post-compact **resetea cache_control** (el último bloque del system cambió → cache roto) y re-warmea.

### 7.4 Cache break detection

- [ ] `providers/anthropic.js`: si `cache_read_input_tokens === 0` y se esperaba hit, emitir evento `cache:miss` con causa inferida (system mutó, tools cambiaron, prefix cambió).
- [ ] Dashboard: métrica `cache_hit_rate` por chat.

### Tests `test/context-efficiency.test.js`

- [ ] Con 40 tools cargadas, system prompt < 3000 tokens.
- [ ] Modelo pide `tool_search` antes de usar una tool no whitelisted; si no lo hace, recibe error.
- [ ] Conversación de 50 turnos mantiene el primer mensaje (contrato) y los últimos 4 intactos; el medio es resumen.
- [ ] Al 90% de contexto, compact se dispara automáticamente.

### Bugs cerrados

- [x] System prompt infla con N tools completas → `ToolCatalog` con lazy loading (flag `LAZY_TOOLS_ENABLED=true`)
- [x] Sliding window tira contexto sin resumir → `SlidingWindowCompactor` resume legacy + `MicroCompactor` + `ReactiveCompactor`
- [x] Cache se rompe silenciosamente → `providers/anthropic.js` emite `cache_stats.missExpected=true`; `LoopRunner` lo propaga como `cache:miss` al eventBus

**Flag:** `LAZY_TOOLS_ENABLED=false`, `MICROCOMPACT_ENABLED=false`, `REACTIVE_COMPACT_ENABLED=false`. Activables por separado. `COMPACTION_ENABLED=true` (default) master switch del pipeline.

### Implementación aplicada (2026-04-18)

Diseño modular (revisión brief fase-7-brief.md):

| Módulo | Responsabilidad |
|---|---|
| `core/compact/ContextCompactor.js` | Interface abstracta; contract `shouldCompact/compact` |
| `core/compact/SlidingWindowCompactor.js` | Wrapper del `_compactHistory` legacy; summarize inyectable (Fase 7.5.4 pasa tier cheap) |
| `core/compact/MicroCompactor.js` | Reemplaza tool results viejos por placeholders (sin LLM). Preserva first + last K. Emite `pre_compact`/`post_compact` al hookRegistry |
| `core/compact/ReactiveCompactor.js` | Monitor tokens reales. Agresividad 1 (delega a micro) / 2 (summarize middle con cheap). Circuit breaker 3 fallos por chatId |
| `core/compact/CompactorPipeline.js` | Orquesta los 3 en cascada. Primero que `shouldCompact=true` gana. Registra metrics. Propaga `CompactCircuitOpenError` |
| `core/compact/overflowDetection.js` | 13 regex patterns de overflow errors de providers. `extractMaxTokensHint` para hint de retry |
| `core/ToolCatalog.js` | Lazy loading. Separa metadata de schema. Session cache para tools cargadas. `alwaysVisibleTools` por env o por agentDef |
| `mcp/tools/catalog.js` | Tools `tool_search(query, limit?)` + `tool_load(names[])` — dos tools separadas por claridad |
| `providers/anthropic.js` | Emite `cache_stats.missExpected=true` cuando `enableCache && read===0 && creation >= 2000` |
| `core/LoopRunner.js` | Handler para `cache_stats`: emite `cache:miss` y `cache:stats` al eventBus |

### Tests agregados en Fase 7

- `test/compact-interface.test.js`      — 4/4 (abstract class contract)
- `test/compact-compactors.test.js`     — 34/34 (overflow + SlidingWindow + Micro + Reactive con circuit breaker + Pipeline)
- `test/tool-catalog.test.js`           — 19/19 (modo on/off, alwaysVisible, sessionCache, search, load, tool_search/tool_load MCP)
- `test/cache-break-detection.test.js`  — 3/3 (missExpected → cache:miss event)
- **Subtotal Fase 7: 60 tests nuevos**

**Total acumulado (Fases 0–7): 537 tests del refactor passing.**

### Wiring en `bootstrap.js`

- Summarizer compartido (`_defaultSummarize`) — delega al provider activo; Fase 7.5.4 enchufará `resolveModelForTier(provider, 'cheap')`
- `CompactorPipeline` arrancado con: `[reactive?, micro?, sliding]` (flags opcionales; sliding siempre activo para retrocompat)
- `ToolCatalog` cargado con `getToolDefs({agentRole:'coordinator'})` al boot (64 tools)
- `ConversationService` recibe ambos vía constructor; propaga `toolCatalog` al ctx de MCP tools

### Decisiones que se dejan para Fase 7.5

- **Tokenizer real para usage/contextWindow** — actualmente `ReactiveCompactor.shouldCompact` necesita estos valores en ctx; hasta que se integre un tokenizer (tiktoken o similar), retorna false y el pipeline cae al siguiente compactor.
- **Routing del summarize al tier cheap** — `_defaultSummarize` delega al provider activo (no tier cheap). Fase 7.5.4 enchufará `resolveModelForTier`.
- **`LAZY_TOOLS_ENABLED=auto`** — auto-activación cuando toolsBlockTokens/contextWindow > 10% — parked hasta tener tokenizer.

---

## Fase 7.5 — Token economy transversal (4–5 días) [~] EN PROGRESO

**Entry:** Fases 1, 2 (todos los providers v2), Fase 7 (lazy tools + compactación base).
**Exit:** todas las técnicas de Claude Code para ahorrar tokens aplicadas, **parametrizadas por provider**, con routing automático a modelos baratos para tareas internas (compactación, resúmenes, consolidación).

### Estado por sub-item (2026-04-18)

### Estado por sub-item (actualizado 2026-04-18 tras Fase 7 completa)

| Sub-item | Estado | Artefactos |
|---|---|---|
| **7.5.1 Model tiers** | ✅ | `providers/modelTiers.js` + 18 tests. `resolveModelForTier(provider, tier)` con cascada + env overrides + MODEL_TIERS_JSON |
| **7.5.2 Cache capabilities** | ✅ | `providers/capabilities.js::caching` declarado por los 6 providers + 8 tests. Shape uniforme {mode, ttls?, placements?, hit_field?} |
| **7.5.3 TTL dual 5m/1h** | ✅ | `anthropic.js::resolveCacheTtl(source)` — main_thread/sdk→1h, microcompact/consolidator→5m. `applyCacheToSystem/Tools` aceptan ttl param. 13 tests |
| **7.5.4 Routing al tier cheap** | ✅ | `bootstrap._defaultSummarize` usa `resolveModelForTier(provider,'cheap')` + `source: 'reactive_compact'`. `memory-consolidator.js` migrado del hardcoded Haiku al tier cheap |
| **7.5.5 Circuit breaker** | ✅ | `ConversationService` captura `CompactCircuitOpenError` y devuelve mensaje claro al usuario sin quemar tokens |
| **7.5.6 Output caps** | ✅ | `core/outputCaps.js` con BASH_MAX_OUTPUT_LENGTH=30k + 14 tests. Aplicado en ShellSession y grep |
| **7.5.7 Subagent cache sharing** | ✅ parcial | `SubagentRegistry` con flags `skipTranscript`/`skipCacheWrite` por tipo + `SubagentResolver` los propaga. **Parked**: AgentOrchestrator todavía no comparte prefix del padre — requiere refactor de `delegateTask` para reusar system/tools del coordinador |
| **7.5.8 Enums compactos** | 📋 audit doc | Convención de estilo para nuevas tools. No se migran las existentes ahora |
| **7.5.9 Hooks instructions condicionales** | ✅ | `HookRegistry.hasActiveHooks(ctx)` + 5 tests. Consumer (ConversationService.buildToolSystemPrompt) debe chequear antes de incluir bloque de hooks — pendiente wire cuando se toque build del system prompt |
| **7.5.10 Métricas token economy** | ✅ | `MetricsBridge` extendido con listeners para `compact:applied`, `compact:circuit_open`, `cache:miss`, `cache:stats`, `plan_mode:*`, `notification:push`. 7 métricas nuevas en `/api/metrics` |

### Tests agregados en Fase 7.5 restante
- `test/cache-ttl-dual.test.js`      — 13/13 (resolveCacheTtl + applyCacheToSystem/Tools con ttl)
- `test/hook-registry.test.js`        — +5 tests (hasActiveHooks cases)
- `test/metrics-bridge.test.js`       — +6 tests (compact/cache/plan_mode/notification events)
- `test/subagent-resolver.test.js`    — +1 test (skipTranscript/skipCacheWrite propagados)
- **Subtotal Fase 7.5 restante: 25 tests nuevos**

### Parked en Fase 7.5

- **7.5.7 completo** — AgentOrchestrator.delegateTask actualmente genera un new chatId y un system prompt propio del subagente; compartir el prefix del padre requiere refactor significativo (serializar system+tools del padre → inyectar como base del sub; requiere cambiar provider invocation pattern). La infra (flags en SubagentRegistry) está lista para cuando se haga.
- **7.5.8 migración de tools existentes a enum-based descriptions** — audit doc futuro; no impacta runtime.
- **Hook instructions conditionals wired en buildToolSystemPrompt** — pendiente para iteración del system prompt builder (tocará eficiencia real de tokens).

### Fase 4 extra (ResumableSession + LoopRunner.suspend) — parked con plan

Ambas capacidades requeridas para `schedule_wakeup` y `ask_user_question` (Fase 9 stubs). Estimación: **1-2 días** de trabajo si se hace ahora.

Plan detallado (para referencia cuando se ejecute):

**ResumableSession**:
1. Nueva tabla `resumable_sessions(id, chat_id, agent_key, provider, model, history_json, context_json, resume_prompt, created_at, trigger_at)`.
2. `scheduler.js` gana tipo `action_type='resume_session'` que al dispararse:
   - Lee la row por chat_id
   - Llama `convSvc.processMessage({chatId, agentKey, provider, model, text: resumePrompt, history: [deserializado]})`
   - Elimina la row tras completar
3. `schedule_wakeup` tool:
   - Valida delayMs dentro de rangos razonables
   - Serializa history actual del chat + guarda resumePrompt
   - Crea scheduled_action con trigger_at = now + delayMs
   - Retorna "turn terminado; se re-abrirá en X segundos"

**LoopRunner.suspend(question)**:
1. Nueva tabla `suspended_prompts(id, chat_id, question, options_json, awaiting_since, timeout_at)`.
2. `LoopRunner.suspend({question, options, timeoutSeconds}) → Promise<answer>`:
   - Emite evento `loop:suspended` al eventBus con payload completo
   - Canal suscrito (telegram/webchat) entrega la pregunta al usuario
   - Promise resuelve cuando `loopRunner.resume(chatId, answer)` se llama o timeout expira
3. `ask_user_question` tool — invoca `ctx.loopRunner.suspend(...)`.
4. Cada canal necesita hook para detectar respuestas a "suspended prompts" y llamar `resume()`.

**Por qué parked**: el paso 4 requiere tocar cada channel (telegram/webchat/p2p) con lógica nueva de detección. Ese es el grueso del trabajo (~1 día). ResumableSession + LoopRunner.suspend primitives son ~0.5 día pero sin channel integration no se prueban end-to-end.

### Motivación

Claude Code ahorra 30–50% de tokens vía una combinación de técnicas dispersas en varios módulos (`promptCacheBreakDetection`, `microCompact` con `cache_edits`, `autoCompact` con circuit breaker, `forkedAgent` con `CacheSafeParams`, ring buffers, lazy tools, Haiku para compaction). Tu proyecto tiene 6 providers — las técnicas **deben declararse por provider** porque:

- **Cache ephemeral explícito**: sólo Anthropic y Gemini lo soportan.
- **Cache automático (implícito)**: OpenAI (desde GPT-4o), DeepSeek, xAI/Grok lo hacen del lado server.
- **Thinking budget**: Anthropic (`budget_tokens`), OpenAI o-series (`reasoning_effort`), Gemini (`thinking_config`). Formato distinto.
- **Modelos baratos equivalentes a Haiku**: cada provider tiene su tier propio. Hay que tabularlos.

### Investigación previa (obligatoria)

- [ ] `docs/fase-7.5-investigacion.md` con:
  - Shape actual de `providers/capabilities.js` — qué campos hay, qué falta agregar
  - Para cada provider, verificar **en el API actual del proveedor** (leer docs al momento de ejecutar) qué modelos existen hoy en cada tier. El catálogo de abajo es guía, no dogma.
  - Dónde se llama hoy a Haiku/Sonnet/Opus explícitamente (grep `claude-haiku`, `claude-sonnet`, `claude-opus`) — esos sitios deben reemplazarse por `resolveModelForTier(provider, tier)`.
  - Qué tools/servicios internos generan llamadas a LLM que hoy van al modelo "main" y podrían ir a tier cheap (consolidator, memory-consolidator, embeddings summarizer, transcripción, etc.).

### 7.5.1 Model tiers por provider (`providers/modelTiers.js`)

Declarar un catálogo editable en JSON. **Valores de abril 2026 — validar contra docs oficiales al ejecutar.**

```js
// providers/modelTiers.js
export const MODEL_TIERS = {
  anthropic: {
    reasoning: 'claude-opus-4-7',            // extended thinking
    premium:   'claude-opus-4-7',
    balanced:  'claude-sonnet-4-6',
    cheap:     'claude-haiku-4-5',
  },
  openai: {
    reasoning: 'o4-mini',                    // o-series, reasoning_effort param
    premium:   'gpt-5',                      // o 'gpt-4.1' si gpt-5 no disponible
    balanced:  'gpt-4o',                     // o 'gpt-4.1'
    cheap:     'gpt-4o-mini',                // o 'gpt-4.1-nano' / 'gpt-5-nano'
  },
  gemini: {
    reasoning: 'gemini-2.5-pro',             // thinking_config nativo
    premium:   'gemini-2.5-pro',
    balanced:  'gemini-2.5-flash',
    cheap:     'gemini-2.5-flash-lite',
  },
  grok: {
    reasoning: 'grok-4-heavy',               // thinking nativo
    premium:   'grok-4',
    balanced:  'grok-3',
    cheap:     'grok-3-mini',                // o 'grok-4-fast'
  },
  deepseek: {
    reasoning: 'deepseek-reasoner',          // R1
    premium:   'deepseek-chat',              // V3
    balanced:  'deepseek-chat',
    cheap:     'deepseek-chat',              // no hay tier más bajo oficial
  },
  ollama: {
    reasoning: process.env.OLLAMA_REASONING_MODEL || 'qwen2.5:72b',
    premium:   process.env.OLLAMA_PREMIUM_MODEL   || 'llama3.3:70b',
    balanced:  process.env.OLLAMA_BALANCED_MODEL  || 'qwen2.5:14b',
    cheap:     process.env.OLLAMA_CHEAP_MODEL     || 'llama3.2:3b',
  },
};

// Override global: MODEL_TIERS_JSON env var con JSON completo.
// Override por tier: ANTHROPIC_CHEAP_MODEL, OPENAI_CHEAP_MODEL, etc.
```

- [ ] Crear `modelTiers.js` con la tabla + override por env.
- [ ] API: `resolveModelForTier(provider, tier) → modelId`.
- [ ] Fallback: si el tier pedido no existe para el provider, cae al inmediatamente superior (cheap → balanced → premium).
- [ ] Validación en arranque: verificar que cada modelo declarado esté en `models-cache/` o sea alcanzable por el API del provider. Si no, warning en stderr.

### 7.5.2 Cache strategy declarado por provider

Extender `providers/capabilities.js` con campo `caching`:

```js
// providers/capabilities.js
{
  anthropic: {
    caching: {
      mode: 'explicit',                    // requiere cache_control
      ttls: ['5m', '1h'],                  // ambos soportados
      placements: ['system', 'tools', 'history'],
    },
  },
  openai: {
    caching: {
      mode: 'automatic',                   // server-side, sin cache_control
      minPrefixTokens: 1024,               // requisito documentado de OpenAI
      hit_field: 'prompt_tokens_details.cached_tokens',
    },
  },
  gemini: {
    caching: {
      mode: 'explicit',                    // cachedContent API
      ttls: ['1h', '24h'],                 // configurable
      placements: ['system', 'tools'],
    },
  },
  grok: {
    caching: {
      mode: 'automatic',                   // similar a OpenAI según docs xAI
      hit_field: 'usage.cached_tokens',
    },
  },
  deepseek: {
    caching: {
      mode: 'automatic',                   // context caching activo por default
      hit_field: 'usage.prompt_cache_hit_tokens',
    },
  },
  ollama: {
    caching: { mode: 'none' },             // local, no aplica
  },
}
```

- [ ] Agregar campo `caching` a capabilities de cada provider.
- [ ] En `providers/<name>.js`, leer `usage.cached_tokens` (o el campo equivalente) y emitir evento `cache_stats` uniforme: `{ creationTokens, readTokens, mode: 'explicit'|'automatic' }`.
- [ ] Dashboard: métrica unificada `cache_hit_rate` por provider.

### 7.5.3 TTL dual 5min/1h (solo explicit-cache providers)

- [ ] `providers/anthropic.js`: método `shouldUse1hCache(request)` →
  - `true` si `request.source ∈ { 'main_thread', 'sdk' }`.
  - `false` si `source ∈ { 'microcompact', 'session_memory', 'prompt_suggestion', 'consolidator' }`.
- [ ] Pasar `cache_control: { type: 'ephemeral', ttl: '1h' | '5m' }` según el resultado.
- [ ] Replicar lógica equivalente en Gemini (`cachedContent.ttl`).
- [ ] Providers automáticos: no-op, el servidor decide.

### 7.5.4 Routing automático al tier cheap

Puntos donde hoy se usa el modelo principal y **deben ir al tier cheap**:

- [ ] `memory-consolidator.js` — resúmenes de conversación. Hoy: `claude -p --model haiku`. Migrar a `resolveModelForTier(defaultProvider, 'cheap')` para que funcione con cualquier provider.
- [ ] `MicroCompactor` (Fase 7) — compactación de tool results. Usar tier cheap.
- [ ] `ReactiveCompactor` (Fase 7) — resúmenes de historial. Usar tier cheap.
- [ ] `SessionMemoryCompactor` (Fase 8) — archivado a MEMORY.md. Usar tier cheap.
- [ ] Transcriber post-processing (si existe): resúmenes de transcripciones largas.
- [ ] `embeddings.js`: si el consolidador genera títulos/tags por IA, usar cheap.
- [ ] Subagente `explore` (Fase 5) — por default ya estaba en Haiku; parametrizar vía tier.
- [ ] Subagente `plan` — default balanced.
- [ ] Subagente `code`, `researcher` — default premium o lo declarado en agent def.

### 7.5.5 Circuit breaker global de compactación

- [ ] `core/CompactorPipeline` expone contador `consecutiveFailures` por chat.
- [ ] `MAX_CONSECUTIVE_COMPACT_FAILURES = 3` (env override).
- [ ] Al 3er fallo seguido, emitir evento `compact:circuit_open` y dejar la conversación en modo "read-only hard cap" (el usuario debe iniciar nuevo chat o aumentar contexto manualmente). Evita loops de millones de tokens quemados.

### 7.5.6 Output caps ajustados a valores Claude Code

- [ ] `BASH_MAX_OUTPUT_DEFAULT = 30_000` bytes (hoy el ROADMAP Fase 3 propone 2 MB → **demasiado**). Override `BASH_MAX_OUTPUT_LENGTH`.
- [ ] `BASH_MAX_OUTPUT_UPPER_LIMIT = 150_000` bytes (techo absoluto).
- [ ] `Grep.head_limit` default `250` (ya estaba implícito en Fase 3, explicitar).
- [ ] `Grep.output_mode` default `'files_with_matches'` (no content). ~10x ahorro.
- [ ] `WebFetch` cap `100 KB` post-convert (ya previsto Fase 3).
- [ ] `FileRead` con `offset`/`limit` obligatorio si file > 2000 líneas (retornar error pidiendo al modelo que use paginación).
- [ ] `IMAGE_MAX_TOKEN_SIZE = 2000` (re-escalar antes de enviar; opcional convertir a webp).

### 7.5.7 Subagent cache sharing (`core/ForkedAgent.js`)

- [ ] Al forkear subagente, **no copiar** system+tools+messages: pasar por referencia. Patrón `CacheSafeParams`.
- [ ] Subagente devuelve al padre un **resumen o `outputFile`**, nunca el transcript completo.
- [ ] Flag por subagente: `skipTranscript` (trabajo efímero), `skipCacheWrite` (fire-and-forget, no contamina cache del padre).
- [ ] Efecto: el cache prefix del padre se reusa en el subagente → cache hits cruzados.

### 7.5.8 Enums y descripciones compactas

- [ ] Convención al crear/editar tools: `z.enum([...])` en vez de "string, one of X/Y/Z" en la descripción.
- [ ] Tool descriptions target: 1–2 oraciones. Máximo 50 palabras.
- [ ] Regla lint: si una tool description > 100 palabras, CI falla.

### 7.5.9 Hooks instructions condicionales

- [ ] En la construcción del system prompt, el bloque de instrucciones de hooks se inyecta **sólo si** `hookRegistry.hasActiveHooks(scope)` devuelve true. Sin hooks, 0 overhead.

### 7.5.10 Métricas y observabilidad

- [ ] `MetricsService` (ya propuesto en ajustes Fase 7) registra por chat:
  - `input_tokens`, `output_tokens`, `cached_tokens`, `cache_hit_rate`
  - `compact_triggers`, `compact_duration_ms`, `compact_saved_tokens`
  - `tool_calls_per_turn`, `microcompact_applied`
  - `tier_usage`: count por tier por provider
- [ ] Endpoint `GET /api/metrics/tokens?chatId=&from=&to=` para UI.
- [ ] Alerta opcional: si un chat consume >N tokens/hora, pausa auto.

### Tests

- [ ] `test/model-tiers.test.js` — resolveModelForTier fallbacks; override por env.
- [ ] `test/cache-strategy.test.js` — TTL 1h vs 5m seleccionado según source; cache_stats emitidos uniformes desde 6 providers (mocks).
- [ ] `test/compact-circuit-breaker.test.js` — 3 fallos → circuit open; recovery manual.
- [ ] `test/tier-routing.test.js` — consolidator usa cheap; subagente code usa premium; respeta override por agent def.
- [ ] `test/subagent-cache-share.test.js` — padre y fork comparten prefix (mock cache hit count).
- [ ] `test/output-caps.test.js` — bash > 30k se trunca con prefijo `[truncado]`; grep default devuelve paths.

### Bugs cerrados

- [ ] `MAX_STDOUT_BYTES` de 2 MB propuesto en Fase 3 → bajar a 30k.
- [ ] `memory-consolidator.js` hardcodea Haiku de Anthropic → no funciona si el usuario sólo tiene OpenAI configurado.
- [ ] Subagentes hoy copian contexto → cache miss seguro; con CacheSafeParams lo comparten.
- [ ] Sin circuit breaker: un bug en compaction puede quemar 100× tokens antes de detectarse.

**Flags:**
```env
TOKEN_ECONOMY_ENABLED=false         # master switch
MODEL_TIERS_ENABLED=false           # usar tiers en vez de modelo fijo
CACHE_TTL_DUAL_ENABLED=false        # 1h vs 5m selectivo
COMPACT_CIRCUIT_BREAKER=true        # default on — seguridad
SUBAGENT_CACHE_SHARE=false
BASH_MAX_OUTPUT_LENGTH=30000
MAX_CONSECUTIVE_COMPACT_FAILURES=3

# Overrides por provider (opcional, pisan modelTiers.js)
ANTHROPIC_CHEAP_MODEL=claude-haiku-4-5
OPENAI_CHEAP_MODEL=gpt-4o-mini
GEMINI_CHEAP_MODEL=gemini-2.5-flash-lite
GROK_CHEAP_MODEL=grok-3-mini
DEEPSEEK_CHEAP_MODEL=deepseek-chat
OLLAMA_CHEAP_MODEL=llama3.2:3b
```

### Resultado esperado

Reducción medida de **30–50% en tokens facturados** por chat activo, sin degradación perceptible de calidad (porque las tareas internas no necesitan premium). Dashboard muestra `cache_hit_rate > 60%` en conversaciones de >10 turnos.

---

## Fase 8 — Memoria tipada y worktrees (4–5 días) ✅ COMPLETADA

**Entry:** Fase 6 + 7.
**Exit:** memoria estructurada por tipos con scopes + MEMORY.md auto + WorkspaceProvider interface + GitWorktree adaptor listo (opcional con flag).

### Diseño modular aplicado (revisión 2026-04-18)

- **Tabla nueva `typed_memory`** (no se extiende `notes`) — evita coupling con memoria legacy
- **Body en disco + row con metadata** — row tiene `body_path`, el body vive en `memory/typed/<scope>/<name>.md`
- **`WorkspaceProvider` interface abstracta** — `NullWorkspace` (default) + `GitWorktreeWorkspace` + futuro `DockerWorkspace`/`SSHWorkspace` (Fase 12.2)
- **GC via `scheduler.js`** (pendiente wiring: Fase 8.4 parcial — método `gc()` existe, falta registrarlo en scheduler)
- **Fail-open** en GitWorktreeWorkspace: si no es repo git, retorna fallback cwd actual con warning

### 8.1 Memoria tipada
- [x] `storage/TypedMemoryRepository.js` — tabla nueva `typed_memory(id, scope_type, scope_id, kind, name, description, body_path, created_at, updated_at)` con UNIQUE(scope_type, scope_id, name)
- [x] `services/TypedMemoryService.js` — `save/list/get/forget` + regenera MEMORY.md por scope
- [x] 5 kinds: `user, feedback, project, reference, freeform`
- [x] 4 scope_types: `user, chat, agent, global`
- [x] `memory/typed/<scope_type>/[<scope_id>/]<name>.md` — body en disco
- [x] `MEMORY.md` auto-generado por scope con cap `MEMORY_MD_MAX_CHARS=10000`
- [x] Tools MCP: `memory_save_typed`, `memory_list_typed`, `memory_forget`

### 8.2 Scopes de memoria
- [x] `user` — auto-resuelve `scope_id=userId` desde ctx.usersRepo
- [x] `chat` — auto-resuelve `scope_id=chatId` desde ctx
- [x] `agent` — auto-resuelve `scope_id=agentKey` desde ctx
- [x] `global` — sin scope_id
- [ ] Concatenar MEMORY.md en system prompt — *parked para iteración de build del system prompt* (requiere integración en `_buildToolSystemPrompt`)

### 8.3 Aislamiento por usuario
- [x] `memory_save_typed` con `scope_type=user` valida userId via `resolveUserId` (Fase 5 user-sandbox)
- [x] Sin userId → error "no se pudo resolver userId"

### 8.4 Git worktrees para subagentes
- [x] `core/workspace/WorkspaceProvider.js` — interface abstracta
- [x] `core/workspace/NullWorkspace.js` — default, cwd actual, release no-op
- [x] `core/workspace/GitWorktreeWorkspace.js` — `git worktree add` + `release()` idempotente + `gc(idleMs)` + `list()`/`touch()`
- [x] `failOpen=true` (default) — si el repoRoot no es git, retorna fallback cwd sin crashear
- [ ] Integración en `SubagentResolver`: subagentes de tipo `code` reciben `cwd = worktree.path` — *parked iteración*; requiere que `SubagentResolver.resolve()` reciba un `workspaceProvider` inyectado
- [ ] Tool `worktree_status` (admin) — *parked*

### Tests agregados en Fase 8
- `test/typed-memory-repo.test.js`     — 12/12 (CRUD + UNIQUE + upsert)
- `test/typed-memory-service.test.js`  — 14/14 (save/get/forget + MEMORY.md + validaciones de name + cap de tokens)
- `test/typed-memory-tools.test.js`    — 13/13 (MCP tools con auto-resolve de scope)
- `test/workspace-null.test.js`        — 6/6 (interface + NullWorkspace)
- `test/workspace-git.test.js`         — 7/7 (GitWorktree con repo real, fail-open, gc, touch)
- **Subtotal Fase 8: 52 tests nuevos**

**Total acumulado (Fases 0–8): 589 tests del refactor passing.**

### Flags

```env
TYPED_MEMORY_ENABLED=false        # (reservado — la tabla se crea siempre, pero el flag se usará cuando MEMORY.md se mergee al system prompt)
WORKTREES_ENABLED=false           # si true, bootstrap instancia GitWorktreeWorkspace
WORKTREES_REPO_ROOT=<path>        # opcional, default: parent del server
MEMORY_MD_MAX_CHARS=10000         # cap del MEMORY.md auto-generado
```

### Bugs cerrados

- [x] Memoria sin aislamiento por usuario → `scope_type=user` auto-resuelve userId y persiste separado
- [x] Subagentes sin aislamiento git → `GitWorktreeWorkspace` provee adaptor
- [x] Sin concepto de memoria tipada para feedback/user/project/reference → 5 kinds declarados

### Parked

- MEMORY.md concat en system prompt (requiere tocar `_buildToolSystemPrompt` con cap por scope)
- `SubagentResolver` pide workspace via provider pluggable (requiere iteración de Fase 5)
- Tool `worktree_status` (admin CRUD de worktrees activos)

---

## Fase 9 — Tools agénticas avanzadas (3–4 días)

**Entry:** Fase 6 (hooks para eventos de tools largas).
**Exit:** el modelo puede programarse, pausarse, monitorear procesos y notificar al usuario.

### Investigación previa

- [ ] Revisar si `scheduler.js` actual puede exponerse como tool del modelo (hoy es control del servidor). Si sí, reusar; si no, crear capa delgada.
- [ ] Mapear cómo se entregarían notificaciones por cada canal (Telegram `sendMessage`, WebChat `ws.send`, P2P).
- [ ] Output: `docs/fase-9-investigacion.md`.

### Tools nuevas

- [ ] **`monitor_process`** — params `{ pid | shellId, pattern? }`. Emite eventos stream al caller (vía cursor paginado o SSE interno). El modelo hace polling con `monitor_read(cursor)`.
- [ ] **`schedule_wakeup`** — params `{ delaySeconds, reason, resumePrompt? }`. El modelo termina el turno; el scheduler re-invoca el chat con `resumePrompt` al vencer. Útil para "probá el build y volvé en 5 min".
- [ ] **`cron_create / cron_list / cron_delete`** — el modelo crea jobs recurrentes propios (envuelve `scheduler.js`). Scope por chat/usuario. Admin approval para cron < 1min.
- [ ] **`push_notification`** — params `{ title, body, channel? }`. Dispara notificación real al canal activo del usuario; respeta quiet hours configurables.
- [ ] **`ask_user_question`** — params `{ question, options?: string[], timeoutSeconds? }`. Pausa el loop, muestra al usuario UI con opciones, resume con la respuesta. Si timeout → default o abort.
- [ ] **`notebook_edit`** — params `{ path, cellIndex, newSource, cellType? }`. Parser mínimo de `.ipynb` (JSON), edita celda, rewrite. No ejecuta kernel (fuera de scope).
- [ ] **`enter_plan_mode / exit_plan_mode`** — alternativa granular al modo plan actual. Permite al modelo entrar en “sólo lectura” para una sub-tarea sin cambiar el modo global del chat.

### Registro modular de tools

- [ ] Refactor `mcp/tools/index.js`: cada tool se registra con `register({ name, category, channels, roles, enabled, handler, schema })`. Hoy está parcial.
- [ ] Permite que Fases futuras agreguen tools sin tocar el índice central (plugin pattern).

### Tests

- [ ] `test/tools.agentic.test.js`: cada tool con happy path + error path.
- [ ] Test e2e: el modelo pide `schedule_wakeup(60)`, el scheduler reactiva, el modelo recibe el prompt de resume.

### Bugs cerrados

- [x] `scheduler.js` no invocable desde el modelo — `cron_create/list/delete` lo exponen con cuotas
- [ ] No hay mecanismo para pausar y reanudar loops largos — *parked* como stubs (requiere Fase 4 ResumableSession)

**Flag:** `AGENTIC_TOOLS_ENABLED=false`. Activable tool por tool vía `MCP_DISABLED_TOOLS` invertido.

### Estado por sub-item (2026-04-18)

| Tool | Estado | Artefactos |
|---|---|---|
| `notebook_edit` | ✅ | `mcp/tools/notebook.js` + 12 tests (update/insert/delete celdas .ipynb) |
| `enter_plan_mode`/`exit_plan_mode` | ✅ | `core/PlanModeService.js` + `mcp/tools/planMode.js` + 11 tests. Auto-exit 5min → evento `plan_mode:timeout` |
| `monitor_process` | ✅ (MVP polling) | `mcp/tools/monitor.js` + 8 tests. Usa `shell.snapshot()` si el ShellSession lo expone; si no, mensaje informativo |
| `cron_create`/`cron_list`/`cron_delete` | ✅ | `mcp/tools/cron.js` + `core/JobQuotaService.js` + 19+15 tests. Admin gate para cron < 60s |
| `push_notification` | ✅ | `mcp/tools/notify.js` + 6 tests. Emite evento `notification:push`; canales se suscriben. Quiet hours 22:00-8:00 |
| `schedule_wakeup` | 📋 parked | Stub en `mcp/tools/agenticParked.js` — retorna "parked, requires Fase 4 ResumableSession" |
| `ask_user_question` | 📋 parked | Stub con mensaje "parked, requires LoopRunner.suspend()" |

### Archivos nuevos (Fase 9)

- `core/PlanModeService.js` — estado per-chat de plan mode granular + auto-exit
- `core/JobQuotaService.js` — cuotas de crons + invocaciones/hora + min interval
- `mcp/tools/notebook.js` — notebook_edit (.ipynb parser mínimo, 3 ops)
- `mcp/tools/planMode.js` — enter/exit_plan_mode
- `mcp/tools/monitor.js` — monitor_process (polling-based MVP)
- `mcp/tools/cron.js` — 3 cron tools (wrapper sobre scheduler)
- `mcp/tools/notify.js` — push_notification via eventBus
- `mcp/tools/agenticParked.js` — stubs documentados para schedule_wakeup + ask_user_question

### Tests agregados en Fase 9
- `test/tools.notebook.test.js`           — 12/12
- `test/plan-mode-service.test.js`        — 11/11 (service + 2 tools)
- `test/tools.monitor.test.js`            — 8/8
- `test/job-quota-service.test.js`        — 15/15
- `test/tools.cron.test.js`               — 14/14
- `test/tools.notify.test.js`             — 6/6
- **Subtotal Fase 9: 66 tests nuevos**

**Total acumulado (Fases 0–9): 641 tests del refactor passing.**

### Notas de parked

Las 2 tools parked (`schedule_wakeup`, `ask_user_question`) requieren capacidades en LoopRunner:

1. **`ResumableSession`** — persistir y rehidratar session tras delay externo. Requiere:
   - Serializar history + chatArgs en DB al `schedule_wakeup(delay)`
   - Timer/scheduler externo que re-invoca ConversationService al vencer
   - Continuar el loop desde donde quedó con `resumePrompt` inyectado

2. **`LoopRunner.suspend(question) → answer`** — pausar async generator y esperar input:
   - API: `await loopRunner.suspend({question, options, timeoutSeconds}) → answer`
   - Canal entrega la pregunta al usuario via `onAskPermission` extendido o evento nuevo
   - Timeout → default answer o abort

Ambas se implementarán en una iteración futura de Fase 4. Los stubs actuales dejan la tool visible en el catalog para que el modelo sepa que existen (solo que aún no funcionan).

---

## Fase 10 — LSP integration (5–7 días, opcional)

> Fase **cara** y con mucha superficie. Evaluar si el caso de uso doméstico la justifica. Si Clawmint se usa para dev, sí; si es sólo familia + domótica, saltarla.

**Entry:** Fase 7 (ya hay eficiencia de contexto).
**Exit:** el modelo entiende código estructuralmente, no sólo como texto.

### Investigación previa

- [ ] Decidir qué lenguajes soportar primero (recomendación: JS/TS con `typescript-language-server`).
- [ ] Revisar si conviene reusar el LSP que ya corre en el editor del usuario vs embeber uno propio (recomendación: embeber — control total).
- [ ] Output: `docs/fase-10-investigacion.md`.

### `services/LSPServerManager.js`

- [ ] Lanzar LSP por lenguaje bajo demanda (`spawn` del language server).
- [ ] Ciclo de vida: initialize → did_open/change/close → shutdown.
- [ ] Pool por workspace (no uno por request).
- [ ] Timeout 30s por request al LSP.

### Tools nuevas

- [ ] `lsp_go_to_definition(file, line, character)`
- [ ] `lsp_find_references(file, line, character)`
- [ ] `lsp_hover(file, line, character)`
- [ ] `lsp_document_symbols(file)`
- [ ] `lsp_workspace_symbols(query)`
- [ ] `lsp_diagnostics(file)`

### Tests

- [ ] Fixture con proyecto TS mínimo: resolver definición de función exportada, encontrar 3 referencias, hover devuelve tipo.

**Flag:** `LSP_ENABLED=false`.

---

## Fase 11 — Plataforma: MCP OAuth y slash commands (2–3 días)

**Entry:** Fase 6.
**Exit:** conectar Google/Atlassian sigue el patrón MCP estándar; los comandos frecuentes viven como skills reutilizables.

### Investigación previa

- [ ] Revisar qué partes de la Fase 2 del ROADMAP original (integraciones Google) ya se hicieron con OAuth custom. Evaluar migración a MCP servers oficiales (Gmail MCP, Google Calendar MCP, Google Drive MCP, Atlassian MCP).
- [ ] Confirmar que `mcps.js` + `mcp-client-pool.js` soportan el flujo `authenticate → complete_authentication` (interactivo).
- [ ] Output: `docs/fase-11-investigacion.md`.

### 11.1 MCP OAuth estandarizado

- [ ] Adaptar `mcp-client-pool.js` para flujos interactivos: cuando un MCP requiere auth, emitir evento `mcp:auth_required` con URL; el canal (Telegram/WebChat) lo muestra al usuario.
- [ ] Tool `mcp_authenticate(server)`, `mcp_complete_authentication(server, code)`.
- [ ] Persistir tokens por usuario en `storage/mcp_auth` (cifrado).
- [ ] Deprecar `server/auth/google-oauth.js` cuando los MCPs oficiales cubran el caso.

### 11.2 Slash commands como skills

- [ ] Refactor `skills.js` para exponer skills como `/nombre` en canales.
- [ ] Skills built-in: `/resumen`, `/revisar`, `/buscar`, `/ayuda`, `/memoria`, `/config`.
- [ ] Usuario puede agregar skills propios en `memory/<scope>/skills/*.md` con frontmatter `name, description, trigger`.
- [ ] Parser en canales: si mensaje empieza con `/` y matchea skill → inyecta body como `<system-reminder>` al prompt.

### 11.3 Keybindings y statusline (sólo WebChat)

- [ ] `memory/<user>/keybindings.json` → el WebChat los respeta.
- [ ] Statusline configurable por script (hook `status_line`) — devuelve string que se muestra arriba del input.

### Tests

- [ ] `test/mcp-oauth.test.js`: flujo mock de auth end-to-end.
- [ ] `test/slash-commands.test.js`: skill invocado con `/foo` llega al loop con system-reminder correcto.

**Flag:** `MCP_OAUTH_ENABLED=false`, `SLASH_COMMANDS_ENABLED=false`.

---

## Fase 12 — Plataforma extensible (4–6 días)

**Entry:** Fase 6 (hooks) + Fase 7 (eficiencia de contexto) + Fase 11 (MCP OAuth) completadas.
**Exit:** Clawmint deja de ser sólo un producto cerrado y se vuelve una **plataforma** sobre la que terceros construyen. Cubre los 4 gaps identificados en el análisis comparativo contra OpenCode (2026-04-18).

### Motivación

Al cerrar Fases 0–11 + 7.5, Clawmint alcanza ~85% de paridad funcional con OpenCode. El 15% restante no es "features más", es **extensibilidad externa**: SDK público, aislamiento real de subagentes vía containers, MCP dinámico, y sesiones compartidas entre dispositivos del hogar. Esta fase cierra ese 15% con patrones verificables en OpenCode (paths citados abajo).

### Investigación previa (obligatoria)

- [ ] `docs/fase-12-investigacion.md` con:
  - Leer el SDK de OpenCode (`packages/plugin/src/index.ts` y `packages/opencode/sdk/`) — documentar qué tipos expone y cómo los publica en npm.
  - Leer `packages/opencode/src/mcp/` completo, foco en `ToolListChangedNotification` handling.
  - Decidir: ¿session sharing via WebSocket server interno (ya tenés `ws/`) o sobre el P2P existente (`nodriza.js`)? Ambos son viables; elegir el que mejor encaje con el modelo on-premise.
  - Confirmar shape actual de `mcp-client-pool.js` post Fase 11 (tendrá cambios de OAuth que afectan esta fase).
  - Decidir qué tipo de workspace adaptor implementar primero: Docker (más común) o SSH (útil para Raspberry Pi remoto).

### 12.1 SDK público `@clawmint/sdk`

**Objetivo**: terceros pueden construir integraciones (Home Assistant, Alexa, WhatsApp Business, apps custom) sin leer el código interno del server.

- [ ] Crear `packages/sdk/` en el repo (si no es monorepo, carpeta separada con su propio `package.json`).
- [ ] Exponer factory:
  ```js
  import { createClawmintClient } from '@clawmint/sdk'
  const client = createClawmintClient({ baseUrl, apiKey })
  const session = await client.sessions.create({ agentKey, userId })
  await client.sessions.sendMessage(session.id, { text: 'hola' })
  const events = client.sessions.subscribe(session.id)
  for await (const event of events) { /* streaming */ }
  ```
- [ ] Tipos públicos: `Session`, `Message`, `Agent`, `User`, `Channel`, `ToolCall`, `Event`.
- [ ] Transport: HTTP + WebSocket (reusa lo que ya tenés en `routes/` y `ws/`).
- [ ] Versionado semver independiente del server. API del server versiona con `/api/v1/`.
- [ ] README con quickstart + ejemplos (invocar a un agente desde un script Node, desde Home Assistant, desde una skill de Alexa).
- [ ] Publicar a npm (primera versión 0.1.0, beta).

**Referencia verificable**: `C:/Users/padil/Documents/wsl/opencode/packages/plugin/src/index.ts` — cómo OpenCode define `PluginInput` con `client: ReturnType<typeof createOpencodeClient>`, `project`, `directory`, `experimental_workspace`.

**Tests**: `test/sdk-integration.test.js` — arrancar server en modo test, el SDK crea sesión, envía mensaje, recibe stream, cierra.

### 12.2 Workspace adaptors (`core/workspace/`)

**Objetivo**: los subagentes (especialmente tipo `code`, Fase 5) ejecutan tools dentro de un workspace aislado. Hoy comparten el cwd del server. Esto es riesgo de seguridad real.

- [ ] Interface:
  ```js
  // core/workspace/WorkspaceProvider.js
  export class WorkspaceProvider {
    async acquire(ctx) { throw new Error('abstract') }  // → { cwd, release() }
  }
  ```
- [ ] Implementaciones:
  - [ ] `NullWorkspace` — default, usa cwd del server. No cambia comportamiento actual.
  - [ ] `GitWorktreeWorkspace` — ya propuesto en Fase 8. Integrar acá como adaptor formal.
  - [ ] `DockerWorkspace` — spawn un container (imagen custom o `alpine` + build tools), bind mount de directorio temporal, ejecuta bash dentro. Cleanup con `docker rm -f` al release.
  - [ ] `SSHWorkspace` — ejecuta tools via SSH en host remoto (útil si Clawmint corre en NAS pero querés ejecutar en otro host).
- [ ] Cada subagente declara qué adaptor usar en su config:
  ```json
  {
    "key": "code-sandboxed",
    "type": "code",
    "workspace": { "provider": "docker", "image": "clawmint/sandbox:latest" }
  }
  ```
- [ ] Alias opaco `$WORKSPACE` en el system prompt del subagente — el modelo ve el path lógico, no el real del container/host.
- [ ] GC: workspaces con >24h sin actividad se liberan (reusa `scheduler.js`).
- [ ] Tool `workspace_status` (admin only) — lista workspaces activos.

**Referencia**: `C:/Users/padil/Documents/wsl/opencode/packages/plugin/src/index.ts` — type `WorkspaceAdaptor` con `configure/create/remove/target`.

**Flag**: `WORKSPACE_ADAPTORS_ENABLED=false`. Activación progresiva por subagente.

**Tests**:
- `test/workspace-docker.test.js`: crear docker workspace, ejecutar `bash` con `echo test`, verificar output, verificar que el container se destruye al release.
- `test/workspace-ssh.test.js`: con mock SSH server, ejecutar comando remoto.
- `test/workspace-isolation.test.js`: subagente con workspace=docker ejecuta `rm -rf /` — host del server queda intacto.

**Bugs cerrados**:
- [ ] Sin aislamiento real — un subagente con bash puede leer/escribir en todo el host (hoy).

### 12.3 MCP subscriptions via SSE

**Objetivo**: cuando un MCP externo agrega/quita tools en runtime, Clawmint se entera sin reconectar.

Hoy, agregar una tool a un MCP requiere reiniciar la conexión. OpenCode soporta `ToolListChangedNotification` — el server MCP manda una notification SSE y el cliente refetcha la lista.

- [ ] Upgrade de `mcp-client-pool.js` para soportar SSE transport en paralelo a stdio/HTTP.
- [ ] Handler de notifications estándar del protocolo MCP:
  - `notifications/tools/list_changed` → refetch `tools/list`
  - `notifications/resources/list_changed` → refetch `resources/list`
  - `notifications/prompts/list_changed` → refetch `prompts/list`
  - `notifications/resources/updated` → invalidar cache del resource específico
- [ ] Cuando cambia la lista de tools de un MCP, emitir evento `mcp:tools_updated` que `ToolCatalog` (Fase 7) consume para refrescar su índice.
- [ ] Reconnect policy: exponential backoff si la conexión SSE se pierde.

**Referencia**: `C:/Users/padil/Documents/wsl/opencode/packages/opencode/src/mcp/index.ts` — handler de `ToolListChangedNotification`.

**Flag**: `MCP_SSE_SUBSCRIPTIONS_ENABLED=false`.

**Tests**:
- Mock MCP server que emite `tools/list_changed` → cliente refetch → `ToolCatalog` refrescado.
- Desconexión SSE → reconexión automática con backoff.

**Bugs cerrados**:
- [ ] Cambios en MCP externos requieren restart manual (hoy).

### 12.4 Session sharing multi-device (opcional)

**Objetivo**: el usuario empieza una conversación en Telegram mientras camina. Llega a casa, abre el WebChat en el tablet, **la misma conversación está ahí** y puede seguir.

> **Decisión de diseño crítica**: NO usar Cloudflare Durable Objects (como OpenCode) ni ningún servicio cloud. Clawmint es on-premise. Usar el WebSocket interno o el P2P de nodriza ya existente.

- [ ] `routes/session-share.js`:
  - `POST /api/sessions/:id/share` → genera token opaco de share (no predecible), permisos por usuario.
  - `GET /api/sessions/shared/:token` → devuelve la sesión si el usuario autenticado tiene derecho.
  - `WS /api/sessions/shared/:token/stream` → broadcast de cambios (nuevos mensajes, tool calls) a todos los dispositivos conectados.
- [ ] Integración con `ChannelRouter`: cuando se emite un mensaje en Telegram que pertenece a una sesión compartida, también se broadcast a los WebSockets de esa sesión.
- [ ] Persistencia: tokens de share viven en tabla `shared_sessions` con expiración (default 24h, configurable).
- [ ] UI WebChat: aceptar `?shared=<token>` en la URL para cargar sesión compartida.

**Referencia**: `C:/Users/padil/Documents/wsl/opencode/packages/function/src/api.ts` (class `SyncServer`) — patrón de broadcast, adaptar a WebSocket local en lugar de Durable Object.

**Flag**: `SESSION_SHARING_ENABLED=false`.

**Tests**:
- Usuario A crea sesión en Telegram, comparte, usuario B conectado por WebSocket recibe el mismo historial + mensajes nuevos en vivo.
- Token expirado → rechazo limpio.
- Usuario sin permiso → 403.

### Bugs cerrados transversales

- [ ] Sin SDK: cada integración externa (scripts propios, Home Assistant, etc.) reinventa el cliente HTTP.
- [ ] Sin aislamiento: riesgo de seguridad al ejecutar bash de modelos.
- [ ] Sin MCP subscriptions: cambios externos requieren restart.
- [ ] Sin sharing: conversación atada a un solo canal/dispositivo.

**Flags Fase 12**:
```env
# SDK se publica en npm, no tiene flag runtime — usa el API público del server
WORKSPACE_ADAPTORS_ENABLED=false
MCP_SSE_SUBSCRIPTIONS_ENABLED=false
SESSION_SHARING_ENABLED=false
SESSION_SHARE_TOKEN_TTL_HOURS=24
```

### Resultado esperado

Clawmint deja de ser un producto cerrado y se vuelve plataforma. Un desarrollador externo puede:
1. Instalar `@clawmint/sdk` y escribir una integración en 20 líneas.
2. Ejecutar un subagente de código peligroso dentro de un container Docker aislado.
3. Conectar un MCP externo cuya lista de tools cambia (plug-and-play sin restart).
4. Abrir la misma conversación en Telegram, WebChat y tablet sin perder contexto.

---

## Test transversal Parte 2

Post-Fase 11, ejecutar escenario extendido:

> "Cada mañana a las 7:00, revisá mis correos de Gmail, buscá los que tengan 'factura' o 'pago', resumilos, y mandame un push notification. Si hay alguno urgente, hacé un ask_user_question para confirmar si lo marco como importante."

**Debe verificarse:**
- [ ] `cron_create` programa la rutina diaria (Fase 9)
- [ ] Gmail MCP autentica vía flujo estándar (Fase 11)
- [ ] Al disparar, `schedule_wakeup` + `monitor` coordinan la búsqueda (Fase 9)
- [ ] Hook `audit_log` registra cada tool_use (Fase 6)
- [ ] System prompt se mantiene < 4000 tokens aun con 40+ tools (Fase 7)
- [ ] `push_notification` llega al canal activo (Fase 9)
- [ ] `ask_user_question` pausa y resume limpio (Fase 9)
- [ ] Memoria tipada guarda preferencia del usuario para próximas iteraciones (Fase 8)

---

## Test transversal final

Post-Fase 5, ejecutar escenario completo en Telegram:

> "Investigá el proyecto X de GitHub, listame los issues abiertos y creá una tarea por cada uno"

**Debe verificarse:**
- [ ] Coordinador delega a subagente `researcher`
- [ ] `researcher` usa `webfetch` → recibe resultados
- [ ] Coordinador crea tareas con `task_create`
- [ ] Respuesta al usuario fluye con **streaming visible**
- [ ] **System prompt cacheado** entre turnos (verificar en logs `cache_read > 0`)
- [ ] **Thinking adaptive** activo cuando la tarea lo merece
- [ ] Permisos `auto` por default; desactivar `webfetch` → rechazo limpio
- [ ] Si coordinador intenta cancelar (`abort`), el stream se corta real, no queda colgado 120s

---

## Variables de entorno nuevas

```env
# Feature flags Parte 1 (motor)
PROVIDER_V2_ENABLED_FOR=anthropic,openai,gemini,deepseek,grok,ollama
ANTHROPIC_USE_V2=true
USE_LOOP_RUNNER=true
PERMISSIONS_ENABLED=false
MCP_DISABLED_TOOLS=

# Feature flags Parte 2 (plataforma)
HOOKS_ENABLED=false
HOOKS_ENABLED_SCOPES=global,user
LAZY_TOOLS_ENABLED=false
MICROCOMPACT_ENABLED=false
REACTIVE_COMPACT_ENABLED=false
TYPED_MEMORY_ENABLED=false
WORKTREES_ENABLED=false
AGENTIC_TOOLS_ENABLED=false
LSP_ENABLED=false
MCP_OAUTH_ENABLED=false
SLASH_COMMANDS_ENABLED=false

# Feature flags Fase 12 (plataforma extensible)
WORKSPACE_ADAPTORS_ENABLED=false
MCP_SSE_SUBSCRIPTIONS_ENABLED=false
SESSION_SHARING_ENABLED=false
SESSION_SHARE_TOKEN_TTL_HOURS=24

# Feature flags Fase 7.5 (token economy transversal)
TOKEN_ECONOMY_ENABLED=false
MODEL_TIERS_ENABLED=false
CACHE_TTL_DUAL_ENABLED=false
COMPACT_CIRCUIT_BREAKER=true
SUBAGENT_CACHE_SHARE=false
BASH_MAX_OUTPUT_LENGTH=30000
MAX_CONSECUTIVE_COMPACT_FAILURES=3

# Overrides de model tiers (opcional — pisan providers/modelTiers.js)
# Valores de referencia abril 2026, validar contra docs del provider al ejecutar
ANTHROPIC_CHEAP_MODEL=claude-haiku-4-5
ANTHROPIC_BALANCED_MODEL=claude-sonnet-4-6
ANTHROPIC_PREMIUM_MODEL=claude-opus-4-7
OPENAI_CHEAP_MODEL=gpt-4o-mini
OPENAI_BALANCED_MODEL=gpt-4o
OPENAI_PREMIUM_MODEL=gpt-5
GEMINI_CHEAP_MODEL=gemini-2.5-flash-lite
GEMINI_BALANCED_MODEL=gemini-2.5-flash
GEMINI_PREMIUM_MODEL=gemini-2.5-pro
GROK_CHEAP_MODEL=grok-3-mini
GROK_BALANCED_MODEL=grok-3
GROK_PREMIUM_MODEL=grok-4
DEEPSEEK_CHEAP_MODEL=deepseek-chat
DEEPSEEK_PREMIUM_MODEL=deepseek-reasoner
OLLAMA_CHEAP_MODEL=llama3.2:3b
OLLAMA_BALANCED_MODEL=qwen2.5:14b
OLLAMA_PREMIUM_MODEL=llama3.3:70b

# Integraciones
BRAVE_SEARCH_API_KEY=<key>
```

---

## Timeline

| Fase | Estado | Tiempo | Entregable |
|------|--------|--------|------------|
**Parte 1 — Motor a paridad con Claude Code**

| Fase | Estado | Tiempo | Entregable |
|------|--------|--------|------------|
| 0 — Base | [x] | 1–2 días | Infra v2, cero cambio funcional |
| 1 — Anthropic v2 | [x] | 2–3 días | Streaming + cache + thinking en prod |
| 2 — Resto providers | [x] | 3–5 días | 5 providers migrados |
| 3 — Tools nuevas | [x] | 2–3 días | glob, grep, webfetch, websearch, tasks, skill_invoke |
| 4 — LoopRunner | [x] | 2–3 días | Loop extraído (RetryPolicy + LoopDetector + CallbackGuard + LoopRunner) + cancelación real |
| 4-extra — ResumableSession + suspend | [x] | 1–2 días | SuspendedPromptsManager + LoopRunner.suspend/resume + ResumableSessionsRepository + scheduler hook resume_session + ConversationService.processMessage hook (consume answers pending antes del turn) |
| 5 — Subagentes + permisos | [x] | 3–4 días | SubagentRegistry + SubagentResolver + PermissionService + PermissionRepository + /api/permissions |

**Subtotal Parte 1:** 2–3 semanas.

**Pre-requisitos bloqueantes de Parte 2** *(agregados en revisión 2026-04-18)*

| Fase | Estado | Tiempo | Entregable | Bloquea |
|------|--------|--------|------------|---------|
| 5.5 — Observabilidad | [x] | 2 días | MetricsService + MetricsBridge + StructuredLogger + correlationId + /api/metrics | Fase 6+ |
| 5.75 — Hardening | [x] | 1–2 días | ssrfGuard + promptInjectionGuard + shellSandbox + admin gate /api/mcps + audit doc | Fase 6, 11 |

**Parte 2 — Plataforma a paridad con Claude Code** *(post Fase 5)*

| Fase | Estado | Tiempo | Entregable | Depende de |
|------|--------|--------|------------|-----------|
| 6 — Hooks | [x] | 3–4 días | HookRegistry + 3 executors (js/shell/http) + HookRepository + integración ConversationService + built-ins | Fase 5 |
| 7 — Eficiencia contexto | [x] | 3–4 días | ContextCompactor interface + 3 compactors + CompactorPipeline + ToolCatalog + tool_search/tool_load + overflow detection + cache break | Fase 6 |
| 7.5 — Token economy transversal | [x] | 4–5 días | Model tiers + caching caps + output caps + TTL dual + routing cheap + circuit breaker + CacheSafeParams + **AgentOrchestrator prefix sharing** (coordinator system prompt reusado en delegaciones para cache hit) | Fases 1, 2, 7 |
| 8 — Memoria tipada + worktrees | [x] | 4–5 días | TypedMemoryService + MEMORY.md auto + WorkspaceProvider interface + NullWorkspace + GitWorktreeWorkspace + **DockerWorkspace + SSHWorkspace + workspace_status tool (admin) + SubagentResolver workspace acquire** | Fase 6, 7 |
| 9 — Tools agénticas | [x] | 3–4 días | 11 tools listas: notebook_edit, enter/exit_plan_mode, monitor_process, cron_*, push_notification, schedule_wakeup, ask_user_question, **workspace_status** (admin) | Fase 6 + Fase 4 extra |
| 10 — LSP *(opcional)* | [x] | 5–7 días | LSPClient + LSPServerManager + 6 tools lsp_* + **fail-open dinámico** (detectAvailableServers al bootstrap; tools devuelven mensaje claro si el binario no está) | Fase 7 |
| 11 — MCP OAuth + skills | [x] | 2–3 días | TokenCrypto + McpAuthRepository + McpAuthService + 3 mcp_* tools + slashCommandParser middleware + UserPreferencesRepository + /api/user-preferences + **OAuth callback per-provider** (/api/mcp-auth/start/:provider + /callback/:provider con state validation + registerCallbackHandler) | Fase 6 |
| 12 — Plataforma extensible | [x] | 4–6 días | DockerWorkspace + SSHWorkspace + MCP SSE notifications wire + SharedSessionsRepository + SharedSessionsBroker + /api/session-share + **SDK publicable @clawmint/sdk** (packages/sdk/ con package.json + index.d.ts + README + LICENSE + smoke test, listo para npm publish) | Fases 6, 7, 11 |

**Subtotal Parte 2:** 5–6 semanas (sin Fase 10); 6–7 con LSP.

**Total global:** 6–9 semanas distribuidas en milestones independientes.

Cada fase es mergeable a `main` independientemente detrás de su flag. Si algo se complica en una fase, el rollback es inmediato (env var). Las fases de Parte 2 son **opcionales** — saltar cualquiera no bloquea las siguientes salvo dependencias explícitas en la tabla.

---

## Nota sobre la Parte 2: investigar antes de ejecutar

La Parte 2 se diseñó en fecha `2026-04-18` y se ejecuta **después** de cerrar Fases 0–5. Entre hoy y ese momento, el código va a mutar: `LoopRunner` tendrá detalles concretos, `PermissionService` tendrá su propia forma, `mcp/tools/index.js` habrá cambiado de shape, tal vez existan módulos no previstos.

**Regla no negociable:** cada Fase 6+ arranca con un commit del documento `docs/fase-N-investigacion.md` que:

1. Lista los archivos que la fase va a tocar y el shape real de cada uno en ese momento.
2. Identifica qué partes del plan ya están parcialmente cubiertas y no hay que duplicar.
3. Detecta bugs preexistentes que convenga cerrar en la misma fase (oportunidad).
4. Propone ajustes al plan si la realidad del código difiere de lo previsto acá.

Sin ese documento revisado, no se abre PR de implementación. Esta fricción previene que el roadmap se vuelva una guía ciega que rompe cosas por asumir un pasado que ya no existe.
