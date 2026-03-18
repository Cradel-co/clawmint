# Clawmint

Terminal en tiempo real accesible desde el navegador y Telegram. Combina PTY virtual (node-pty), WebSocket, REST API, y un bot de Telegram como frontend alternativo para Claude Code y otros agentes.

## Instrucciones de comunicación

- Responder siempre en **español**.
- Ser conciso y directo, sin relleno.
- Usar siempre **rutas absolutas** (base: `/home/marcos/marcos/clawmint/`) para no perder contexto del directorio de trabajo.
- No explicar lo obvio; el usuario conoce el proyecto.

## Stack

- **Runtime:** Node.js 22+ (CommonJS, `'use strict'`)
- **Server:** Express 4 + `ws` + `node-pty`
- **Client:** React 18 + Vite + xterm.js
- **IA:** Anthropic SDK + `claude -p` (CLI)
- **Persistencia:** SQLite via sql.js (WASM) + JSON planos (`agents.json`, `bots.json`)
- **Mensajería:** Telegram Bot API (long polling)

## Estructura

```
clawmint/
├── server/
│   ├── index.js          # HTTP, WebSocket, rutas REST (puerto 3001)
│   ├── sessionManager.js # PtySession + pool de sesiones
│   ├── telegram.js       # TelegramBot + ClaudePrintSession
│   ├── agents.js         # CRUD de agentes
│   ├── skills.js         # Skills locales + búsqueda ClawHub
│   ├── memory.js         # Memoria persistente por agente
│   └── events.js         # EventEmitter global
└── client/
    └── src/
        ├── App.jsx
        └── components/
            ├── TerminalPanel.jsx
            ├── TabBar.jsx
            ├── AgentsPanel.jsx
            └── TelegramPanel.jsx
```

## Comandos

```bash
# Server
cd server && npm install && npm start  # http://localhost:3001

# Client
cd client && npm install && npm run dev  # http://localhost:5173
```

## Convenciones

- Todo el backend es CommonJS (`require`, `module.exports`), NO ES Modules.
- Los archivos `agents.json`, `bots.json`, `logs.json`, `server.log`, `memory/`, `skills/` se generan en runtime y NO se versionan.
- El stack de node-pty se aumenta con `--stack-size=65536` para evitar crash en WSL2.
- Se eliminan `CLAUDECODE` y `CLAUDE_CODE_ENTRYPOINT` del env al spawner PTYs.
- Telegram edits tienen throttle de 1500ms (límite de la API).
- **SQLite usa sql.js (WASM)**, no better-sqlite3 — no requiere compilación nativa (funciona en Windows y Linux sin Visual Studio Build Tools).
  - El wrapper `storage/sqlite-wrapper.js` expone API compatible con better-sqlite3 (`prepare().run/get/all`, `pragma()`, `exec()`).
  - La DB vive en memoria y se auto-persiste a disco con debounce de 500ms.
  - La inicialización es async (`await Database.initialize()` en `memory.initDBAsync()`).
- **spawn de `claude` CLI** usa `shell: true` en Windows (`process.platform === 'win32'`) para resolver `.cmd`.

## Arquitectura detallada

Ver `ARQUITECTURA.md` para documentación completa de módulos, API REST, protocolo WebSocket, plan multi-proveedor y notas de implementación.
