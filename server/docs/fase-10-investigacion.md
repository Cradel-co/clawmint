---
fase: 10
fecha: 2026-04-18
autor: Claude Opus 4.7 + Brian
estado: en ejecución
---

# Fase 10 — LSP integration — investigación previa

## Scope

Fase **opcional** marcada como "cara". Se implementa **scaffold mínimo** para dejar la infra lista, sin embeber `typescript-language-server` ni otros binarios (cada host instala los que quiera).

## Decisión de protocolo

LSP usa JSON-RPC 2.0 sobre stdio con framing `Content-Length: N\r\n\r\n<body>`. Implementación manual — el ecosistema tiene libs (`vscode-jsonrpc`, `vscode-languageserver-protocol`), pero agregan ~2MB de deps para algo que son ~120 líneas de parser. Implementamos nosotros.

## Decisión de lenguaje/servidor

El scaffold acepta **cualquier** LSP server via config (command + args). Default config apunta a `typescript-language-server --stdio` (comando npm más común). Si el binario no está, fail-open: el manager retorna tools con error amigable y el resto del sistema no se cae.

```js
LSP_SERVERS = {
  ts: { command: 'typescript-language-server', args: ['--stdio'], extensions: ['.ts', '.tsx', '.js', '.jsx'] },
  py: { command: 'pylsp', args: [], extensions: ['.py'] },
  rust: { command: 'rust-analyzer', args: [], extensions: ['.rs'] },
}
```

Configurable via env `LSP_SERVERS_JSON` si hace falta sobrescribir.

## Archivos nuevos

- `services/LSPServerManager.js` — pool `Map<workspaceRoot, Map<lang, LSPClient>>`. Un LSPClient por (workspace, lenguaje). Initialize lazy al primer request.
- `services/LSPClient.js` — cliente concreto. Spawn del server, framing read/write, pending-request map, timeout 30s.
- `mcp/tools/lsp.js` — 6 tools que delegan a `LSPServerManager`.
- `test/lsp-server-manager.test.js` — mock child process, verificar framing request/response + timeout.
- `test/tools.lsp.test.js` — tools delegan correctamente al manager.

## Ya existente que se reusa

- `core/workspace/WorkspaceProvider.js` — `acquire(ctx)` devuelve `cwd`; usamos ese cwd como workspace root para el LSP.
- Patrón de `mcp/tools/*` — factory directa con `execute(args, ctx)`.

## Gaps / parked

- Integración real con proyecto TS: fuera de scope del servidor (depende del host tener el lenguaje instalado).
- `did_open/did_change` sync de archivos al LSP: el scaffold lo hace sólo implícitamente al request; no stream de cambios.
- Caching de diagnostics: parked — cada llamada pide fresh.

## Flag

```env
LSP_ENABLED=false
LSP_REQUEST_TIMEOUT_MS=30000
```

Con flag off, las tools retornan error fijo "LSP no habilitado". Con flag on pero binario ausente, error amigable "language server no disponible".

## Tests plan

- LSPClient:
  - frame parsing con múltiples mensajes en un chunk
  - timeout de request sin respuesta
  - notification sin id no resuelve nada
  - spawn falla → reject limpio
- LSPServerManager:
  - pool reusa cliente por (workspace, lang)
  - shutdown limpia todo
- tools/lsp.js:
  - cada tool arma el request correcto
  - con LSP_ENABLED=false devuelve error fijo
  - con binario ausente devuelve fallback
