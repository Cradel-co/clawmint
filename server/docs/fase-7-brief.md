> Última actualización: 2026-04-18
> Audiencia: agente que acaba de cerrar Fase 6 y va a empezar Fase 7.
> Autoridad: este brief **prevalece** sobre `server/ROADMAP.md` donde haya discrepancia (el ROADMAP se escribió antes de que tuviéramos ejemplos verificables de Claude Code v2.1.88 y OpenCode).

# Brief de handoff: Fase 6 → Fase 7

## 0. Lo que terminaste (recapitulación)

Completaste **Fase 6 — Hooks del harness**. El sistema ahora tiene:

- `HookRegistry` con scopes (`global | user | chat | channel | agent`) y prioridades.
- Eventos: `pre_tool_use`, `post_tool_use`, `user_prompt_submit`, `assistant_response`, `session_start`, `session_end`, `pre_compact`, `post_compact`, `tool_error`, `permission_decided`.
- Handlers sync o async con timeout.
- `HookRepository` SQLite con CRUD.
- Executors: shell, http, skill, js (registrados via plugin pattern — si no lo hiciste así, arreglar en 6.1).
- Integración en `LoopRunner`: `pre_tool_use` → permission → tool → `post_tool_use`.
- Routes admin: `POST/GET/DELETE/PATCH /api/hooks`.
- Hooks built-in: `audit_log`, `rate_limit_per_tool`, `block_dangerous_bash`.

Asumimos que los tests pasan y `HOOKS_ENABLED=false` por default.

## 1. Lo que vas a hacer ahora

**Fase 7 — Eficiencia de contexto.** Objetivo: que el system prompt promedio se reduzca ≥40% y que conversaciones largas no pierdan contexto relevante. Tiempo estimado 3–4 días.

Pero **antes de arrancar Fase 7 en serio, hay ajustes a Fase 6 que valen la pena hacer ahora mismo** (están numerados 6.1–6.7 abajo). Varios son pre-requisitos silenciosos de Fase 7 — si no los hacés ahora, los vas a necesitar en 2 días y vas a tener que ir y volver.

Flujo recomendado:
1. Leer este brief completo.
2. Ejecutar ajustes Fase 6.x en orden.
3. Commitear los ajustes como commits separados (uno por ajuste, `refactor(hooks): 6.1 plugin pattern executors`, etc.).
4. Arrancar Fase 7 con investigación previa (§3).

---

## 2. Ajustes a Fase 6 (6.1–6.7)

Cada ajuste tiene: **por qué**, **qué hacer exacto**, **criterio de aceptación**.

### 6.1 — Plugin pattern para executors

**Por qué**. Si tu `HookRegistry` tiene un `switch(handler_type)` interno con 4 casos (shell/http/skill/js), agregar un 5º en el futuro toca el core. Queremos que executors nuevos se sumen sin modificar `HookRegistry`.

**Qué hacer**:

```js
// server/core/hooks/HookRegistry.js
class HookRegistry {
  constructor() {
    this.executors = new Map()  // handler_type → ExecutorInstance
  }

  registerExecutor(type, executor) {
    this.executors.set(type, executor)
  }

  async _runHandler(hook, payload) {
    const executor = this.executors.get(hook.handler_type)
    if (!executor) {
      throw new Error(`No executor registered for type: ${hook.handler_type}`)
    }
    return await executor.run(hook, payload, { timeoutMs: hook.timeout_ms })
  }
}

// En bootstrap.js:
hookRegistry.registerExecutor('shell', new ShellExecutor())
hookRegistry.registerExecutor('http', new HttpExecutor())
hookRegistry.registerExecutor('skill', new SkillExecutor(skillsService))
hookRegistry.registerExecutor('js', new JsExecutor(jsHandlersMap))
```

**Criterio**: agregar un executor nuevo (`grpc`, `webhook_v2`) no requiere tocar `HookRegistry.js`. Test: `registerExecutor('fake', fakeExecutor)` y verificar que se ejecuta.

---

### 6.2 — `replace: { args }` inmutable en vez de `mutate`

**Por qué**. La revisión 2026-04-18 ya lo pidió. Si un handler devuelve `{ mutate: { args: {...} } }` tenés ambigüedad sobre quién ganó la mutación cuando hay varios handlers. `replace` deja claro que el handler de mayor prioridad devuelve los args finales de reemplazo.

**Qué hacer**:

```js
// Cambiar contrato de return de handler pre_tool_use:
// ANTES: { mutate: { args: {...} } }
// AHORA: { replace: { args: {...} } }  // o { block: 'razón' }

async emit(event, payload) {
  let currentPayload = payload
  const handlers = this._resolveHandlers(event, payload)  // ya ordenados por scope+priority
  for (const handler of handlers) {
    const result = await this._runHandler(handler, currentPayload)
    if (result?.block) {
      return { blocked: true, reason: result.block }
    }
    if (result?.replace?.args !== undefined) {
      currentPayload = { ...currentPayload, args: result.replace.args }
    }
  }
  return { payload: currentPayload }
}
```

