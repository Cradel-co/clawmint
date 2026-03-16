# Clawmint

Terminal en tiempo real accesible desde el navegador y desde Telegram. Combina sesiones PTY, streaming via WebSocket, una REST API completa y un bot de Telegram que actúa como frontend alternativo para Claude Code y otros agentes de IA.

---

## Índice

- [Inicio rápido — desarrollo](#inicio-rápido--desarrollo)
- [Inicio en producción](#inicio-en-producción)
- [Documentación detallada](#documentación-detallada)
- [Características](#características)
- [Stack](#stack)
- [Archivos excluidos del repo](#archivos-excluidos-del-repo)

---

## Inicio rápido — desarrollo

### 1. Requisitos

- Node.js 22+
- [Claude Code CLI](https://claude.ai/download) instalado y autenticado (`claude`)
- Token de bot de Telegram (opcional, para el módulo Telegram)

### 2. Clonar e instalar

```bash
git clone git@github.com:Cradel-co/clawmint.git
cd clawmint

# Servidor
cd server && npm install && cd ..

# Cliente
cd client && npm install && cd ..
```

### 3. Configurar el bot de Telegram (opcional)

```bash
cp server/.env.example server/.env
# Editar server/.env con el token del bot de desarrollo
```

```env
BOT_TOKEN=1234567890:AABBccDDeeFFggHH...
BOT_KEY=dev
BOT_DEFAULT_AGENT=claude
BOT_WHITELIST=123456789
BOT_RATE_LIMIT=30
```

Al primer arranque el servidor detecta que no existe `bots.json` y lo crea automáticamente desde las variables de entorno. En los arranques siguientes lo lee del archivo.

### 4. Levantar

```bash
# Terminal 1 — servidor
cd server && npm run dev

# Terminal 2 — cliente (Vite con HMR)
cd client && npm run dev
```

| Servicio | URL |
|---|---|
| Cliente | http://localhost:5173 |
| API / WS | http://localhost:3001 |

---

## Inicio en producción

### 1. Build del cliente

```bash
cd client && npm run build
```

Genera `client/dist/`. Servir con nginx, caddy o cualquier servidor estático apuntando a esa carpeta.

### 2. Servidor con PM2

```bash
cd server
pm2 start index.js --name clawmint-server
pm2 save
pm2 startup   # para que arranque con el sistema
```

> En producción `bots.json` se crea desde el panel web o la API REST. No se necesita `.env` si el archivo ya existe.

---

## Documentación detallada

| Documento | Contenido |
|---|---|
| [documentacion/servidor.md](documentacion/servidor.md) | Módulos del servidor, API REST completa, providers, agentes, skills, memoria, Telegram |
| [documentacion/cliente.md](documentacion/cliente.md) | Componentes React, WebSocket, paneles, build |

---

## Características

- **Terminal en el navegador** — xterm.js conectado por WebSocket a PTY real (`node-pty`), con reconexión automática y backoff exponencial
- **Bot de Telegram** — controla sesiones de Claude Code desde Telegram con streaming progresivo y comandos jerárquicos
- **Múltiples providers de IA** — Anthropic, Gemini, OpenAI y Claude Code CLI, configurables por agente
- **Agentes de rol** — perfiles con prompt, provider, modelo y archivos de memoria configurables
- **Skills** — inyección de capacidades desde [ClawHub](https://clawhub.ai)
- **Memoria por agente** — archivos de contexto persistente inyectados automáticamente
- **Panel web** — gestión de bots, agentes, skills, providers y memoria desde la UI
- **REST API** — control completo via HTTP

---

## Stack

| Capa | Tecnología |
|---|---|
| Runtime | Node.js 22+ |
| HTTP / WS | Express 4 + `ws` |
| Terminal | `node-pty` |
| IA | Claude Code CLI + Anthropic/Gemini/OpenAI SDK |
| Cliente | React 18 + Vite + xterm.js |
| Mensajería | Telegram Bot API (long polling) |
| Persistencia | JSON planos en `server/` |

---

## Archivos excluidos del repo

Generados en runtime, no versionados:

| Archivo | Descripción |
|---|---|
| `server/.env` | Variables de entorno locales |
| `server/bots.json` | Tokens y estado de bots de Telegram |
| `server/agents.json` | Agentes creados desde la UI |
| `server/provider-config.json` | API keys de providers |
| `server/logs.json` / `server/server.log` | Logs |
| `server/memory/` | Datos de memoria por agente |
| `server/skills/` | Skills instalados desde ClawHub |
