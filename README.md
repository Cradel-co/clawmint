# 🦀 Clawmint — Terminal IA Personal

<p align="center">
  <strong>Tu terminal. Tu IA. Desde el navegador o desde Telegram.</strong>
</p>

<p align="center">
  <a href="https://github.com/Cradel-co/clawmint/actions"><img src="https://img.shields.io/github/actions/workflow/status/Cradel-co/clawmint/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <img src="https://img.shields.io/badge/Node-%3E%3D22-brightgreen?style=for-the-badge&logo=node.js&logoColor=white" alt="Node 22+">
  <img src="https://img.shields.io/badge/Stack-React%20%2B%20Vite%20%2B%20xterm.js-blue?style=for-the-badge" alt="Stack">
  <img src="https://img.shields.io/badge/IA-Claude%20%7C%20Anthropic%20%7C%20Gemini%20%7C%20OpenAI-purple?style=for-the-badge" alt="IA providers">
</p>

**Clawmint** es una terminal en tiempo real que corrés en tu propio servidor.
Accedés desde el navegador o desde Telegram. Soporta sesiones PTY reales, streaming via WebSocket, múltiples agentes de IA con providers configurables (Claude Code CLI, Anthropic, Gemini, OpenAI), skills, memoria persistente y un bot de Telegram que actúa como frontend completo.

[Inicio rápido](#inicio-rápido--desarrollo) · [Producción](#inicio-en-producción) · [Docs servidor](docs/servidor.md) · [Docs cliente](docs/cliente.md) · [API REST](docs/servidor.md#api-rest) · [Comandos Telegram](docs/servidor.md#comandos-del-bot-de-telegram) · [Changelog](CHANGELOG.md)

---

## Inicio rápido — desarrollo

Runtime: **Node ≥ 22**.

### 1. Clonar e instalar

```bash
git clone git@github.com:Cradel-co/clawmint.git
cd clawmint

cd server && npm install && cd ..
cd client && npm install && cd ..
```

### 2. Configurar el bot de Telegram (opcional)

```bash
cp server/.env.example server/.env
# Editar server/.env con el token del bot
```

```env
BOT_TOKEN=1234567890:AABBccDDeeFFggHH...
BOT_KEY=dev
BOT_DEFAULT_AGENT=claude
BOT_WHITELIST=123456789
BOT_RATE_LIMIT=30
```

Al primer arranque el servidor detecta que no existe `bots.json` y lo crea automáticamente desde las variables de entorno.

### 3. Levantar

```bash
# Terminal 1 — servidor (con hot reload)
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
# Sirve client/dist/ con nginx, caddy, o cualquier servidor estático
```

### 2. Servidor con PM2

```bash
cd server
pm2 start index.js --name clawmint-server
pm2 save
pm2 startup
```

> En producción `bots.json` se crea desde el panel web o la API REST. No se necesita `.env` si el archivo ya existe.

**Ejemplo nginx:**

```nginx
server {
    listen 80;
    server_name tu-dominio.com;
    root /ruta/a/clawmint/client/dist;

    location / { try_files $uri $uri/ /index.html; }

    location /api {
        proxy_pass http://localhost:3001;
    }

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

---

## Cómo funciona

```
Telegram / Navegador
        │
        ▼
┌───────────────────────────────┐
│           Clawmint            │
│       (servidor Node.js)      │
│     http://localhost:3001     │
└──────────────┬────────────────┘
               │
               ├─ PTY sessions (node-pty)
               ├─ AI sessions (Anthropic / Gemini / OpenAI / Claude Code CLI)
               ├─ WebSocket (xterm.js)
               ├─ REST API
               └─ Telegram Bot (long polling)
```

---

## Características

- **Terminal PTY real** — xterm.js + `node-pty`, reconexión automática con backoff exponencial (1s → 16s)
- **Bot de Telegram** — streaming progresivo, comandos jerárquicos, rate limit, whitelist, navegación de archivos
- **Múltiples providers de IA** — Claude Code CLI, Anthropic SDK, Gemini, OpenAI — configurables por agente o por chat
- **Agentes de rol** — perfiles con prompt, provider, modelo y memoria persistente
- **Skills** — inyección de capacidades desde [ClawHub](https://clawhub.ai)
- **Memoria por agente** — archivos de contexto inyectados automáticamente en cada conversación
- **Historial AI persistente** — sobrevive reconexiones WS durante hasta 24h
- **Panel web** — gestión de bots, agentes, skills, providers y memoria desde la UI
- **REST API** — control completo via HTTP

---

## Stack

| Capa | Tecnología |
|---|---|
| Runtime | Node.js 22+ |
| HTTP / WS | Express 4 + `ws` |
| Terminal | `node-pty` |
| IA | Claude Code CLI + Anthropic / Gemini / OpenAI SDK |
| Cliente | React 18 + Vite + xterm.js |
| Mensajería | Telegram Bot API (long polling) |
| Persistencia | JSON planos en `server/` |

---

## Documentación

| Documento | Contenido |
|---|---|
| [docs/servidor.md](docs/servidor.md) | Módulos, variables de entorno, API REST completa, WebSocket, providers, agentes, skills, memoria, comandos Telegram |
| [docs/cliente.md](docs/cliente.md) | Componentes React, reconexión WS, paneles, build, nginx |
| [docs/mejoras.md](docs/mejoras.md) | Ideas y mejoras propuestas |
| [CHANGELOG.md](CHANGELOG.md) | Historial de cambios por versión |

---

## Comandos del bot de Telegram

| Comando | Descripción |
|---|---|
| `/start` | Inicio de sesión |
| `/nueva` | Nueva conversación |
| `/modelo [nombre]` | Ver o cambiar modelo |
| `/agentes` | Listar agentes disponibles |
| `/<key>` | Activar agente de rol |
| `/basta` | Desactivar agente de rol |
| `/skills` | Ver skills instalados |
| `/buscar-skill` | Buscar e instalar desde ClawHub |
| `/ls [path]` | Navegar el sistema de archivos |
| `/cat [archivo]` | Ver contenido de archivo |
| `/mkdir [path]` | Crear directorio |
| `/monitor` | Estado de procesos del sistema |
| `/status-vps` | CPU, RAM y disco |
| `/id` | Ver tu chat ID |

---

## Archivos excluidos del repo

| Archivo | Descripción |
|---|---|
| `server/.env` | Variables de entorno locales |
| `server/bots.json` | Tokens y estado de bots |
| `server/agents.json` | Agentes creados desde la UI |
| `server/provider-config.json` | API keys de providers |
| `server/logs.json` / `server/server.log` | Logs |
| `server/memory/` | Memoria por agente |
| `server/skills/` | Skills instalados |