**Criterio**: dos handlers con `replace`, el de mayor prioridad gana (test). El resultado final viaja a `permission` + `executeTool`.

---

### 6.3 — Hot-reload de hooks

**Por qué**. Desarrollar hooks es doloroso si tenés que reiniciar el server cada vez que agregás una regla. Endpoint de reload + evento.

**Qué hacer**:

```js
// server/routes/hooks.js
router.post('/api/hooks/reload', async (req, res) => {
  await hookRegistry.reload()  // re-lee desde HookRepository
  eventBus.emit('hook:reloaded', { source: 'api', at: Date.now() })
  res.json({ ok: true, count: hookRegistry.size() })
})

// server/core/hooks/HookRegistry.js
async reload() {
  const hooks = await this.repo.listAll()
  this._index = new Map()  // rebuild index por evento+scope
  for (const h of hooks) this._index.set(h.id, h)
}
```

**Criterio**: agregás un hook via `POST /api/hooks`, llamás `POST /api/hooks/reload`, disparás un `pre_tool_use` y ves el hook ejecutarse sin restart.

---

### 6.4 — Documentar orden hook ↔ permission en `server/docs/events.md`

**Por qué**. La revisión 2026-04-18 pidió que **`permission` siempre evalúa los args FINALES, post-hook-pre**. Esto es decisión de diseño — hay que dejarla escrita para que nadie la rompa sin darse cuenta.

**Qué hacer**: en `server/docs/events.md` agregar sección:

```markdown
## Orden de evaluación en LoopRunner.executeTool

1. hookRegistry.emit('pre_tool_use', { tool, args })
   - handlers pueden: `block` (aborta), `replace.args` (modifica args)
2. permissionService.resolve(tool, finalArgs, ctx)
   - evalúa reglas contra los args POST-hook (no los originales)
   - puede: 'auto' (sigue), 'ask' (UI), 'deny' (aborta con mensaje)
3. executeTool(tool, finalArgs)
4. hookRegistry.emit('post_tool_use', { tool, args, result })

Invariante: permission NUNCA ve los args originales del modelo si un hook los modificó.
Razón: los hooks son política declarativa; permission evalúa la acción real que va a ejecutarse.
```

**Criterio**: doc committeado. Test: un hook replace.args con un path prohibido; `assertPathAllowed` debería rechazarlo (el hook no puede saltear permissions).

---

### 6.5 — Timeout per-hook configurable

**Por qué**. El default global de 10s es razonable, pero un hook concreto puede necesitar 30s (HTTP a servicio lento) u 1s (validación local). Poner `timeout_ms` en el schema.

**Qué hacer**:

```sql
-- migration
ALTER TABLE hooks ADD COLUMN timeout_ms INTEGER DEFAULT 10000;
```

```js
// HookRegistry._runHandler usa hook.timeout_ms con fallback a 10000
const timeout = hook.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS
```

**Criterio**: un hook con `timeout_ms: 1` falla por timeout; otro con `timeout_ms: 60000` sobrevive una operación de 5s.

---

### 6.6 — **NUEVO**: Hook `chat.params` (inspirado en OpenCode)

**Por qué**. OpenCode expone un hook `chat.params` que permite a un plugin modificar **temperature, topP, topK, maxTokens** justo antes de enviar al provider. Esto abre casos como: "para este usuario bajá temperature a 0.2", "para el agente 'creativo' subí topP", "nunca más de 4k tokens en este canal". Sin esto, cada caso requiere hardcodear en el core.

Es un hook más, pero potente. Agregarlo ahora que ya tenés la infraestructura es media hora.

**Qué hacer**:

```js
// Agregar evento al HookRegistry:
// 'chat.params'

// En LoopRunner, ANTES de llamar al provider:
let params = { temperature, topP, topK, maxTokens, model }
const hookResult = await hookRegistry.emit('chat.params', {
  userId, chatId, agentKey, channel, params
})
if (hookResult?.replace?.params) {
  params = { ...params, ...hookResult.replace.params }
}
// Pasar params al provider
```

**Criterio**: un hook registrado en scope `user` con `replace.params: { temperature: 0.1 }` hace que todos los requests de ese user salgan con temp 0.1. Test que lo verifique leyendo lo que se mandó al mock provider.

**Path de OpenCode para verificar la idea**: `C:/Users/padil/Documents/wsl/opencode/packages/plugin/src/index.ts` (tipo `Hooks["chat.params"]`).

