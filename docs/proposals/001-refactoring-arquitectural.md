> Estado: `implementada` | Fecha: 2026-03 | Autor: equipo

# Propuesta 001: Refactoring arquitectural — desacoplamiento completo

## Problema

`server/telegram.js` era un monolito de 3075 líneas con:
- 11 `require()` directos a módulos internos (sin DI)
- `ClaudePrintSession` definida inline (duplicada)
- 6 `require('./mcps')` lazy dispersos en el código
- Sin abstracción de canal (agregar Discord requería copiar todo el archivo)
- Sin inyección de dependencias real
- `chat-settings.js` con `require('./memory')` interno (acoplamiento circular)

## Objetivo

Arquitectura donde:
1. Cada módulo tiene una responsabilidad única
2. Las dependencias se reciben por constructor (DI)
3. `bootstrap.js` es el único hub de ensamblado
4. Se puede agregar un canal Discord sin tocar el núcleo

## Alternativas consideradas

| Alternativa | Resultado |
|-------------|-----------|
| Reescribir `memory.js` completo | **Descartada** — 1244 líneas de lógica cognitiva compleja. Riesgo muy alto. Cambio mínimo (`setDB()`) fue suficiente |
| Migrar a ES Modules (ESM) | **Descartada** — bindings nativos (`node-pty`, `better-sqlite3`) tienen problemas con ESM. No agrega valor real |
| AsyncIterator en lugar de `onChunk` callback | **Descartada** — la animación de edición en Telegram es específica del canal. `ConversationService` no debe saber de mensajes editables |

## Solución implementada

### Nueva estructura

```
server/
├── bootstrap.js                     ← hub único de DI
├── core/Logger.js, EventBus.js, ClaudePrintSession.js
├── storage/DatabaseProvider.js, BotsRepository.js, ChatSettingsRepository.js
├── services/ConversationService.js
├── channels/BaseChannel.js
└── channels/telegram/
    ├── TelegramChannel.js           ← extends BaseChannel
    ├── CommandHandler.js
    ├── CallbackHandler.js
    └── PendingActionHandler.js
```

### Fases ejecutadas

| Fase | Descripción | Estado |
|------|-------------|--------|
| 0 | Logger, EventBus, ClaudePrintSession, memory.setDB | ✅ |
| 1 | Split telegram.js en channels/telegram/ | ✅ |
| 2 | Storage layer (repos + DatabaseProvider) | ✅ |
| 3 | DI completa: ConversationService, BaseChannel, bootstrap completo | ✅ |
| 4 | Limpieza: eliminado chat-settings.js | ✅ |

### Deuda pendiente de la propuesta

- `telegram.js` shim aún existe (re-export de compatibilidad). Puede eliminarse cuando `index.js` importe `TelegramChannel` directamente desde `bootstrap.js`
- `events.js` aún usado por `memory-consolidator.js` (requiere inyección de `EventBus`)
- `TelegramBot._sendToSession()` / `_sendToApiProvider()` no delegan aún a `ConversationService`
- `index.js` aún hace `require()` directos de dominio (no usa el container para todo)

## Decisiones de diseño

| Decisión | Razón |
|----------|-------|
| `onChunk` callback en lugar de AsyncIterator | Animación de Telegram es específica del canal |
| `mcps` puede ser null | Los `if (!this.mcps)` reemplazan los 6 `require()` lazy |
| `ClaudePrintSession` en `core/` | No implementa `chat()`; es infraestructura reutilizable por Discord, HTTP, etc. |
| Providers/skills/mcps siguen siendo singletons | Son stateless; DI suficiente pasándolos como args desde bootstrap |
| `memory.js` sin reescribir | Solo se agregó `setDB()` para inyección externa |
