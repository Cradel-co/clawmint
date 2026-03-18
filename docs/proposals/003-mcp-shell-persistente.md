> Estado: `implementada` — 2026-03-17

# Propuesta 003: MCP Server embebido + ShellSession + paridad de providers

## Problema

Los 3 providers API (Anthropic, Gemini, OpenAI) tenían tool-calling loop funcionando, pero ejecutaban cada herramienta como `execSync` one-shot: el `cwd` se perdía entre llamadas, `cd /tmp` no persistía, variables de entorno tampoco. Claude Code mantenía estado de shell internamente via `ClaudePrintSession`, pero los providers API no.

Además, `TelegramBot` tenía sus propios `_sendToSession` y `_sendToApiProvider` duplicando lógica que ya existía en `ConversationService`.

## Objetivo

1. Shell bash persistente por conversación para todos los providers
2. `ConversationService` como único orquestador — TelegramBot solo maneja UI de Telegram
3. Endpoint HTTP `/mcp` para consumo externo (Claude Code, curl)

## Decisiones de diseño

| Decisión | Alternativa | Razón |
|----------|-------------|-------|
| `ShellSession` por `chatId` | Shell global | Aislamiento entre usuarios; estado natural por conversación |
| MCP HTTP sin `@modelcontextprotocol/sdk` | SDK oficial | El SDK usa ESM; el proyecto es CommonJS. JSON-RPC manual es más simple y confiable |
| `executeTool` inyectado en providers | `require('../tools')` global | Permite pasar `shellId` como contexto sin cambiar la interfaz del provider |
| Mantener `tools.js` con misma API pública | Renombrar | Los providers no requieren cambios de importación; zero riesgo de regresión |
| Eliminar `_sendToApiProvider` de `TelegramBot` | Mantenerlo | Duplicación de lógica que ya existe en `ConversationService` |
| Preservar ruta PTY en `TelegramBot` | Eliminarla | Fallback necesario para agentes no-claude (bash, custom commands) |

## Implementación

### `server/mcp/ShellSession.js`
- Pool de procesos bash (`spawn('bash', ['--norc'])`)
- Cola interna serializa comandos
- Centinela único por comando: `__CLAWMINT_N__:$?`
- Auto-destroy tras 30 min idle

### `server/mcp/tools/`
- `bash.js` — usa `ShellSession.get(shellId)`
- `files.js` — extraído de `tools.js` (read_file, write_file, list_dir, search_files)
- `pty.js` — pty_write, pty_read via `ctx.sessionManager`
- `index.js` — `all()` + `execute(name, args, ctx)`

### `server/mcp/index.js`
- `createMcpRouter({ sessionManager, memory })` → Express Router en `/mcp`
- `executeTool(name, args, ctx)` — ejecución en-proceso sin protocolo
- `getToolDefs()` → array de definiciones

### `server/tools.js`
Pasa a ser adaptador delgado: delega a `mcp/index.js`. Misma API pública.

### Providers (anthropic, gemini, openai)
```javascript
async *chat({ ..., executeTool: execToolFn }) {
  const execTool = execToolFn || tools.executeTool;
  // ... usa execTool en lugar de tools.executeTool
}
```

### `ConversationService._processApiProvider`
```javascript
const execToolFn = mcpExec
  ? (name, args) => mcpExec(name, args, { shellId, sessionManager })
  : undefined;
const gen = provObj.chat({ ..., executeTool: execToolFn });
```

### `TelegramBot._sendToSession` (refactorizado)
```
if (!useConvSvc) → ruta PTY (agentes no-claude)
else             → convSvc.processMessage({ ..., shellId: String(chatId) })
                   + _startDotAnimation()
                   + onChunk throttle 1500ms
                   + _sendResult() con botones post-respuesta
```

## Verificación

```bash
# ShellSession persiste estado
node -e "
const S = require('./server/mcp/ShellSession');
const s = S.get('test');
s.run('cd /tmp').then(() => s.run('pwd')).then(console.log);  // /tmp
s.run('X=42').then(() => s.run('echo \$X')).then(console.log); // 42
"

# MCP HTTP
curl -X POST http://localhost:3001/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# → 7 tools: bash, read_file, write_file, list_dir, search_files, pty_write, pty_read

# Para Claude Code
claude mcp add-json clawmint '{"type":"http","url":"http://localhost:3001/mcp"}'
```