---

### 6.7 — **NUEVO**: Separar `tool_error` de `provider_error`

**Por qué**. Hoy tenés `tool_error` como único evento de error. Pero un error de provider (429 de Anthropic) y un error de tool (bash retornó exit 1) son cosas distintas. Un hook de `audit_log` los quiere diferenciar. Uno de `alert_on_provider_5xx` no debe dispararse por fallas de shell.

**Qué hacer**:

- Dejar `tool_error` (errores dentro de la ejecución de una tool).
- Agregar `provider_error` (errores en la llamada al LLM provider).
- Emitirlo desde el provider wrapper o desde el `LoopRunner` cuando el retry policy da up.

```js
// En providers/base/legacyShim.js o donde manejes errores de provider:
try {
  return await provider.chat(req, { signal })
} catch (err) {
  await hookRegistry.emit('provider_error', {
    provider: providerName,
    model,
    error: { message: err.message, status: err.status, retryable: isRetryable(err) },
    attempt
  })
  throw err
}
```

**Criterio**: un hook suscrito sólo a `provider_error` NO se dispara cuando una tool falla; sí se dispara cuando Anthropic devuelve 429.

---

## 3. Fase 7 — Plan completo

### 3.0 Pre-requisito: investigación previa (obligatoria)

**Antes de escribir una línea de código**, crear y commitear `server/docs/fase-7-investigacion.md` con:

1. **Medir tokens actuales** del system prompt en 3 escenarios reales:
   - chat nuevo de Telegram, sin historial, agente default
   - chat de WebChat con 20 turnos de historial
   - chat con MCP externo conectado (que agrega tools)

   Para cada uno: contar tokens del system prompt desglosado en `{static_preamble, tools_block, memory, agent_prompt, hooks_block}`. Usar un tokenizer (tiktoken para OpenAI-style, el del Anthropic SDK para Claude).

2. **Shape actual** de `ConversationService.buildSystemPrompt` (o como se llame). Documentar qué se incluye, en qué orden, y dónde se podría cachear.

3. **Sliding window actual**: dónde se aplica, qué tira, qué preserva.

4. **Callsites** de Haiku o modelos "cheap" hoy: `grep -rn "claude-haiku"` y similares. Documentar cuáles pasarán a usar `resolveModelForTier(provider, 'cheap')` en Fase 7.5.

5. **Qué tools mandan resultados grandes**: `bash`, `read_file`, `grep`, `webfetch` son obvias. Listar todas y estimar tamaño típico del output (en tokens) para saber a cuáles aplicar microcompactación.

**Salida esperada**: doc de ~300-500 líneas con números reales, no estimaciones. Sin este doc, no se abre PR de Fase 7 (regla de la Parte 2 del ROADMAP).

---

### 3.1 — Lazy tool loading (`core/ToolCatalog.js`)

**Objetivo**: que el system prompt incluya sólo **nombres + descripción corta** de todas las tools, y los schemas completos se pidan on-demand con la tool `tool_search`.

**Decisión arquitectónica (ajuste sobre el ROADMAP original)**: según la revisión 2026-04-18, **dos tools separadas**, no una sola con `{query|select}`:
- `tool_search({ query: string })` → devuelve lista de nombres coincidentes con descripción corta.
- `tool_load({ names: string[] })` → devuelve schemas completos de las tools pedidas.

Más claro para el modelo, JSON schema más limpio, menos ambigüedad.

**Qué crear**:

```js
// server/core/ToolCatalog.js
class ToolCatalog {
  constructor({ tools, alwaysVisible = [] }) {
    this.tools = new Map()  // name → { metadata, schema }
    for (const t of tools) {
      this.tools.set(t.name, {
        metadata: { name: t.name, description: t.description, category: t.category },
        schema: t.inputSchema  // el schema Zod/JSON completo
      })
    }
    this.alwaysVisible = new Set(alwaysVisible)
    this._sessionCache = new Map()  // sessionId → Set<loadedToolName>
  }

  // Lo que va al system prompt:
  getMetadataIndex(agentDef) {
    const visible = new Set([
      ...this.alwaysVisible,
      ...(agentDef?.alwaysVisibleTools ?? [])
    ])
    return Array.from(this.tools.values()).map(t => {
      const full = visible.has(t.metadata.name)
      return full ? { ...t.metadata, inputSchema: t.schema } : t.metadata
    })
  }

  search(query, limit = 10) {
    const q = query.toLowerCase()
    return Array.from(this.tools.values())
      .filter(t => t.metadata.name.includes(q) || t.metadata.description.toLowerCase().includes(q))
      .slice(0, limit)
      .map(t => t.metadata)
  }

  load(names, sessionId) {
    const loaded = this._sessionCache.get(sessionId) ?? new Set()
    const result = names.map(n => {
      const t = this.tools.get(n)
      if (!t) return { name: n, error: 'not_found' }
      loaded.add(n)
      return { name: n, description: t.metadata.description, inputSchema: t.schema }
    })
    this._sessionCache.set(sessionId, loaded)
    return result
  }

  isLoaded(name, sessionId) {
    return this.alwaysVisible.has(name)
      || (this._sessionCache.get(sessionId)?.has(name) ?? false)
  }
}
```

