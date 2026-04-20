> Última actualización: 2026-03-17

# Módulos backend

Índice de módulos del servidor. Cada módulo tiene responsabilidad única y recibe sus dependencias por constructor (DI via `bootstrap.js`).

---

## Índice

| Módulo | Archivo fuente | Responsabilidad |
|--------|---------------|-----------------|
| [bootstrap](#bootstrap) | `server/bootstrap.js` | Hub de DI — único lugar que crea e inyecta deps |
| [index](#index) | `server/index.js` | HTTP, WebSocket, rutas REST, endpoint /mcp |
| [mcp](#mcp) | `server/mcp/` | MCP embebido: ShellSession + tools + JSON-RPC HTTP |
| [sessionManager](#sessionmanager) | `server/sessionManager.js` | Pool de sesiones PTY (node-pty) |
| [agents](#agents) | `server/agents.js` | CRUD de agentes |
| [skills](#skills) | `server/skills.js` | Skills locales + búsqueda ClawHub |
| [memory](#memory) | `server/memory.js` | Memoria persistente: SQLite + spreading activation |
| [memory-consolidator](#memory-consolidator) | `server/memory-consolidator.js` | Consolidación inteligente de notas |
| [providers](#providers) | `server/providers/index.js` | Factory de providers de IA |
| [provider-config](#provider-config) | `server/provider-config.js` | Configuración de providers (keys, modelos) |
| [ConversationService](#conversationservice) | `server/services/ConversationService.js` | Orquesta el envío de mensajes al agente correcto |
| [TelegramChannel](#telegramchannel) | `server/channels/telegram/TelegramChannel.js` | Bot Telegram completo (N bots) |
| [BaseChannel](#basechannel) | `server/channels/BaseChannel.js` | Interfaz abstracta de canal |
| [reminders](#reminders) | `server/reminders.js` | Recordatorios con delay |
| [mcps](#mcps) | `server/mcps.js` | Model Context Protocol registry (Smithery) |
| [transcriber](#transcriber) | `server/transcriber.js` | Audio → texto (faster-whisper) |
| [ClaudePrintSession](#claudeprintsession) | `server/core/ClaudePrintSession.js` | Wrapper de `claude -p` en modo streaming |
| [Logger](#logger) | `server/core/Logger.js` | Logger con hot-reload de config |
| [EventBus](#eventbus) | `server/core/EventBus.js` | EventEmitter global inyectable |
| [BotsRepository](#botsrepository) | `server/storage/BotsRepository.js` | Persistencia de bots en bots.json |
| [ChatSettingsRepository](#chatsettingsrepository) | `server/storage/ChatSettingsRepository.js` | Persistencia de settings de chat en SQLite |
| [DatabaseProvider](#databaseprovider) | `server/storage/DatabaseProvider.js` | Inicializa SQLite una sola vez |

---

## mcp

**Directorio:** `server/mcp/`

MCP (Model Context Protocol) Server embebido en el proceso Express. Expone herramientas con **estado de shell persistente** por conversación. Los providers API lo consumen directamente en-proceso (sin overhead de protocolo); Claude Code puede consumirlo vía HTTP.

### Estructura

```
server/mcp/
├── index.js          ← API pública: createMcpRouter, executeTool, getToolDefs
├── ShellSession.js   ← Map<shellId, bash> — cwd/env persisten entre llamadas
└── tools/
    ├── bash.js       ← herramienta bash con ShellSession
    ├── files.js      ← read_file, write_file, list_dir, search_files
    ├── pty.js        ← pty_write, pty_read (via sessionManager inyectado)
    └── index.js      ← all() + execute(name, args, ctx)
```

### ShellSession

Shell bash persistente por ID (`chatId`). El estado (cwd, variables de entorno) sobrevive entre llamadas.

```javascript
const { get } = require('./mcp/ShellSession');
const shell = get('chat-12345');
await shell.run('cd /tmp');
await shell.run('pwd');     // → /tmp  (persistió)
await shell.run('X=42');
await shell.run('echo $X'); // → 42   (persistió)
```

- Centinela único por comando: `__CLAWMINT_N__:$?`
- Cola serializa comandos (nunca en paralelo)
- Auto-destroy tras 30 min idle (`IDLE_TIMEOUT_MS`)
- Error de proceso → `this._destroyed = true`

### Herramientas disponibles

| Tool | Parámetros | Descripción |
|------|-----------|-------------|
| `bash` | `command`, `session_id?` | Shell persistente. Si `session_id` no se da, usa `ctx.shellId` |
| `read_file` | `path` | Lee archivo (máx 50 KB) |
| `write_file` | `path`, `content` | Escribe archivo, crea dirs intermedios |
| `list_dir` | `path?` | Lista directorio con tipo (file/dir) |
| `search_files` | `pattern`, `dir?` | Búsqueda por glob vía `find` |
| `pty_write` | `session_id`, `input` | Escribe a sesión PTY activa |
| `pty_read` | `session_id`, `since?` | Lee output PTY desde timestamp |

### API pública (`mcp/index.js`)

```javascript
const { createMcpRouter, executeTool, getToolDefs } = require('./mcp');

// Express router (JSON-RPC 2.0 en /mcp)
const router = createMcpRouter({ sessionManager, memory });
app.use('/mcp', router);

// En-proceso (usado por ConversationService)
const result = await executeTool('bash', { command: 'pwd' }, { shellId: 'chat-123' });

// Para construir tool schemas de providers
const defs = getToolDefs(); // → array de { name, description, params }
```

### HTTP endpoint MCP

`POST /mcp` — JSON-RPC 2.0. Protocolo: `2024-11-05`.

```bash
# Listar herramientas
curl -X POST http://localhost:3001/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Llamar una herramienta
curl -X POST http://localhost:3001/mcp \
  -H 'Content-Type: application/json' \
  -H 'x-shell-id: mi-sesion' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"bash","arguments":{"command":"cd /tmp && pwd"}}}'

# Para Claude Code
claude mcp add-json clawmint '{"type":"http","url":"http://localhost:3001/mcp"}'
```

Métodos soportados: `initialize`, `ping`, `tools/list`, `tools/call`, `notifications/initialized`.

---

## bootstrap

**Archivo:** `server/bootstrap.js`

Hub único de inyección de dependencias. Crea todos los componentes en orden y los wirrea. Idempotente.

**Orden de inicialización:**
1. `Logger` + `EventBus`
2. `memory.js` (auto-inicializa SQLite al requerirse)
3. `memory-consolidator` (recibe `db`)
4. `ChatSettingsRepository` (recibe `db`) + `BotsRepository`
5. Singletons de dominio: `sessionManager`, `agents`, `skills`, `reminders`, `providers`, `providerConfig`, `transcriber`, `mcps`
6. `ConversationService` (recibe todos los deps)
7. `TelegramChannel` (recibe repos + deps)

**Exporta:** `{ createContainer() → container }`

**Container:**
```javascript
{
  logger, eventBus, db, memory, consolidator,
  chatSettingsRepo, botsRepo,
  convSvc, telegramChannel,
  sessionManager, agents, skills, reminders,
  providers, providerConfig, mcps, transcriber
}
```

---

## index

**Archivo:** `server/index.js`

Punto de entrada del servidor. Responsabilidades:
- Montar Express + CORS + JSON body parser
- Inicializar WebSocket server
- Registrar todas las rutas REST (ver [api_contract/](../api_contract/README.md))
- Gestionar sesiones AI por WebSocket
- Llamar a `bootstrap.createContainer()` para obtener `telegramChannel` y `consolidator`
- Hacer `telegram.loadAndStart()` al arrancar

**Dependencias recibidas:** `sessionManager`, `agents`, `skills`, `events`, `memory`, `providerConfig`, `providers` (require directos), `telegramChannel` + `consolidator` (vía bootstrap).

---

## sessionManager

**Archivo:** `server/sessionManager.js`

Gestiona el pool de sesiones PTY. Cada `PtySession` spawna un proceso real con `node-pty`.

**API pública:**
```javascript
sessionManager.create({ type, command, cols, rows })  // → PtySession
sessionManager.get(id)                                 // → PtySession | undefined
sessionManager.list()                                  // → PtySession[]
sessionManager.destroy(id)                             // → boolean
```

**PtySession:**
```javascript
session.input(text)                    // escribe al PTY
session.resize(cols, rows)             // redimensiona
session.sendMessage(text, opts)        // envía + espera estabilización
session.onOutput(cb) → unsub           // suscripción push
session.getOutputSince(ts)             // pull desde timestamp
session.destroy()                      // mata el proceso
session.toJSON()                       // serialización
```

**Buffer circular:** máx 5000 entradas (overflow FIFO).

---

## agents

**Archivo:** `server/agents.js`

CRUD de agentes. Persiste en `server/agents.json`. Los archivos en `server/agents/` tienen prioridad.

**API pública:**
```javascript
agents.list()                          // [{key, command, description, prompt, provider?}]
agents.get(key)                        // agent | undefined
agents.add(key, command, desc, prompt, provider)  // agent
agents.update(key, changes)            // agent
agents.remove(key)                     // boolean
```

**Estructura de agente:**
```json
{
  "key": "mi-agente",
  "command": "claude",
  "description": "Descripción visible en UI",
  "prompt": "# System prompt\nEres un experto en...",
  "provider": "anthropic"
}
```

---

## skills

**Archivo:** `server/skills.js`

Gestiona skills locales e integra con ClawHub (repositorio público de skills).

**API pública:**
```javascript
skills.listSkills()                    // [{slug, name, description}]
skills.buildAgentPrompt(agentDef)      // string (prompt del agente + todos sus skills)
skills.searchClawHub(query)            // Promise<[{slug, name, description, score}]>
```

**Formato de skill** (`server/skills/<slug>/SKILL.md`):
```markdown
---
name: Nombre del Skill
description: Qué hace este skill
---

Instrucciones detalladas para el agente...
```

---

## memory

**Archivo:** `server/memory.js`

Sistema de memoria persistente por agente. La fuente de verdad es un conjunto de archivos Markdown por agente; SQLite indexa el contenido para búsqueda eficiente.

Ver documentación detallada en [database/schema.md](../database/schema.md).

**API pública:**
```javascript
// CRUD
memory.listFiles(agentKey)             // [{filename, size, updatedAt}]
memory.read(agentKey, filename)        // string | null
memory.write(agentKey, filename, content)
memory.append(agentKey, filename, content)
memory.remove(agentKey, filename)      // boolean

// Preferencias y señales
memory.getPreferences(agentKey)        // {signals, settings, topics}
memory.detectSignals(agentKey, text)   // {shouldNudge, signals}
memory.buildNudge(signals)             // string (instrucción para el LLM)

// Búsqueda e inyección en prompt
memory.buildMemoryContext(agentKey, msg, opts)  // string | Promise<string>
memory.spreadingActivation(agentKey, keywords)  // [{filename, title, score}]

// Operaciones desde output del LLM
memory.extractMemoryOps(text)          // {clean, ops: [{file, content, mode}]}
memory.applyOps(agentKey, ops)         // filenames[]

// Indexación
memory.indexNote(agentKey, filename)   // async
memory.indexAllNotes(agentKey?)        // async

// Visualización
memory.buildGraph(agentKey?)           // {nodes, links}

// DB
memory.getDB()                         // better-sqlite3 instance
memory.setDB(db)                       // inyección externa de DB
```

**Dependencias:** `better-sqlite3`, `fs`, `path`

---

## memory-consolidator

**Archivo:** `server/memory-consolidator.js`

Procesa la cola de consolidación (`consolidation_queue`) cada 2 minutos. Usa el LLM para resumir señales importantes y crear/actualizar notas de memoria.

**API pública:**
```javascript
consolidator.init(db)                  // inicializar con instancia SQLite
consolidator.enqueue(agentKey, chatId, turns, source)  // agregar a la cola
```

**Dependencias:** `memory.js`, `events.js`, `better-sqlite3`

---

## providers

**Archivo:** `server/providers/index.js`

Factory que registra y expone los providers de IA disponibles.

**Providers disponibles:**

| Nombre | Archivo | Modelo default | SDK |
|--------|---------|----------------|-----|
| `anthropic` | `providers/anthropic.js` | `claude-opus-4-6` | `@anthropic-ai/sdk` |
| `gemini` | `providers/gemini.js` | `gemini-2.0-flash` | `@google/genai` |
| `openai` | `providers/openai.js` | `gpt-4o` | `openai` |

**Interfaz de provider:**
```javascript
{
  name: string,
  label: string,
  defaultModel: string,
  models: string[],
  async *chat({ systemPrompt, history, apiKey, model, executeTool? })
  // yields: { type: 'text', text } | { type: 'done', fullText }
  //       | { type: 'tool_call', name, args } | { type: 'tool_result', name, result }
}
```

**`executeTool` inyectado:** los providers aceptan un ejecutor opcional. Si se pasa, lo usan en lugar del default `require('../tools').executeTool`. `ConversationService` inyecta este parámetro con el `shellId` del chat para que las herramientas mantengan estado de shell por conversación.

**API del factory:**
```javascript
providers.get(name)                    // provider | null
providers.list()                       // [provider]
```

---

## provider-config

**Archivo:** `server/provider-config.js`

Lee y guarda la configuración de providers. Prioridad de API keys: env var > `provider-config.json` > vacío.

**API pública:**
```javascript
providerConfig.getConfig()             // {default, providers: {name: {apiKey, model}}}
providerConfig.getApiKey(name)         // string
providerConfig.setProvider(name, {apiKey?, model?})
providerConfig.setDefault(name)
```

**Archivo de config** (`server/provider-config.json`):
```json
{
  "default": "claude-code",
  "providers": {
    "anthropic": { "apiKey": "", "model": "claude-opus-4-6" },
    "gemini":    { "apiKey": "", "model": "gemini-2.0-flash" },
    "openai":    { "apiKey": "", "model": "gpt-4o" }
  }
}
```

---

## ConversationService

**Archivo:** `server/services/ConversationService.js`

Desacopla el procesamiento de mensajes del canal de transporte. Enruta a `ClaudePrintSession` (provider `claude-code`) o al provider API correspondiente. Inyecta contexto de shell persistente en los providers.

**Constructor:** `{ sessionManager, providers, providerConfig, memory, agents, skills, ClaudePrintSession, consolidator, logger }`

**API pública:**
```javascript
convSvc.processMessage({
  chatId,
  agentKey,
  provider,       // 'claude-code' | 'anthropic' | 'gemini' | 'openai'
  model,          // null = default del provider
  text,
  history,        // historial para providers API
  claudeSession,  // instancia de ClaudePrintSession existente (null = nueva)
  claudeMode,     // 'auto' | 'ask' | 'plan'
  onChunk,        // callback(partialText) para streaming progresivo
  shellId,        // ID de shell persistente (default: String(chatId))
})
// → { text, history?, savedMemoryFiles?, newSession? }
```

**`shellId`:** cuando se pasa, `_processApiProvider` inyecta `executeTool` en el provider con este ID. Todos los llamados a la herramienta `bash` en la misma conversación comparten la misma shell (cwd/env persistentes). Default: `String(chatId)`.

---

## TelegramChannel

**Archivo:** `server/channels/telegram/TelegramChannel.js`

Extiende `BaseChannel`. Gestiona N bots Telegram simultáneos. Cada bot (`TelegramBot`) hace long polling independiente.

**Constructor:** recibe `botsRepo`, `chatSettingsRepo`, `convSvc` y todos los deps de dominio.

**Routing de mensajes en `TelegramBot._sendToSession`:**
1. Si el agente no es claude-based y no hay provider API → **ruta PTY** (sesión node-pty interactiva)
2. En cualquier otro caso → **`convSvc.processMessage()`** con `shellId: String(chatId)`
   - Animación de puntos mientras espera
   - `onChunk` con throttle de 1500ms edita el mensaje en vivo
   - Resultado enviado con botones post-respuesta ("Seguir", "Nueva conv", "Guardar en memoria")

**API pública:**
```javascript
channel.loadAndStart()                 // carga bots del repo y arranca polling
channel.start()                        // alias de loadAndStart()
channel.stop()                         // para todos los bots
channel.send(chatId, text)             // envía por el primer bot en ejecución
channel.addBot(key, token)             // agrega y arranca bot
channel.removeBot(key)                 // para y elimina bot
channel.startBot(key) / stopBot(key)
channel.getBot(key) / listBots()
channel.setBotAgent(key, agentKey)
channel.saveBots()
channel.linkSession(key, chatId, sessionId)
channel.disconnectChat(key, chatId)
```

**Handlers inyectados** (en `channels/telegram/`):
- `CommandHandler.js` — todos los `/comandos`
- `CallbackHandler.js` — botones inline (callback queries)
- `PendingActionHandler.js` — flujos de acción pendiente (whitelist, skill search)

**Comandos Telegram disponibles:**

| Comando | Descripción |
|---------|-------------|
| `/start` | Saludo e inicio de sesión |
| `/nueva` | Nueva conversación (resetea contexto) |
| `/modelo [nombre]` | Ver o cambiar modelo de IA |
| `/agentes` | Listar agentes disponibles |
| `/<key>` | Activar agente de rol |
| `/basta` | Desactivar agente de rol |
| `/skills` | Ver skills instalados |
| `/buscar-skill` | Buscar e instalar skills de ClawHub |
| `/estado` | Estado de la sesión actual |
| `/costo` | Costo acumulado de la sesión (claude-code) |
| `/memoria` | Ver archivos de memoria del agente activo |
| `/status-vps` | CPU, RAM y disco del servidor |
| `/ls [path]` | Navegar el sistema de archivos |
| `/dir [path]` | Alias de `/ls` |
| `/cat [archivo]` | Ver contenido de archivo |
| `/mkdir [path]` | Crear directorio |
| `/monitor` | Estado de procesos del sistema |
| `/mcps` | Ver MCPs instalados |
| `/recordar [tiempo] [texto]` | Crear recordatorio (ej: `/recordar 30m llamar a Juan`) |
| `/recordatorios` | Listar recordatorios activos |
| `/id` | Ver el chat ID actual |

**Routing de mensajes (precedencia del provider):**
1. `chatSettings.provider` — seleccionado por el usuario para ese chat
2. `agent.provider` — provider del agente activo
3. `'claude-code'` — default global

---

## BaseChannel

**Archivo:** `server/channels/BaseChannel.js`

Interfaz abstracta para canales de mensajería. Permite agregar Discord, HTTP, etc. sin tocar el núcleo.

```javascript
class BaseChannel {
  constructor({ eventBus, logger }) {}
  async start()                        // conectar al proveedor
  async stop()                         // desconectar
  async send(destination, text)        // enviar mensaje
  toJSON()                             // estado serializable
}
```

---

## reminders

**Archivo:** `server/reminders.js`

Sistema de recordatorios con duración. Persiste en `server/reminders.json`.

**API pública:**
```javascript
reminders.add(chatId, botKey, text, durationMs)     // → reminder
reminders.remove(id)                                 // boolean
reminders.listForChat(chatId)                        // [reminder]
reminders.popTriggered()                             // [reminder] (elimina los devueltos)
reminders.parseDuration("10m" | "1h30m" | "2d")     // ms | null
reminders.formatRemaining(ms)                        // "1h 30m"
```

---

## mcps

**Archivo:** `server/mcps.js`

Gestión del registro de Model Context Protocols. Permite instalar MCPs desde Smithery y sincronizarlos con la CLI de Claude.

**API pública:**
```javascript
mcps.list()                            // [{name, type, command, ...}]
mcps.get(name)                         // mcp | null
mcps.add({name, type, command, args, env, url, description})
mcps.update(name, changes)
mcps.remove(name)
mcps.sync(name)                        // ejecuta `claude mcp add-json`
mcps.unsync(name)                      // ejecuta `claude mcp remove`
mcps.syncAll()                         // sincroniza todos los habilitados
mcps.searchSmithery(query, limit)      // Promise<[...]>
mcps.installFromRegistry(qualifiedName)  // Promise<{mcp, envVarsRequired}>
```

---

## transcriber

**Archivo:** `server/transcriber.js`

Transcripción de audio a texto usando faster-whisper (Python).

**API pública:**
```javascript
transcriber.httpsDownload(url, destPath)   // Promise<path>
transcriber.transcribe(filePath, opts)      // Promise<string>
```

**Configuración:**
- Python bin: `~/.venvs/whisper/bin/python3`
- Modelo: `medium`
- Dispositivo: `cpu` (int8)
- Idioma: `es`

---

## ClaudePrintSession

**Archivo:** `server/core/ClaudePrintSession.js`

Wrapper de `claude -p --output-format stream-json` en modo no interactivo. Mantiene el contexto de conversación (multi-turn via `--continue`). Timeout de 18 minutos por mensaje.

**Constructor:** `{ permissionMode: 'auto' | 'ask' | 'plan' }`

**API pública:**
```javascript
session.sendMessage(text, onChunk)     // Promise<string>
session.messageCount                   // número de mensajes enviados
session.lastCost                       // costo estimado en USD
session.lastModel                      // modelo usado
session.sessionId                      // ID de sesión Claude
```

---

## Logger

**Archivo:** `server/core/Logger.js`

Logger con persistencia en archivo y hot-reload de configuración (sin reinicio).

**Constructor:** `{ logFile?, configFile? }`

**API pública:**
```javascript
logger.info(...args)
logger.warn(...args)
logger.error(...args)       // siempre se loguea aunque logging esté desactivado
logger.getConfig()          // {enabled}
logger.setConfig(cfg)       // actualiza config
logger.tail(n)              // → string[] (últimas n líneas)
logger.clear()              // limpia el log
```

---

## EventBus

**Archivo:** `server/core/EventBus.js`

Thin wrapper sobre `EventEmitter`. Reemplaza al singleton `events.js`.

```javascript
const eventBus = new EventBus();
eventBus.emit('telegram:session', { sessionId, from, text });
eventBus.on('telegram:session', handler);
```

---

## BotsRepository

**Archivo:** `server/storage/BotsRepository.js`

Persistencia de bots en `bots.json`.

**Constructor:** `(botsFilePath)`

**API pública:**
```javascript
botsRepo.read()                        // [{key, token, defaultAgent, whitelist, ...}]
botsRepo.save(bots)                    // void
```

Si `bots.json` no existe y hay `BOT_TOKEN` en env, crea el archivo automáticamente.

---

## ChatSettingsRepository

**Archivo:** `server/storage/ChatSettingsRepository.js`

Persistencia de proveedor/modelo seleccionado por chat en SQLite.

**Constructor:** `(db)` — recibe instancia `better-sqlite3`

**API pública:**
```javascript
chatSettingsRepo.init()                // CREATE TABLE IF NOT EXISTS
chatSettingsRepo.load(botKey, chatId)  // {provider, model} | null
chatSettingsRepo.save(botKey, chatId, {provider, model})
```

**Tabla:** `chat_settings` — ver [database/schema.md](../database/schema.md)

---

## DatabaseProvider

**Archivo:** `server/storage/DatabaseProvider.js`

Inicializa SQLite una sola vez y comparte la instancia. Actualmente no se usa desde `bootstrap.js` (memory.js aún gestiona su propia DB internamente); está disponible para uso futuro.

**Constructor:** `(dbPath)`

**API pública:**
```javascript
dbProvider.init(schema)                // → better-sqlite3 instance
dbProvider.getDB()                     // → instance | null
```

---

## InvitationsRepository

**Archivo:** `server/storage/InvitationsRepository.js`

Invitaciones de un solo uso para onboarding familiar (Fase A). Códigos hex random 32 chars con TTL configurable, soft-revoke, cleanup automático.

**Constructor:** `(db)`

**API pública:**
```javascript
invitationsRepo.init()                                    // CREATE TABLE
invitationsRepo.create(createdBy, { ttlMs, role, familyRole })
                                                          // → { code, ... }
invitationsRepo.get(code)                                 // → row | null
invitationsRepo.getStatus(invitation)                     // 'valid'|'used'|'expired'|'revoked'
invitationsRepo.markUsed(code, userId)                    // → bool atómico
invitationsRepo.revoke(code)                              // soft-revoke
invitationsRepo.list({ createdBy? })                      // con `status` derivado
invitationsRepo.cleanup()                                 // borra usadas >30d, expiradas >7d
```

**Tabla:** `invitations` — ver [database/schema.md](../database/schema.md).

Consumido por `AuthService.register()` cuando recibe `inviteCode` en `opts`.

---

## HouseholdDataRepository

**Archivo:** `server/storage/HouseholdDataRepository.js`

Datos compartidos del hogar (Fase B): mercadería, eventos familiares, notas, servicios, inventario. Tabla flexible con `kind` discriminado.

**Constructor:** `(db)`

**API pública:**
```javascript
householdRepo.init()                                                 // CREATE TABLE + 3 índices
householdRepo.create({ kind, title, data, dateAt, alertDaysBefore, createdBy })
                                                                     // → row con id uuid
householdRepo.get(id)                                                // → row hidratada (data parseada)
householdRepo.update(id, fields, updatedBy)                          // bool. allowed: title, date_at, alert_days_before, completed_at, data
householdRepo.complete(id, updatedBy)                                // shortcut: marca completed_at = now
householdRepo.uncomplete(id, updatedBy)                              // resetea completed_at
householdRepo.remove(id)                                             // hard delete
householdRepo.list(kind, { includeCompleted, upcomingOnly, limit })  // ordenada por COALESCE(date_at, created_at)
householdRepo.upcomingAlerts(daysWindow=7)                           // items con date_at en ventana
householdRepo.counts()                                               // { kind: { total, pending } }
```

**Tabla:** `household_data` — ver [database/schema.md](../database/schema.md).

Consumido por:
- 18 MCP tools en `mcp/tools/household.js` (`grocery_*`, `family_event_*`, `house_note_*`, `service_*`, `inventory_*`, `household_summary`).
- REST `routes/household.js` (`/api/household/:kind` CRUD + complete/uncomplete + summary + upcoming).

---

## SystemConfigRepository

**Archivo:** `server/storage/SystemConfigRepository.js`

Key/value global persistente para config sin `.env`. Soporta cifrado opcional via `TokenCrypto` para secrets.

**Constructor:** `({ db, tokenCrypto?, logger? })`

**API pública:**
```javascript
systemConfigRepo.init()                            // CREATE TABLE
systemConfigRepo.get(key)                          // → string | null (plain)
systemConfigRepo.set(key, value)                   // value plano
systemConfigRepo.setSecret(key, plaintext)         // cifrado con TokenCrypto
systemConfigRepo.getSecret(key)                    // descifrado
systemConfigRepo.remove(key)
systemConfigRepo.listKeys()                        // [{ key, is_secret, updated_at }]
systemConfigRepo.listByPrefix('oauth:google:')     // dict { key: value } (descifra secrets)
```

**Tabla:** `system_config` — ver [database/schema.md](../database/schema.md).

Consumido por:
- `mcp-oauth-providers/{google,github,spotify}.js` para leer credentials con fallback a env vars.
- `LocationService` para override manual de coords.
- `routes/system-config.js` REST admin para CRUD desde UI.

---

## LocationService

**Archivo:** `server/services/LocationService.js`

Combina 4 fuentes de ubicación del server:

1. **LAN local** — `os.networkInterfaces()` filtrando IPv4 no internas.
2. **Tailscale** — IPs en rango CGNAT 100.64.0.0/10 (filter automático del LAN).
3. **IP pública + geo** — fetch a `ipwho.is` (free, sin key, ~10k req/mes anónimas). Cache 24h.
4. **Override manual** — coords lat/lon ingresadas por admin via UI, persistidas en `SystemConfigRepository`.

**Constructor:** `({ systemConfigRepo?, logger?, publicIpTtlMs? })`

**API pública:**
```javascript
locationService.getLanInterfaces()                       // [{ interface, address, mac, isTailscale }]
locationService.getTailscaleInterfaces()                 // subset de LAN con isTailscale=true
locationService.getPublicGeo(force=false)                // { ip, country, city, latitude, longitude, timezone, source }
locationService.getManualLocation()                      // { latitude, longitude, name } | null
locationService.setManualLocation({ latitude, longitude, name })
locationService.getLocation({ includePublic, forcePublic })  // snapshot completo con `resolved` (preferred: manual > public-ip)
```

Consumido por:
- Tools MCP `server_info`, `server_location`, `weather_get`, `air_quality_get`, `sun_get`, `uv_index_get`, `holiday_check`.
- REST `routes/system.js` (`/api/system/location`, `/api/system/lan-addresses`).

---

## mcp-oauth-providers/

**Carpeta:** `server/mcp-oauth-providers/`

Handlers OAuth2 que se auto-registran en `McpAuthService` si detectan credenciales en `SystemConfigRepository` o env vars. Incluye:

- **`google.js`** — Calendar, Gmail, Drive, Tasks (un solo par client_id/secret cubre los 4). Scopes según `mcp_name` (calendar/gmail/drive/tasks).
- **`github.js`** — repos, issues, PRs.
- **`spotify.js`** — control de reproducción + búsqueda (requiere Premium para playback).

**API pública:**
```javascript
require('./mcp-oauth-providers').registerAll({ mcpAuthService, systemConfigRepo, logger })
// → registra los 6 callback handlers en mcpAuthService:
//   ['google-calendar', 'google-gmail', 'google-drive', 'google-tasks', 'github', 'spotify']
```

Cada handler exporta `{ buildAuthUrl({ state, redirectUri }), exchange({ code, req }) }` que `McpAuthService` invoca al recibir el callback HTTP.

**Lectura dinámica de credenciales** — los handlers leen `getCreds()` en cada request, no al boot. El admin puede actualizar las credenciales desde el UI sin restart del server.

---

## AuthService (extendido para multi-user con aprobación)

Ver doc previa en este archivo. Agregado en v1.5.0:

- `register(email, password, name, opts)` ahora detecta `opts.inviteCode` y bypassa el `status='pending'` si el código es válido.
- `login()` valida `user.status` además de password — lanza error con `code: 'PENDING_APPROVAL'` o `'ACCOUNT_DISABLED'`.
- Métodos nuevos: `approveUser(id, byAdminId)`, `rejectUser(id, byAdminId)` (revoca tokens), `reactivateUser(id, byAdminId)`.
- Métodos invitations: `createInvitation/listInvitations/revokeInvitation/inspectInvitation` (delegan al repo).
- `init()` auto-genera y persiste `JWT_SECRET` en `${CONFIG_DIR}/.jwt-secret.key` si no hay env var (instalable sin `.env`).
