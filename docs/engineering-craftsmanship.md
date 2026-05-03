> Última actualización: 2026-04-18

# Craftsmanship de ingeniería — cómo trabaja un equipo senior

Este documento existe porque hay una diferencia concreta entre código que **funciona** y código que **sobrevive en producción con múltiples desarrolladores durante años**. Clawmint se benefició hasta ahora de un desarrollo enfocado de una sola persona; a medida que crece, necesita adoptar la mentalidad y técnicas que usan equipos senior (como el que construye Claude Code en Anthropic).

La filosofía está en [philosophy.md](./philosophy.md) (el por qué). Las reglas estrictas en [development-rules.md](./development-rules.md) (el qué no hacer). Este documento cubre las **técnicas, estrategias y mentalidad** (el cómo pensar) — derivadas de la investigación directa del código fuente de Claude Code v2.1.88.

No es una lista para memorizar. Es un marco de referencia para re-leer cuando estés por tomar una decisión técnica — para hacerte las preguntas que un ingeniero senior se hace.

---

## Índice

1. [Mentalidad: los shifts clave](#1-mentalidad-los-shifts-clave)
2. [Técnicas de código](#2-técnicas-de-código)
3. [Técnicas de producción 24/7](#3-técnicas-de-producción-247)
4. [Estrategias arquitectónicas](#4-estrategias-arquitectónicas)
5. [Anti-patrones a evitar conscientemente](#5-anti-patrones-a-evitar-conscientemente)
6. [Aplicación gradual a Clawmint](#6-aplicación-gradual-a-clawmint)

---

## 1. Mentalidad: los shifts clave

Siete cambios de mentalidad que diferencian junior de senior. Ninguno es técnica — son preguntas que se hace el ingeniero antes de escribir.

### 1.1 "¿Esto se entiende dentro de 6 meses por alguien que no soy yo?"

El junior escribe código que él entiende hoy. El senior escribe código que entiende alguien que nunca lo vio, en un momento en que el autor ya no recuerda por qué lo hizo. Esto cambia decisiones concretas: nombrar mejor, documentar decisiones (no implementación), definir tipos en los bordes, explicitar invariantes.

### 1.2 "¿Cuánto cuesta revertir esto si estaba equivocado?"

Ya está en [philosophy.md §4](./philosophy.md). Importa tanto que se repite: cada acción tiene un **blast radius**. Editar un archivo local: cero. Push a main: medio. Drop table en prod: infinito. El tiempo invertido en pensar reversibilidad es proporcional al blast radius, no al esfuerzo técnico de la acción.

### 1.3 "¿Qué pasa si esto falla en el peor momento?"

Código en demo corre 5 minutos. Código en producción corre 24/7 durante meses. En esos meses pasa todo: disconexión de red, SSH revocado, disco lleno, memory leak de una librería tercera, termino colgado, kernel matando procesos. El senior se pregunta para cada línea de I/O: **¿qué pasa si esto nunca retorna?**

### 1.4 "¿Estoy abstrayendo porque hace falta o porque me siento listo?"

La abstracción prematura es el error más caro que comete un junior ambicioso. Se crean 5 clases para algo que son 15 líneas repetidas. Regla concreta: si no tenés tres usos concretos hoy, no extraigas. Tres líneas parecidas son mejor que una abstracción que nadie entiende.

### 1.5 "¿Qué hipótesis estoy asumiendo y cómo las pruebo?"

Cuando un bug es difícil, el junior prueba cambios hasta que deja de fallar. El senior pregunta: **¿qué asumo que tal vez no es cierto?** Leer la doc de la librería, ver el código interno, inspeccionar el estado real. El fix viene de entender, no de iterar al azar.

### 1.6 "¿Estoy resolviendo el problema o el síntoma?"

Un test falla → el junior ajusta el test. El senior entiende por qué falla. Una request tarda mucho → el junior pone un timeout más largo. El senior busca el bottleneck. Los workarounds se acumulan; los root cause fixes eliminan problemas para siempre.

### 1.7 "¿Este cambio abre o cierra puertas futuras?"

Cada decisión afecta la flexibilidad del sistema mañana. Un campo `status: string` es flexible pero débil; un `status: 'active' | 'paused' | 'archived'` es estricto pero seguro. Un módulo con 3 dependencias explícitas es testeable; uno que importa globales es rígido. El senior prefiere la decisión que conserva opciones.

---

## 2. Técnicas de código

### 2.1 Tipos como documentación ejecutable

En Claude Code, los tipos **son el contrato**. Ejemplo real del código fuente:

```ts
// src-extracted/src/types/permissions.ts
export const PERMISSION_MODES = [
  'acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan', 'auto'
] as const satisfies readonly PermissionMode[]
```

El `as const satisfies` valida en **tiempo de compilación** que el array es compatible con el tipo esperado, y a la vez el array es el único lugar donde viven los valores válidos. Un junior pondría `string[]`; un senior hace que el compilador garantice exhaustividad.

**Aplicable a Clawmint**: donde hoy tenés `mode: string` (por ejemplo ask/auto/plan), convertirlo a discriminated union. Donde aceptás `any` porque "me da fiaca tipar", pagar el costo ahora y ahorrar 10 bugs futuros.

### 2.2 Jerarquía de errores con contexto

Claude Code tiene una jerarquía completa de clases de error:

```ts
class ClaudeError extends Error { ... }
class ConfigParseError extends Error {
  constructor(message, filePath, defaultConfig) { ... }  // Contexto extra
}
class ShellError extends Error {
  constructor(stdout, stderr, code, interrupted) { ... }  // interrupted distingue kill vs fail
}
class TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends Error {
  // El nombre defensivo obliga al autor a verificar que el mensaje no leakea datos
}
```

**El insight**: un `new Error('shell failed')` pierde toda la información útil. Un `new ShellError(stdout, stderr, code, interrupted)` deja al caller decidir si reintentar, mostrar al usuario, o fallar.

**Aplicable a Clawmint**: crear al menos estas clases:
- `ClawmintError` (base)
- `ProviderError` (con `provider`, `status`, `retryable`)
- `ToolExecutionError` (con `toolName`, `args`, `phase`)
- `ChannelError` (con `channel`, `chatId`, `cause`)

Clasificar errores permite `if (err instanceof ProviderError && err.retryable)` — lógica limpia en lugar de parsear strings.

### 2.3 Clasificación en buckets vs `instanceof` frágil

Minificación rompe `instanceof` a veces. Claude Code usa funciones de clasificación:

```ts
function classifyAxiosError(e: unknown): {
  kind: 'auth' | 'timeout' | 'network' | 'http' | 'other'
  status?: number
  message: string
}
```

Un solo lugar sabe cómo clasificar. Todo el resto del código pregunta: "¿es auth? ¿es timeout?". Cambio de implementación no propaga.

### 2.4 Retornos tempranos, guard clauses primero

```ts
// src-extracted/src/bridge/bridgeApi.ts
export function validateBridgeId(id: string, label: string): string {
  if (!id || !SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${label}: contains unsafe characters`)
  }
  return id
}
```

5 líneas. Casos inválidos primero, camino feliz después. Nada de `else`. Nada de anidar 3 niveles.

**Regla concreta**: si tu función tiene `if (condition) { ... } else { ... }`, casi siempre podés invertirla a `if (!condition) return/throw; ...`. Más legible.

### 2.5 Inmutabilidad en el borde de lectura

No todo el state tiene que ser inmutable (es caro). Lo que tiene que ser inmutable es **lo que ven los lectores**:

```ts
// src-extracted/src/utils/messageQueueManager.ts
const commandQueue: QueuedCommand[] = []  // mutable interno
let snapshot: readonly QueuedCommand[] = Object.freeze([])  // inmutable público

function notifySubscribers(): void {
  snapshot = Object.freeze([...commandQueue])  // regenera frozen snapshot
  queueChanged.emit()
}
```

Los consumidores reciben un array congelado. No pueden mutarlo ni por accidente ni a propósito. El módulo interno mantiene la eficiencia.

### 2.6 Factory functions en lugar de clases + imports globales

```ts
// src-extracted/src/bridge/bridgeApi.ts
type BridgeApiDeps = {
  baseUrl: string
  getAccessToken: () => string | undefined
  runnerVersion: string
  onAuth401?: (token: string) => Promise<boolean>
  // ... todas las dependencias explícitas
}

export function createBridgeApiClient(deps: BridgeApiDeps): BridgeApiClient {
  return {
    async registerBridgeEnvironment(...) {
      // usa deps.baseUrl, deps.getAccessToken(), etc.
    }
  }
}
```

Nada de `import { authService } from '../../authService'` dentro del método. Todo viene en `deps`. Testear es trivial (pasás mocks). Refactorizar es seguro (el compilador te dice si olvidaste algo).

### 2.7 Ciclos de dependencias rotos explícitamente

Claude Code tiene `src/types/` para **tipos puros sin lógica**. El comentario al inicio del archivo:

```ts
/**
 * Pure permission type definitions extracted to break import cycles.
 * This file contains only type definitions and constants with no runtime dependencies.
 */
```

Cuando dos módulos quieren importarse mutuamente, se extrae la parte compartida (los tipos) a un tercer lugar. Ambos importan del tercero, no entre sí.

**Tienen hasta una regla de linter custom** (`custom-rules/bootstrap-isolation`) para prevenir imports incorrectos en el bootstrap. Cuando hay que violarla, documentan el motivo exacto.

### 2.8 Invariantes documentados en el código

```ts
/**
 * Design invariant: for every string redirect target, EITHER isSimpleTarget
 * returns true OR hasDangerousExpansion returns true (never both false).
 * If you modify one, you MUST update the other to preserve this invariant.
 */
```

Esto no es un comentario decorativo — es **una advertencia al próximo editor**. Si rompés el invariante, rompés la seguridad. Numeran invariantes cuando hay varios (`invariant 1`, `invariant 4`) para referenciarlos desde otros comentarios y PRs.

### 2.9 Validación en runtime con Zod en los bordes

En todos los boundaries (API external, config files, cached data), Claude Code valida con Zod:

```ts
const CacheFileSchema = lazySchema(() =>
  z.object({ models: z.array(ModelCapabilitySchema()), timestamp: z.number() })
)

const parsed = CacheFileSchema().safeParse(rawJson)
if (parsed.success) {
  return parsed.data  // tipo seguro
} else {
  return null  // degradación graceful
}
```

Los schemas viven **junto al tipo que validan**, no en una carpeta `schemas/` separada. Cambio del tipo → cambio del schema en el mismo archivo.

### 2.10 Comentarios que documentan decisiones

Regla operativa: un comentario vale la pena solo si un lector **no puede deducirlo del código**.

Ejemplo real:

```ts
/**
 * GrowthBook gate for multi-session spawn modes.
 * Uses the blocking gate check so a stale disk-cache miss doesn't unfairly
 * deny access. The fast path (cache has true) is still instant; only the
 * cold-start path awaits the server fetch, and that fetch also seeds the
 * disk cache for next time.
 */
async function isMultiSessionSpawnEnabled(): Promise<boolean> {
  return checkGate_CACHED_OR_BLOCKING('tengu_ccr_bridge_multi_session')
}
```

2 líneas de código. 6 líneas de por qué. Porque la próxima persona va a preguntarse "¿por qué blocking y no cached?", y este comentario le ahorra 30 minutos de investigación.

Un comentario malo es `// Check if multi-session is enabled`. Es el nombre de la función con otras palabras.

---

## 3. Técnicas de producción 24/7

Software que corre todo el día durante meses enfrenta condiciones que no ves en desarrollo. Estos patrones los cubren.

### 3.1 Retries con inteligencia contextual

No todos los errores se reintentan igual. Claude Code distingue:

```ts
const FOREGROUND_529_RETRY_SOURCES = new Set([
  'repl_main_thread',  // usuario bloqueado esperando → reintentar
  'agent:custom',
  // NO incluye: 'summaries', 'classifiers', 'tokenSuggestion'
  // Estos fallan en silencio sin reintentar → no amplifican overload
])
```

**Retry por contexto**: si el usuario está esperando, reintenta. Si es una tarea en background, bail rápido. Un retry de background bajo overload = amplificación de carga que hace caer al sistema completo.

### 3.2 Exponential backoff con jitter

```ts
const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), maxDelayMs)
const jitter = Math.random() * 0.25 * baseDelay  // ±25% random
return baseDelay + jitter
```

Sin jitter, todos los clientes reintentan al mismo milisegundo después de un outage → **thundering herd**. Con jitter, las cargas se distribuyen.

### 3.3 Respetar `Retry-After` del servidor

Si el servidor te dice "esperá 1 hora", esperás. No reintentás en 2 segundos. Claude Code lee el header y, en modo persistent, chunifica la espera en bloques de 30s emitiendo heartbeat events para que el usuario vea "sigo vivo".

### 3.4 Todo I/O tiene timeout

Sin excepciones. `fetch`, DB query, llamada a MCP, spawn de child process — todo. Defaults razonables:

```ts
const DEFAULT_TIMEOUT_MS = 120_000  // 2 min
const MAX_TIMEOUT_MS = 600_000      // 10 min
```

Y **timeout cascade**: si la operación externa tiene timeout 60s, la operación que la llama tiene que tener > 60s. Si no, estás sobreescribiendo el timeout más bajo.

### 3.5 Cancelación end-to-end con AbortSignal

`AbortSignal` debe llegar desde el usuario (que presionó Ctrl+C) hasta la capa más profunda de I/O. Si en algún lado te olvidás de propagarlo, el botón "cancelar" no funciona realmente — la operación sigue consumiendo recursos hasta que termina.

Claude Code tiene `createCombinedAbortSignal()` para combinar múltiples signals + timeout en una sola señal, con cleanup garantizado:

```ts
const { signal, cleanup } = createCombinedAbortSignal(userSignal, { timeoutMs: 30_000 })
try {
  await api.call({ signal })
} finally {
  cleanup()  // elimina listeners, clearTimeout, evita leaks
}
```

### 3.6 Cleanup registry centralizado

No spargeas cleanup code en 10 lugares. Registrás callbacks en un registry central:

```ts
// src-extracted/src/utils/cleanupRegistry.ts
const cleanupFunctions = new Set<() => Promise<void>>()

export function registerCleanup(fn: () => Promise<void>): () => void {
  cleanupFunctions.add(fn)
  return () => cleanupFunctions.delete(fn)  // unregister
}

export async function runCleanupFunctions(): Promise<void> {
  await Promise.all(Array.from(cleanupFunctions).map(fn => fn()))
}
```

Cada módulo que abre recursos (MCP client, LSP server, DB, watchers) registra su cleanup al inicializarse. En shutdown, todos corren en paralelo. Nadie queda zombie.

### 3.7 Graceful shutdown con failsafe

SIGTERM/SIGINT/SIGHUP se interceptan:

```ts
process.on('SIGINT', () => gracefulShutdown(0))
process.on('SIGTERM', () => gracefulShutdown(143))  // 128 + 15 (SIGTERM)
process.on('SIGHUP', () => gracefulShutdown(129))   // 128 + 1 (SIGHUP)
```

Pero shutdown **con tiempo límite**:

```ts
const FAILSAFE_MS = Math.max(5000, hookBudget + 3500)
setTimeout(() => process.exit(exitCode), FAILSAFE_MS).unref()
```

Si un MCP externo cuelga en cleanup, el failsafe fuerza el exit después del presupuesto. El `.unref()` previene que el timer en sí mantenga el proceso vivo.

### 3.8 Terminal cleanup sincrónico antes del exit

```ts
writeSync(1, DISABLE_MOUSE_TRACKING)
writeSync(1, EXIT_ALT_SCREEN)
writeSync(1, SHOW_CURSOR)
```

Si el proceso muere mid-cleanup, al menos la terminal no queda rota. El `writeSync` garantiza que se escriba antes de seguir. Los async cleanups corren después — pero aunque ese async falle, la terminal ya está limpia.

### 3.9 Logs con contexto correlacional

No loggeás `"error happened"`. Loggeás:

```ts
logForDiagnostics('error', 'api_retry', {
  requestId: response.headers['x-request-id'],
  clientRequestId: localGeneratedUuid,  // sobrevive si no hay response
  attempt,
  durationMs,
  durationMsIncludingRetries,
  gateway: detectGateway(url),
  querySource,
})
```

Tiene `clientRequestId` generado localmente **antes** del request. Si el request nunca llega al server, igual tenés ID para correlacionar cliente y logs locales.

### 3.10 Métricas: no sólo contar, entender

Un junior cuenta "errores totales". El senior cuenta:

- `tengu_api_retry` con `{ attempt, delayMs, status, provider }` — cada retry es un data point
- `tengu_api_success` con `{ inputTokens, outputTokens, ttftMs, durationMs, durationMsIncludingRetries, attempt }` — latencia incluyendo retries vs sin ellos (muy distinto)
- `tengu_api_opus_fallback_triggered` — cuando se hace fallback a Sonnet

Esto permite responder preguntas como:
- ¿Qué porcentaje de requests "exitosos" son exitosos en el primer intento vs después de retries?
- ¿El fallback a Sonnet se está triggereando más después del último deploy?

### 3.11 Feature flags compile-time para dead code elimination

```ts
const VoiceProvider = feature('VOICE_MODE')
  ? require('../context/voice.js').VoiceProvider
  : ({ children }) => children
```

Cuando `VOICE_MODE` es `false` en el build, el bundler Bun **elimina completamente** el require. El código muerto nunca aparece en el bundle de usuarios que no usan voice.

Esto es distinto de un flag runtime (`if (config.voiceEnabled)`) — el código está igual ahí. Los flags compile-time son para features beta o que no todos los usuarios reciben.

### 3.12 Kill switches y cooldowns en caliente

Si Opus está sobrecargado, **fallback automático a Sonnet** sin redeploy:

```ts
// if (status === 529 && model === opus) { switchToSonnet(); logEvent('opus_fallback_triggered') }
```

Fast-mode cooldown: después de X errores 429, desactiva fast mode por 10-30 min. El usuario no nota — solo ve respuestas un poco más lentas hasta que el cooldown termina.

### 3.13 LRU cache para evitar memory leaks

Memoización sin límite = memory leak eventual. Claude Code usa `memoizeWithLRU`:

```ts
function memoizeWithLRU<Args, R>(fn, opts: { max: number }) {
  const cache = new LRUCache<string, R>({ max: opts.max })
  return (args: Args) => {
    const key = hash(args)
    if (cache.has(key)) return cache.get(key)!
    const result = fn(args)
    cache.set(key, result)
    return result
  }
}
```

El `max` limita la memoria. Cuando se llena, evict LRU. Nunca crece infinito.

### 3.14 TTL cache con stale-while-revalidate

```ts
if (cached && now - cached.timestamp > ttl && !cached.refreshing) {
  cached.refreshing = true
  Promise.resolve().then(() => refresh())  // background
  return cached.value  // stale, pero inmediato
}
```

Retorna el valor viejo sin bloquear, y refresca en background. Las latencias se mantienen bajas aunque el backing store esté lento.

### 3.15 Sanitización defensiva de Unicode

Los modelos LLM son vulnerables a **prompt injection vía Unicode** (caracteres zero-width, Tag characters invisibles). Claude Code sanitiza recursivamente:

```ts
while (current !== previous && iterations < MAX_ITERATIONS) {
  current = current.normalize('NFKC')
  current = current.replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, '')  // Format/control/private
  current = current.replace(/[\u200B-\u200F]/g, '')  // Zero-width
  iterations++
}
```

Recursivo hasta no encontrar más cambios. Con límite de iteraciones para evitar loops infinitos en payloads adversariales.

### 3.16 Validación shape de responses externas

No confiar en que el servidor devolvió lo esperado:

```ts
function isValidAPIMessage(value: unknown): value is BetaMessage {
  return typeof value === 'object' && value !== null
    && 'content' in value && Array.isArray((value as BetaMessage).content)
    && 'model' in value && typeof (value as BetaMessage).model === 'string'
    && 'usage' in value && typeof (value as BetaMessage).usage === 'object'
}
```

El TypeScript te dice que el response es de tipo `BetaMessage`, pero TypeScript **no existe en runtime**. Un servidor puede devolverte cualquier JSON. Si confiás sin validar, tu app crashea en un field access.

---

## 4. Estrategias arquitectónicas

### 4.1 Context object pattern (en lugar de 20 parámetros)

Las tools de Claude Code reciben un único `ToolUseContext`:

```ts
type ToolUseContext = {
  options: { commands, tools, mcpClients, agentDefinitions, ... }
  abortController: AbortController
  readFileState: FileStateCache
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  // ...15+ campos
}
```

Un tool firma como `execute(input, context)`. Cuando agregás un nuevo campo al context (digamos `metricsClient`), ningún tool existente se rompe — lo pueden empezar a usar gradualmente.

**Alternativa que evitan**: pasar 20 parámetros individuales. Cada nuevo parámetro requiere actualizar todos los callers.

### 4.2 Registry declarativo para extensibilidad

Agregar una tool nueva es declarativo:

```ts
const MyTool: Tool = {
  name: 'my-tool',
  description: 'Does X',
  inputSchema: MyToolInputSchema,
  execute: async (input, context) => { ... }
}
```

Sin decoradores, sin herencia, sin metaprogramming. Solo un objeto con la shape correcta. El tipo `Tool` documenta todo lo disponible.

Lo mismo para plugins, skills, hooks, providers. Todos siguen el mismo pattern: **un objeto que declara capacidades + una factory que lo registra**.

### 4.3 Capability declaration en lugar de type check

Antes de usar un provider, preguntás qué soporta:

```ts
const caps = getCapabilities('anthropic')
if (caps.supportsThinking) {
  // usar extended thinking
} else {
  // skip
}
```

No escribís `if (providerName === 'anthropic' || providerName === 'gemini')`. Ese código se rompe cuando agregás un nuevo provider. Las capabilities declaradas escalan.

**Aplicable a Clawmint**: ya está parcialmente en `providers/capabilities.js`. Expandirlo es trivial y alto ROI.

### 4.4 Convention over configuration

Los skills en Claude Code son archivos markdown con frontmatter YAML:

```markdown
---
hooks:
  session_start:
    - shell: "source venv/bin/activate"
      once: true
---

# My Skill
Instructions...
```

Sin boilerplate. El loader escanea el directorio, parsea frontmatter, registra hooks. El usuario no escribe código.

**Convención**: folders `commands/`, `agents/`, `skills/` se descubren automáticamente en plugins. Los plugins simplemente siguen la convención; nada configurar.

### 4.5 State management simple pero ergonómico

No usan Redux, Zustand, ni MobX. Usan:

```ts
function createStore<T>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<Listener>()

  return {
    getState: () => state,
    setState: (updater) => {
      const next = updater(state)
      if (Object.is(next, state)) return  // identity check, no-op
      state = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
```

30 líneas. Provee exactamente lo que necesitan: get, set, subscribe. Ninguna dependencia. React se conecta con `useSyncExternalStore`.

**Lección**: no agregues dependencias pesadas por "flexibilidad futura". Si una abstracción de 30 líneas te sirve, úsala.

### 4.6 Event buffering para registro eventual

Hooks emiten eventos antes de que el consumer se registre:

```ts
const pendingEvents: HookExecutionEvent[] = []
let eventHandler: HookEventHandler | null = null

export function registerHookEventHandler(handler): void {
  eventHandler = handler
  if (handler && pendingEvents.length > 0) {
    for (const event of pendingEvents.splice(0)) handler(event)
  }
}
```

Si los hooks se inicializan antes que el handler, los eventos se bufferizan (con tope de `MAX_PENDING_EVENTS = 100`). Cuando el handler se registra, procesa el backlog.

**Por qué**: evita race conditions en orden de inicialización. El módulo que emite no tiene que esperar al consumer. El consumer no pierde eventos tempranos.

### 4.7 Refactor continuo con re-exports

Cuando movés algo, no rompés callers. Hacés re-export durante la transición:

```ts
// src/state/AppState.tsx (archivo viejo)
// TODO: Remove these re-exports once all callers import directly from
// ./AppStateStore.js. Kept for back-compat during migration.
export { type AppState, type AppStateStore } from './AppStateStore.js'
```

1. Creás el archivo nuevo.
2. El viejo re-exporta del nuevo.
3. Migrás callers uno a uno (sin prisa).
4. Cuando todos migraron, borrás re-exports.

Nunca hay un "branch de refactor de 3 meses". Es trunk-based development con migración gradual.

### 4.8 Backwards compatibility aditivo

Tipos crecen por adición, no por modificación:

```ts
type BuiltinPluginDefinition = {
  name: string
  description: string
  skills?: BundledSkillDefinition[]
  hooks?: HooksSettings
  mcpServers?: Record<string, McpServerConfig>
  lspServers?: Record<string, LspServerConfig>  // ← nuevo, opcional
}
```

Plugins viejos que no definen `lspServers` siguen funcionando (`undefined` es válido). Plugins nuevos lo usan. Cero breaking.

### 4.9 Discriminated unions para errores tipados en UI

```ts
type PluginError =
  | { type: 'path-not-found'; source: string; path: string }
  | { type: 'git-auth-failed'; source: string; repo: string }
  | { type: 'plugin-not-found'; source: string; pluginId: string; marketplace: string }
```

El UI hace pattern matching seguro:

```ts
if (error.type === 'plugin-not-found') {
  return `Could not find ${error.pluginId} in ${error.marketplace}`
}
```

Agregar un tipo nuevo de error fuerza al compilador a marcar todos los `switch` no exhaustivos. Bugs imposibles.

### 4.10 Separación transporte/protocolo/aplicación

El bridge (CLI ↔ daemon remoto) no sabe de tools:

```ts
type BridgeConfig = {
  enabled: boolean
  connected: boolean
  reconnecting: boolean
}
```

Solo transporta mensajes. Cambiar tools no requiere cambiar bridge. Cambiar bridge (por ejemplo, HTTP → WebSocket) no requiere cambiar tools. Las capas son independientes.

---

## 5. Anti-patrones a evitar conscientemente

Cosas que parecen razonables pero un equipo senior evita.

### 5.1 `catch { }` silencioso

```ts
// MAL
try { await thing() } catch { }  // ¿por qué se tragó el error? ¿es esperado?

// BIEN
try {
  await thing()
} catch (err) {
  if (isExpectedError(err)) {
    logger.debug('thing() falló como esperábamos', { err })
  } else {
    throw err  // o logger.error + handle
  }
}
```

Cada `catch` responde a la pregunta: "¿qué significa este error específico y qué debe pasar?".

### 5.2 Abstracciones especulativas

```ts
// MAL
class AbstractMessageHandler<T extends BaseMessage> {
  abstract transform(msg: T): Promise<T>
  abstract validate(msg: T): boolean
  async process(msg: T): Promise<T> { ... }
}
// ... y hay una sola implementación concreta

// BIEN
function processMessage(msg: Message): Message {
  // directo, 10 líneas
}
```

Si hay un solo consumer, no abstraigas. Cuando aparezca el segundo, ahí decidís si abstraer o duplicar.

### 5.3 `any` en TypeScript

Cada `any` es una mentira al sistema de tipos. Si realmente no conocés la shape (respuesta de API externa), usá `unknown` y validá antes de usar.

### 5.4 Mágica con reflection / metaprogramming

Decoradores, `Proxy`, `Object.defineProperty` custom, eval dinámico. Parecen elegantes. Son una pesadilla para debuggear 6 meses después. Claude Code tiene mínimo de esto. Prefieren código explícito aunque sea más largo.

### 5.5 Configuración nested infinita

Un config con 6 niveles de nesting (`config.module.subsystem.feature.option.sub`) es ilegible. Aplanar con prefijos (`feature_option_sub`). Si no alcanza, repensar el módulo.

### 5.6 Inyección de globales disfrazada

```ts
// MAL
import { db } from '../../database'
class UserService {
  getUser(id) { return db.query(...) }  // ← "inyectado" vía import
}

// BIEN
class UserService {
  constructor(private db: Database) {}
  getUser(id) { return this.db.query(...) }
}
```

Lo primero es un singleton global escondido. Testear requiere mockear el módulo `../../database` (frágil). Lo segundo es trivial de testear.

### 5.7 Comentarios como sustituto de buen código

```ts
// MAL
// Iterate over users and filter the active ones
const result = []
for (const u of users) {
  if (u.status === 'active') result.push(u)
}

// BIEN
const activeUsers = users.filter(u => u.status === 'active')
```

El comentario arriba es pura duplicación. El código de abajo se lee solo.

### 5.8 Flags booleanos que explotan

```ts
// MAL
function render(text: string, bold: boolean, italic: boolean, size: 'sm'|'md'|'lg', align: 'left'|'center'|'right')

// BIEN
function render(text: string, style: TextStyle)
```

Más de 2-3 parámetros primitivos seguidos = objeto de config. Si no, cualquier reordenamiento accidental compila pero se comporta distinto.

### 5.9 Retry sin idempotencia

Reintentar un `POST /transfer` sin verificar si ya se ejecutó = duplicar transferencias. Antes de retry, pensar: **¿esto es idempotente?**. Si no, agregar idempotency key o cambiar estrategia.

### 5.10 Logs sin contexto

```ts
// MAL
logger.error('Request failed')

// BIEN
logger.error('API request failed', {
  url, method, status, attempt, durationMs, requestId, userId
})
```

Logs sin contexto son inútiles a las 3am. Logs con contexto son oro.

### 5.11 `TODO` sin fecha ni owner

Un `TODO: fix this later` sin nombre y fecha es deuda fantasma. Morirá en el código. Si realmente es importante, es issue tracker. Si no, borralo.

### 5.12 "Por si acaso" defensive code

```ts
// MAL (en función interna que solo recibe User del mismo módulo)
function greet(user: User): string {
  if (!user) return ''
  if (!user.name) return ''
  return `Hola ${user.name}`
}

// BIEN
function greet(user: User): string {
  return `Hola ${user.name}`
}
```

Si `User` nunca es null y siempre tiene `name` (garantizado por tipos y por el flujo), no validés. Estás mintiendo sobre la intención. Si algún día `User` puede ser null, el compilador te lo dice.

---

## 6. Aplicación gradual a Clawmint

Este documento no es un checklist para cumplir en 1 sprint. Es una dirección a navegar durante los próximos 6–12 meses, priorizando lo de más alto ROI primero.

### 6.1 Quick wins (esta semana)

- Crear jerarquía básica de errores en `server/utils/errors.js`: `ClawmintError`, `ProviderError`, `ToolExecutionError`, `ChannelError` con campos de contexto.
- Agregar timeouts explícitos a cada `fetch` o llamada a API externa. Default 120s. Ningún I/O sin timeout.
- Propagar `AbortSignal` desde `LoopRunner` hasta los providers (ya previsto en Fase 4).
- Matar magic numbers: scanear por `setTimeout(..., 30000)` y extraer a constantes con nombre (`IDLE_TIMEOUT_MS`).

### 6.2 Siguiente nivel (próximas 2–4 semanas)

- `CleanupRegistry` central en `server/core/`. Migrar cleanup de MCPs, sesiones PTY, watchers a registrarse ahí.
- Handler centralizado de `SIGTERM`/`SIGINT`/`SIGHUP` con failsafe timeout (5s después del presupuesto normal).
- `process.on('unhandledRejection')` y `process.on('uncaughtException')` loggeados con contexto (no silenciar, no crashear al toque — loggear y decidir).
- Validar con Zod (o equivalente) las respuestas de cada MCP externo antes de confiar.
- Reemplazar cada `catch { }` silencioso con una decisión explícita (log + re-throw, log + fallback, etc.).

### 6.3 Mediano plazo (Parte 2 del ROADMAP)

- `CompactorPipeline` con circuit breaker (ya previsto en Fase 7.5).
- `MetricsService` con eventos granulares (tengu-style): `tool:invoked`, `tool:succeeded`, `tool:failed`, `provider:retry`, `cache:hit`, etc. Payload con contexto causal (attempt, duration, source).
- Retry policy contextual: distinguir foreground (usuario esperando) de background (consolidator, summaries).
- Exponential backoff con jitter en `RetryPolicy` (Fase 4).
- Sanitización de Unicode en entrada de usuario (Telegram, WebChat) antes de mandar al modelo.

### 6.4 Largo plazo (post ROADMAP completo)

- `src/types/` vs `src/utils/` con regla de dependencia unidireccional. Considerar un lint rule custom si los ciclos vuelven.
- Factory functions inyectadas en lugar de imports globales en los módulos core (`ConversationService`, `AgentOrchestrator`, `ChannelRouter`).
- LRU caches con `max` explícito donde hoy hay memoization sin límite.
- Event buffering pattern para componentes con inicialización asíncrona (MCPs tardíos, providers remotos).
- Feature flags compile-time (vía bundler) para features experimentales que no tienen que pesar en el binario de todos.

### 6.5 Cambios de mentalidad (siempre)

Lo más barato de adoptar y lo más caro de ignorar:

- Antes de cada PR grande, preguntar las 7 preguntas del §1.
- En code review, buscar los anti-patrones del §5.
- Al debuggear, buscar root cause antes de cambiar de táctica (§1.6).
- Al abstraer, probar la regla de tres (§1.4).
- Al agregar features, preguntar "¿esto cierra puertas futuras?" (§1.7).

---

## Referencias

- [philosophy.md](./philosophy.md) — los por qués
- [development-rules.md](./development-rules.md) — las reglas concretas
- `server/ROADMAP.md` — plan técnico con fases aplicables
- `CLAUDE.md` (raíz) — referencia operativa para Claude asistente

---

## Apéndice: fuentes verificadas

El contenido de este documento fue extraído de investigación directa del código fuente de Claude Code v2.1.88, específicamente:

- `src-extracted/src/types/permissions.ts` — discriminated unions y `as const satisfies`
- `src-extracted/src/utils/errors.ts` — jerarquía de errores + `classifyAxiosError`
- `src-extracted/src/utils/messageQueueManager.ts` — frozen snapshots
- `src-extracted/src/bridge/bridgeApi.ts` — factory functions + DI explícita
- `src-extracted/src/utils/bash/commands.ts` — invariantes documentados + comentarios `SECURITY:`
- `src-extracted/src/services/api/withRetry.ts` — retry por contexto + exponential backoff + persistent mode
- `src-extracted/src/utils/timeouts.ts` — `createCombinedAbortSignal`
- `src-extracted/src/utils/cleanupRegistry.ts` — cleanup central
- `src-extracted/src/utils/gracefulShutdown.ts` — SIGTERM/SIGINT + failsafe + terminal cleanup
- `src-extracted/src/utils/sanitization.ts` — Unicode recursive sanitize
- `src-extracted/src/plugins/builtinPlugins.ts` — registry declarativo
- `src-extracted/src/Tool.ts` — `ToolUseContext`
- `src-extracted/src/utils/hooks/hookEvents.ts` — event buffering
- `src-extracted/src/state/store.ts` — minimalist store
- `src-extracted/src/utils/model/deprecation.ts` — deprecation paths con fechas por provider

Cuando se cita una función o archivo, existe en esa ruta al momento de la investigación (abril 2026).