**Whitelist de tools siempre visibles** (configurable):

```js
// env
ALWAYS_VISIBLE_TOOLS=read_file,bash,tool_search,tool_load,task_create
```

Y por agent:

```js
// agents.json
{
  "key": "explorer",
  "alwaysVisibleTools": ["read_file", "grep", "glob", "tool_search", "tool_load"]
}
```

**Integración con LoopRunner**: antes de `executeTool`, chequear `isLoaded`. Si no está cargada, devolver error al modelo:

```js
if (!toolCatalog.isLoaded(toolName, sessionId)) {
  return {
    error: `Tool "${toolName}" schema not loaded. Call tool_load({ names: ["${toolName}"] }) first.`
  }
}
```

Esto fuerza al modelo a seguir el protocolo.

**Auto-activación**: si el bloque de metadata de tools supera X% del context window, activar automáticamente. Claude Code usa 10% (`DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE`). Replicar:

```js
// Env: ENABLE_LAZY_TOOLS=auto o auto:15 (override percentage)
const threshold = parseAutoThreshold(process.env.ENABLE_LAZY_TOOLS)
if (toolsBlockTokens / contextWindow > threshold) enableLazyTools()
```

**Referencias verificables**:
- Claude Code: `src-extracted/src/tools/ToolSearchTool/ToolSearchTool.ts` y `src-extracted/src/utils/toolSearch.ts`.
- OpenCode: `C:/Users/padil/Documents/wsl/opencode/packages/opencode/src/tool/registry.ts`. OpenCode usa `dynamicTool` wrapper para MCP tools deferidas — patrón similar.

**Flag**: `LAZY_TOOLS_ENABLED=false` por default; `auto` para activación automática; `true` para forzar.

**Tests**:
- `test/tool-catalog.test.js`:
  - Con 40 tools registradas, `getMetadataIndex()` devuelve objects con `{name, description}` (sin `inputSchema`) excepto las whitelisted.
  - `search('file')` matchea `read_file`, `write_file`, `edit_file`.
  - `load(['read_file'], 'sess1')` → schema completo; `isLoaded('read_file', 'sess1')` → true.
  - `isLoaded('edit_file', 'sess1')` → false (no cargada en esa sesión).
  - LoopRunner: modelo invoca `edit_file` sin `tool_load` previo → recibe error esperado.

---

### 3.2 — Microcompactación (`core/compact/MicroCompactor.js`)

**Objetivo**: cada N turnos, comprimir los resultados de tools viejos a un placeholder conservando metadata útil.

**Concepto clave (Claude Code v2.1.88)**: NO se resume toda la conversación — sólo los **resultados de tools en mensajes intermedios**. Los últimos K turnos quedan intactos (por si el modelo los referencia). El primer turno (system) también.

**Lista de tools compactables** (copia del criterio de Claude Code):

```js
const COMPACTABLE_TOOLS = new Set([
  'bash', 'read_file', 'grep', 'glob', 'edit_file', 'write_file',
  'webfetch', 'websearch'
])
const IMAGE_MAX_TOKEN_SIZE = 2000  // si resultado incluye imagen, re-escalar a este máximo
```

**Interface común** (ajuste de revisión):

```js
// server/core/compact/ContextCompactor.js
export class ContextCompactor {
  shouldCompact(state) { throw new Error('abstract') }
  async compact(history, ctx) { throw new Error('abstract') }
}
```

Las tres implementaciones (MicroCompactor, ReactiveCompactor, SlidingWindowCompactor) extienden esta interface. Un `CompactorPipeline` orquesta en cascada.

**MicroCompactor**:

