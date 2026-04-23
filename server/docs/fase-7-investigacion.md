# Fase 7 — Investigación previa

**Fecha:** 2026-04-18
**Alcance:** eficiencia de contexto — lazy tool loading + 3 compactors + overflow detection + cache break detection.

## Estado actual del system prompt y history

### Sliding window existente (`services/ConversationService.js`)

Constantes (líneas 16–18):
```js
const MAX_HISTORY_MESSAGES = 30;
const MESSAGES_TO_SUMMARIZE = 20;
const SUMMARY_MARKER = '[resumen-conversacion]';
```

`_compactHistory(history, provider, apiKey, model)` (líneas 236–274):
- Dispara si `history.length > 30`.
- Llama al **mismo provider/model** que la conversación para resumir los primeros 20 mensajes (con prompt fijo en español).
- Reemplaza con 2 mensajes: un `user` con `[resumen-conversacion]` + body, y un `assistant` con ack.
- Preserva últimos 10 mensajes literales.

**Limitaciones confirmadas:**
1. **Usa el mismo modelo** de la conversación para resumir → si el chat usa Opus, el summary cuesta Opus. En Fase 7.5.4 esto pasa a tier `cheap`.
2. **Sin circuit breaker** → si falla, logea y no rompe, pero puede intentar infinitas veces en turns sucesivos.
3. **No detecta overflow de provider** — depende del 30-message threshold; si los mensajes son cortos, nunca dispara aunque el provider se queje.
4. **Compacta todo o nada** — no hay microcompact de resultados de tools.

### Tool system prompt (`_buildToolSystemPrompt`)

Se construye desde `mcp-system-prompt.txt` (read once, cached) + instrucciones inline sobre herramientas + memoria. Lo critical es que **todas** las tools se incluyen en el prompt (shape completo) siempre — no hay lazy loading.

### Callsites de modelos hardcoded

- `memory-consolidator.js:327` — `--model claude-haiku-4-5-20251001` (único callsite de Haiku hardcoded)
- `providers/anthropic.js::resolveMaxTokens` — usa matching por substring para determinar 16000/8192/4096 según modelo
- `core/SubagentRegistry.js` — hardcoded por tipo: `claude-haiku-4-5` (explore), `claude-sonnet-4-6` (plan/researcher), `claude-opus-4-7` (code)

Fase 7.5.1 **ya resuelto** vía `providers/modelTiers.js` + `resolveModelForTier()`. Los callsites de arriba migrarán a este helper en Fase 7.5.4.

## Tools que producen output grande

Inventario actual + estimación de tamaño típico en output:

| Tool | Output típico | Notas |
|---|---|---|
| `bash` | ~1-10 KB normal, hasta 2MB en `ls -laR` | Ring buffer 2MB (Fase 3) + truncate 30KB final (Fase 7.5.6) |
| `read_file` | 1-50KB | Límite 50KB hardcoded en `files.js` |
| `grep` | 1-20KB | `--max-count 250` (Fase 7.5.6) |
| `glob` | 1-10KB | `limit` param default 100 |
| `webfetch` | hasta 100KB (post-convert) | Cap de Fase 3 |
| `websearch` | ~1KB | 5 results formateados |
| `memory_read` | 1-10KB | |
| `task_get` | 1-5KB | |
| `pty_read` | hasta 10KB | |

**Candidatas a MicroCompactor** (resultados efímeros que el modelo no suele re-leer): `bash`, `read_file`, `grep`, `glob`, `webfetch`, `websearch`. Los demás (memory_*, task_*) no se compactan — son referenciales.

## Diseño modular aplicado (revisión 2026-04-18 + brief handoff)

1. **Interface común `ContextCompactor`** — abstract class con `shouldCompact(state) → bool` y `compact(history, ctx) → history`.
2. **3 implementaciones independientes:**
   - `SlidingWindowCompactor` — envuelve `_compactHistory` existente como fallback legacy
   - `MicroCompactor` — reemplaza tool results viejos por placeholders sin tocar mensajes user/assistant
   - `ReactiveCompactor` — monitoree tokens reales, con agresividad escalonada y circuit breaker
3. **`CompactorPipeline`** — orquesta en cascada. `reactive → micro → sliding` (primero que dispara gana).
4. **`overflowDetection.js`** — regex patterns para catchear errores de overflow de providers y disparar compactación retroactiva.
5. **`ToolCatalog`** — lazy loading. Dos tools separadas `tool_search(query)` y `tool_load(names[])` (no unión `{query|select}`).
6. **Cache break detection** — en `providers/anthropic.js` después de la response, si `cache_read === 0` con system prompt estable, emit `cache:miss`.

## Plan de implementación

### Orden

1. `docs/fase-7-investigacion.md` (este doc) — pre-requisito formal.
2. `core/compact/ContextCompactor.js` (interface).
3. `core/compact/SlidingWindowCompactor.js` (wrapper de `_compactHistory`).
4. `core/compact/MicroCompactor.js` (reemplaza tool results).
5. `core/compact/overflowDetection.js` (patterns).
6. `core/compact/ReactiveCompactor.js` (circuit breaker + escalated strategy).
7. `core/compact/CompactorPipeline.js` (orquestador).
8. `core/ToolCatalog.js` + tools `tool_search` / `tool_load`.
9. Cache break detection en anthropic.js.
10. Integración en `ConversationService` detrás de flags.

### Flags

```env
LAZY_TOOLS_ENABLED=false            # default off — tools se incluyen full en system prompt
ALWAYS_VISIBLE_TOOLS=read_file,bash,tool_search,tool_load,task_create
MICROCOMPACT_ENABLED=false
MICROCOMPACT_EVERY_TURNS=10
MICROCOMPACT_KEEP_LAST_K=4
REACTIVE_COMPACT_ENABLED=false
AUTOCOMPACT_BUFFER_TOKENS=13000
COMPACT_CIRCUIT_BREAKER=true        # default ON — seguridad
MAX_CONSECUTIVE_COMPACT_FAILURES=3
```

## Criterios de aceptación

- 477 tests pre-existentes del refactor siguen verdes.
- 50+ tests nuevos (interface + 3 compactors + pipeline + overflow + ToolCatalog + cache break).
- Cero cambio observable con flags off.
- Con flags on, compaction funciona sin romper sliding window existente.

## Referencias verificables

- OpenCode overflow patterns: `C:/Users/padil/Documents/wsl/opencode/packages/opencode/src/provider/error.ts`
- OpenCode lazy tools: `C:/Users/padil/Documents/wsl/opencode/packages/opencode/src/tool/registry.ts`
- Hooks `chat.params` (ya aplicado 6.6): `C:/Users/padil/Documents/wsl/opencode/packages/plugin/src/index.ts`

## Notas de parked para Fase 7.5.4

Los callsites que pasan a `resolveModelForTier(provider, 'cheap')`:
- `memory-consolidator.js` (ahora `--model claude-haiku-4-5-20251001` hardcoded)
- `SlidingWindowCompactor` (TODO tras Fase 7: pasar model tier 'cheap')
- `MicroCompactor` (no llama LLM en MVP — solo reemplaza por placeholders)
- `ReactiveCompactor._summarize` (**aquí sí llama LLM** — se hardcodea temporalmente, migra en 7.5.4)
