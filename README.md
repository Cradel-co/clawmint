# Clawmint

Terminal en tiempo real accesible desde el navegador y desde Telegram. Combina sesiones PTY, streaming via WebSocket, una REST API completa y un bot de Telegram que actúa como frontend alternativo para Claude Code y otros agentes.

## Características

- **Terminal en el navegador** — xterm.js conectado por WebSocket a PTY real (`node-pty`)
- **Bot de Telegram** — controla sesiones de Claude Code directamente desde Telegram con streaming progresivo
- **Agentes de rol** — perfiles con prompt, modelo y archivos de memoria configurables
- **Skills** — inyección de capacidades desde [ClawHub](https://clawhub.ai) con un comando
- **Memoria por agente** — archivos de contexto persistente que se inyectan automáticamente
- **Panel web** — gestión de bots, agentes, skills y memoria desde la UI
- **REST API** — control completo de sesiones, agentes, bots y logs via HTTP

## Stack

| Capa | Tecnología |
|---|---|
| Runtime | Node.js 22+ |
| HTTP / WS | Express 4 + `ws` |
| Terminal | `node-pty` |
| IA | `claude -p` (Claude Code CLI) + Anthropic SDK |
| Cliente | React 18 + Vite + xterm.js |
| Mensajería | Telegram Bot API (long polling) |
| Persistencia | JSON planos (`agents.json`, `bots.json`) |

## Estructura

```
clawmint/
├── server/
│   ├── index.js          # HTTP, WebSocket, rutas REST
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

## Instalación

### Requisitos

- Node.js 20+
- [Claude Code CLI](https://claude.ai/download) instalado y autenticado (`claude`)
- Token de bot de Telegram (opcional)

### Servidor

```bash
cd server
npm install
npm start
```

El servidor escucha en `http://localhost:3001`.

### Cliente

```bash
cd client
npm install
npm run dev
```

El cliente queda en `http://localhost:5173` por defecto.

### PM2 (producción)

```bash
pm2 start server/index.js --name terminal-server
pm2 save
```

## Configuración del bot de Telegram

1. Creá un bot con [@BotFather](https://t.me/BotFather) y copiá el token
2. Desde el panel web (pestaña Telegram) agregá el token
3. Opcionalmente configurá whitelist de chat IDs y rate limit

### Comandos del bot

| Comando | Descripción |
|---|---|
| `/start` | Saludo e inicio |
| `/nueva` | Nueva conversación |
| `/modelo [nombre]` | Ver o cambiar modelo de Claude |
| `/agentes` | Listar agentes de rol disponibles |
| `/<key>` | Activar agente de rol |
| `/basta` | Desactivar agente de rol |
| `/skills` | Ver skills instalados |
| `/buscar-skill` | Buscar e instalar skills de ClawHub |
| `/estado` | Estado de la sesión actual |
| `/costo` | Costo acumulado de la sesión |
| `/memoria` | Ver archivos de memoria |
| `/status-vps` | CPU, RAM y disco del servidor |
| `/ls [path]` | Navegar el sistema de archivos |
| `/id` | Ver tu chat ID |

## API REST

```
GET    /api/sessions              Listar sesiones activas
POST   /api/sessions              Crear sesión
DELETE /api/sessions/:id          Cerrar sesión
POST   /api/sessions/:id/message  Enviar mensaje y esperar respuesta

GET    /api/agents                Listar agentes
POST   /api/agents                Crear agente
PATCH  /api/agents/:key           Actualizar agente
DELETE /api/agents/:key           Eliminar agente

GET    /api/memory/:agentKey      Listar archivos de memoria
PUT    /api/memory/:agentKey/:file Escribir archivo de memoria

GET    /api/telegram/bots         Listar bots
POST   /api/telegram/bots         Agregar bot
PATCH  /api/telegram/bots/:key    Configurar bot (whitelist, rateLimit)

GET    /api/skills                Listar skills instalados
POST   /api/skills/install        Instalar skill desde ClawHub
```

## Archivos excluidos del repo

Los siguientes archivos se generan en runtime y no se versionan:

- `server/bots.json` — tokens de Telegram
- `server/agents.json` — configuración de agentes locales
- `server/logs.json` / `server/server.log` — logs
- `server/memory/` — datos de memoria de agentes
- `server/skills/` — skills instalados