```js
export class MicroCompactor extends ContextCompactor {
  constructor({ everyTurns = 10, keepLastK = 4, providerRouter, modelTier }) {
    super()
    this.everyTurns = everyTurns
    this.keepLastK = keepLastK
    this.providerRouter = providerRouter
    this.modelTier = modelTier  // 'cheap' — Fase 7.5 lo activa
  }

  shouldCompact({ turnCount, lastMicroAt }) {
    return turnCount - lastMicroAt >= this.everyTurns
  }

  async compact(history, { hookRegistry }) {
    await hookRegistry.emit('pre_compact', { kind: 'micro', historySize: history.length })

    const toCompact = history.slice(1, history.length - this.keepLastK)
    const preserved = [history[0], ...history.slice(history.length - this.keepLastK)]

    const compacted = []
    for (const msg of toCompact) {
      if (msg.role === 'tool' && COMPACTABLE_TOOLS.has(msg.toolName)) {
        compacted.push({
          ...msg,
          content: '[Old tool result content cleared]',
          meta: { toolName: msg.toolName, at: msg.at, originalSize: msg.content?.length ?? 0 }
        })
      } else {
        compacted.push(msg)
      }
    }

    const newHistory = [preserved[0], ...compacted, ...preserved.slice(1)]
    await hookRegistry.emit('post_compact', { kind: 'micro', before: history.length, after: newHistory.length })
    return newHistory
  }
}
```

**Nota sobre `cache_edits` (Anthropic beta)**: Claude Code usa el feature `cache_edits` que permite "pinear" los edits en cache y re-enviarlos sin romper el prompt cache. Si tu provider Anthropic soporta ese beta, activalo acá. Si no, este patrón sigue funcionando pero rompe cache (pagás cache miss una vez, luego se rehidrata).

**Configuración por chat** (opcional):

```js
// chat_config table, columnas:
microcompact_every_turns INTEGER DEFAULT 10
keep_last_k INTEGER DEFAULT 4
```

**Flag**: `MICROCOMPACT_ENABLED=false` por default.

**Tests**:
- Conversación de 25 turnos con `everyTurns=10, keepLastK=4`: después del turno 10, mensajes 1–6 tienen tool results reemplazados por placeholder; 7–10 intactos; 0 (system) intacto.
- Tool no-compactable (ej: `ask_user_question`) NO se toca.
- Evento `pre_compact` y `post_compact` se emiten (verificar con spy en hookRegistry).

---

### 3.3 — Compactación reactiva (`core/compact/ReactiveCompactor.js`)

**Objetivo**: monitorear el tamaño del contexto y compactar automáticamente al 75% (agresividad 1: micro) y al 90% (agresividad 2: resumen de todo salvo últimos 2 turnos).

**Thresholds (de Claude Code)**:

```js
const AUTOCOMPACT_BUFFER_TOKENS = 13_000   // preservar para respuesta
const WARNING_THRESHOLD_TOKENS = 20_000    // emitir warning al usuario
const MANUAL_COMPACT_BUFFER = 3_000
```

**Trigger**:

```js
shouldCompact({ usage, contextWindow }) {
  const effective = contextWindow - AUTOCOMPACT_BUFFER_TOKENS
  return usage > effective  // saltá compaction si usage > threshold
}
```

**Estrategia escalonada**:

```js
async compact(history, ctx) {
  const pct = ctx.usage / ctx.contextWindow

  if (pct < 0.90) {
    // Agresividad 1: invocar MicroCompactor forzado
    return this.microCompactor.compact(history, ctx)
  } else {
    // Agresividad 2: resumen de medio con Haiku
    const preserve = history.slice(-2)  // últimos 2 turnos literal
    const toSummarize = history.slice(1, -2)
    const summary = await this._summarize(toSummarize, ctx)
    return [history[0], { role: 'system', content: `[Resumen de ${toSummarize.length} mensajes previos]\n${summary}` }, ...preserve]
  }
}

async _summarize(messages, { providerRouter, modelTier }) {
  const model = providerRouter.resolveModelForTier('cheap')  // Fase 7.5 instala esto
  return await providerRouter.chat({
    model,
    messages: [
      { role: 'system', content: 'Resumí la siguiente conversación preservando decisiones tomadas, archivos modificados, tools usadas y preferencias declaradas por el usuario. Máximo 500 tokens.' },
      ...messages
    ],
    maxTokens: 600,
    source: 'reactive_compact'  // para Fase 7.5 elija cache TTL 5min
  })
}
```

**Circuit breaker (crítico — de Claude Code)**:

```js
export class ReactiveCompactor extends ContextCompactor {
  constructor({ maxFailures = 3, ...opts }) {
    super()
    this.failures = new Map()  // chatId → count
    this.maxFailures = maxFailures
  }

  async compact(history, ctx) {
    const chatId = ctx.chatId
    if ((this.failures.get(chatId) ?? 0) >= this.maxFailures) {
      this.eventBus.emit('compact:circuit_open', { chatId })
      throw new CompactCircuitOpenError(chatId)
    }
    try {
      const result = await this._doCompact(history, ctx)
      this.failures.set(chatId, 0)  // reset on success
      return result
    } catch (err) {
      this.failures.set(chatId, (this.failures.get(chatId) ?? 0) + 1)
      throw err
    }
  }
}
```

**Por qué el circuit breaker importa**: si por un bug la compactación falla 100 veces seguidas, cada fallo llamó a Haiku con un historial grande. Eso son millones de tokens quemados sin valor. 3 fallos seguidos → el chat queda en modo "contexto lleno, no podés seguir" y el usuario tiene que empezar nuevo chat manualmente. Costo acotado.

**Detección de overflow por patrones de error** (inspirado en OpenCode):

```js
// core/compact/overflowDetection.js
const OVERFLOW_PATTERNS = [
  /prompt is too long/i,                  // Anthropic
  /exceeds the context window/i,          // OpenAI
  /maximum context length is \d+/i,       // xAI
  /context_length_exceeded/i,             // OpenAI code
  /input length and `max_tokens` exceed/i, // Anthropic específico
  /reduce the length of the messages/i,   // OpenAI
  // ... agregar más según veas en producción
]

export function isOverflowError(error) {
  const msg = error.message ?? String(error)
  return OVERFLOW_PATTERNS.some(p => p.test(msg))
}
```

Al catchear un error de provider en `LoopRunner`, si `isOverflowError(err)` → trigger compactación reactiva con agresividad 2 y reintentar. Claude Code hace esto con `parseMaxTokensContextOverflowError` que además calcula el nuevo `maxTokens` restante.

**Referencia verificable en OpenCode**: `C:/Users/padil/Documents/wsl/opencode/packages/opencode/src/provider/error.ts` (los 20+ patterns que usan).

**Flag**: `REACTIVE_COMPACT_ENABLED=false` por default.

**Tests**:
- usage < 75% → no compacta.
- usage 80% → llama a MicroCompactor.
- usage 92% → resumen con Haiku, preserva system + 2 últimos.
- 3 fallos seguidos → circuit open, 4º intento lanza `CompactCircuitOpenError`.
- Error de provider que matchea overflow → compactación + retry (test con mock provider que devuelve overflow).

---

### 3.4 — Cache break detection

**Objetivo**: saber cuándo se rompe el cache de prompt (Anthropic) y emitir evento. Preparación para Fase 7.5 donde se usa.

**Qué hacer**:

```js
// providers/anthropic.js — después de recibir response
const usage = response.usage
const cacheStats = {
  creation: usage.cache_creation_input_tokens ?? 0,
  read: usage.cache_read_input_tokens ?? 0,
  regular: usage.input_tokens ?? 0
}

this.emit('cache_stats', cacheStats)

// Detección de miss inesperado:
if (expectedCacheHit && cacheStats.read === 0 && cacheStats.creation > MIN_CACHE_MISS_TOKENS) {
  this.emit('cache:miss', {
    provider: 'anthropic',
    expected: 'hit',
    creationTokens: cacheStats.creation,
    cause: inferCauseFromDiff(previousPrompt, currentPrompt)  // opcional, heurística simple
  })
}
```

`MIN_CACHE_MISS_TOKENS = 2000` (de Claude Code) — variaciones menores son normales, sólo alertar si el miss es sustancial.

**Por qué importa**: en Fase 7.5 vas a agregar métricas `cache_hit_rate`. Sin detección, no tenés cómo saber si el cache está funcionando.

**Criterio**: en un chat con system cacheable, el 2º turno emite `cache_stats` con `read > 0`. Si cambiás el system entre turnos, se emite `cache:miss`.

---

### 3.5 — CompactorPipeline (orquestador)

**Por qué**. Tenés 3 compactors (Sliding window, Micro, Reactive). El `ConversationService` no debería conocer a los 3 — debería hablar con un solo `CompactorPipeline` que decide cuál correr.

```js
// server/core/compact/CompactorPipeline.js
export class CompactorPipeline {
  constructor({ compactors, hookRegistry, metricsService }) {
    this.compactors = compactors  // array ordenado: [reactive, micro, sliding]
    this.hookRegistry = hookRegistry
    this.metrics = metricsService
  }

  async maybeCompact(history, ctx) {
    for (const c of this.compactors) {
      if (c.shouldCompact({ ...ctx, history })) {
        const before = history.length
        const start = Date.now()
        const newHistory = await c.compact(history, { ...ctx, hookRegistry: this.hookRegistry })
        this.metrics.record('compact_applied', {
          compactor: c.constructor.name,
          before,
          after: newHistory.length,
          durationMs: Date.now() - start
        })
        return newHistory
      }
    }
    return history
  }
}
```

**Orden recomendado**: reactive (más agresivo, gana si se dispara) → micro → sliding (fallback legacy). El primero que devuelve `shouldCompact=true` gana; los siguientes no corren en ese turno.

---

### 3.6 — MetricsService (ajuste de revisión)

**Por qué**. Necesitás emitir métricas de compactación, cache, token usage, etc. Pero esto no va dentro de providers ni dentro de compactors. Va en un servicio propio que todos escriben y un endpoint `/api/metrics/tokens` lee.

```js
// server/core/MetricsService.js
export class MetricsService {
  constructor({ db }) {
    this.db = db  // tabla metrics_events
  }

  record(event, payload) {
    this.db.prepare(`INSERT INTO metrics_events (event, payload_json, at) VALUES (?, ?, ?)`)
      .run(event, JSON.stringify(payload), Date.now())
  }

  async summarize({ chatId, from, to }) {
    // agregados: input/output/cached tokens, compact count, cache_hit_rate
  }
}
```

Schema:

```sql
CREATE TABLE metrics_events (
  id INTEGER PRIMARY KEY,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_metrics_event_at ON metrics_events(event, at);
```

Eventos iniciales que importan (más vendrán en Fase 7.5):
- `compact_applied` — desde CompactorPipeline
- `compact_skipped` — cuando `shouldCompact` fue false en todos
- `cache_hit` / `cache_miss` — desde providers
- `tool_search_performed` — desde ToolCatalog cuando el modelo usa `tool_search`
- `tool_load_performed` — ídem con `tool_load`

**Criterio**: después de 1 conversación de 20 turnos, `/api/metrics/tokens?chatId=X` devuelve totales coherentes.

---

## 4. Cómo integrar todo en ConversationService

Punto de integración (pseudo):

```js
// server/services/ConversationService.js (simplificado)
async _processApiProvider(ctx) {
  let history = structuredClone(ctx.history)

  // 1. Compactar si hace falta ANTES de mandar
  history = await this.compactorPipeline.maybeCompact(history, ctx)

  // 2. Hook chat.params para permitir mutación de params
  const paramsResult = await this.hookRegistry.emit('chat.params', { userId, chatId, params: ctx.defaultParams })
  const params = paramsResult.replace?.params ?? ctx.defaultParams

  // 3. Build system prompt con ToolCatalog (sólo metadata si lazy)
  const toolsForPrompt = this.toolCatalog.getMetadataIndex(ctx.agentDef)
  const systemPrompt = this.buildSystemPrompt({ ...ctx, tools: toolsForPrompt })

  // 4. Correr el loop
  return this.loopRunner.run({ ...ctx, history, params, systemPrompt, toolCatalog: this.toolCatalog })
}
```

---

## 5. Checklist de cierre de Fase 7

Antes de decir "Fase 7 hecha":

- [ ] `docs/fase-7-investigacion.md` committeado con números reales.
- [ ] `core/ToolCatalog.js` creado, testeado, integrado en LoopRunner.
- [ ] Tools `tool_search` y `tool_load` (separadas) registradas en el toolset del modelo.
- [ ] `core/compact/ContextCompactor.js` (interface) + 3 implementaciones (micro, reactive, sliding).
- [ ] `core/compact/CompactorPipeline.js` orquesta.
- [ ] `core/compact/overflowDetection.js` con al menos 5 patterns probados.
- [ ] Circuit breaker activo por default (`COMPACT_CIRCUIT_BREAKER=true`).
- [ ] `core/MetricsService.js` registrando al menos 4 tipos de eventos.
- [ ] Endpoint `GET /api/metrics/tokens?chatId=&from=&to=`.
- [ ] Cache stats emitidos desde Anthropic provider (mínimo viable para 7.5).
- [ ] Env vars documentados en el README o `.env.example`.
- [ ] Todos los tests verdes, incluyendo los de Fase 6 (no romper nada).
- [ ] Medición: en el escenario de 20 turnos del `docs/fase-7-investigacion.md`, system prompt reducido ≥40% con `LAZY_TOOLS_ENABLED=true`.

## 6. Flags a dejar (default conservador, off)

```env
LAZY_TOOLS_ENABLED=false
ENABLE_LAZY_TOOLS=auto           # auto-activación por % context
ALWAYS_VISIBLE_TOOLS=read_file,bash,tool_search,tool_load
MICROCOMPACT_ENABLED=false
MICROCOMPACT_EVERY_TURNS=10
MICROCOMPACT_KEEP_LAST_K=4
REACTIVE_COMPACT_ENABLED=false
AUTOCOMPACT_BUFFER_TOKENS=13000
COMPACT_CIRCUIT_BREAKER=true
MAX_CONSECUTIVE_COMPACT_FAILURES=3
```

## 7. Lo que NO hacés en Fase 7 (es Fase 7.5)

No te desvíes. Fase 7.5 se encarga de:
- Model tiers por provider (`modelTiers.js`)
- Routing al tier `cheap` para las compactaciones
- TTL dual 5m/1h
- Haiku hardcodeado → `resolveModelForTier(provider, 'cheap')`

En Fase 7, cuando necesites el modelo cheap (por ejemplo en `ReactiveCompactor._summarize`), **dejá un TODO explícito** o usá una variable de entorno `COMPACT_MODEL=claude-haiku-4-5` (hardcode temporal). En Fase 7.5 lo reemplazás por la llamada a `resolveModelForTier`.

## 8. Patrones para copiar literalmente (referencias verificables)

Si querés ver cómo se hace algo, estos paths existen y son confiables:

| Patrón | Path |
|---|---|
| Tool registry con lazy | `C:/Users/padil/Documents/wsl/opencode/packages/opencode/src/tool/registry.ts` |
| Overflow detection con patterns | `C:/Users/padil/Documents/wsl/opencode/packages/opencode/src/provider/error.ts` |
| Plugin hooks tipados (`chat.params`, `experimental.session.compacting`) | `C:/Users/padil/Documents/wsl/opencode/packages/plugin/src/index.ts` |
| Session storage con Drizzle | `C:/Users/padil/Documents/wsl/opencode/packages/opencode/src/session/` |
| Compaction en OpenCode | `C:/Users/padil/Documents/wsl/opencode/packages/opencode/src/session/compaction.ts` |

De Claude Code (src-extracted/, si tu agente tiene acceso a ese repo):

| Patrón | Path |
|---|---|
| Microcompact con cache_edits | `src-extracted/src/services/compact/microCompact.ts` |
| AutoCompact con circuit breaker | `src-extracted/src/services/compact/autoCompact.ts` |
| ToolSearch con deferred loading | `src-extracted/src/tools/ToolSearchTool/ToolSearchTool.ts` |
| Cache break detection | `src-extracted/src/services/api/promptCacheBreakDetection.ts` |
| Clasificación de errores en buckets | `src-extracted/src/utils/errors.ts` |

---

## 9. Errores típicos que vas a cometer y cómo evitarlos

1. **Hacer `tool_search` con union `{query|select}` en vez de dos tools separadas.** Más ambiguo para el modelo, más pena para debuggear. Hazlo con dos tools desde el principio.

2. **Resumir con Sonnet porque "es lo que tenemos configurado".** No — dejá un TODO pero idealmente ya dejalo routeable por tier. Fase 7.5 lo formaliza, pero no hardcodees Sonnet — hardcodea Haiku como default con env var override.

3. **Tirar mensajes viejos sin resumir.** Eso es el sliding window actual. MicroCompactor **no tira** — reemplaza contenido por placeholder preservando metadata. Es distinto.

4. **Romper el cache con cada compactación.** Es inevitable hasta Fase 7.5 (que formaliza TTL dual). Pero dejá el hook `pre_compact`/`post_compact` emitiendo para que Fase 7.5 pueda engancharse y re-warmear.

5. **Hacer el MetricsService demasiado ambicioso.** En Fase 7 sólo 4-6 eventos. Fase 7.5 suma los demás (cache_hit_rate, tier_usage, token_breakdown). Resistí la tentación de hacer todo ahora.

6. **Aplicar compactación reactiva al historial de un subagente sin pensar.** Los subagentes de Fase 5 tienen historial corto y descartable. Compactarlos no vale la pena. Chequeá `ctx.isSubagent === true` y bypassá.

---

## 10. Cómo reportar que terminaste

1. Cada ajuste 6.x es un commit propio: `refactor(hooks): 6.1 plugin pattern for executors`, etc.
2. Cada sección principal de Fase 7 (ToolCatalog, CompactorPipeline, MetricsService) un commit o PR propio.
3. PR final de Fase 7 incluye:
   - Link a `docs/fase-7-investigacion.md`
   - Tabla con métricas antes/después de los 3 escenarios del doc de investigación
   - Checklist del §5 marcado.
   - Notas de lo que quedó para Fase 7.5.

---

## 11. Resumen ultra corto

- Hacé 6.1–6.7 primero (ajustes pequeños, commits separados).
- Investigación previa obligatoria (§3.0) antes de tocar código de Fase 7.
- `ToolCatalog` + tools `tool_search`/`tool_load` separadas.
- 3 compactors con interface común + `CompactorPipeline`.
- Circuit breaker en reactive (3 fallos).
- Overflow detection por regex (20 patterns de OpenCode).
- Cache stats emitidos para que Fase 7.5 los use.
- MetricsService mínimo viable.
- No toques tier routing — eso es 7.5.

Todo detrás de flags con default conservador. El sistema funciona igual si los flags están off (cero regresión).

Buena suerte. Si tenés dudas sobre una decisión, preguntá antes de codear — es más barato que deshacer.
