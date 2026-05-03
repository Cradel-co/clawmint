# Clawmint — Agente Familiar Doméstico

<p align="center">
  <strong>Tu asistente IA, en tu casa. Para toda la familia.</strong>
</p>

<p align="center">
  <a href="https://github.com/Cradel-co/clawmint/actions"><img src="https://img.shields.io/github/actions/workflow/status/Cradel-co/clawmint/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <img src="https://img.shields.io/badge/Node-%3E%3D22-brightgreen?style=for-the-badge&logo=node.js&logoColor=white" alt="Node 22+">
  <img src="https://img.shields.io/badge/Stack-React%20%2B%20Vite%20%2B%20Express-blue?style=for-the-badge" alt="Stack">
  <img src="https://img.shields.io/badge/IA-Claude%20%7C%20Gemini%20%7C%20OpenAI%20%7C%20Ollama-purple?style=for-the-badge" alt="IA providers">
</p>

**Clawmint** es un agente familiar doméstico que corre en tu propio hardware (Raspberry Pi, mini PC, NAS). Cada miembro del hogar accede desde Telegram o el navegador. El agente gestiona correos, calendario, recordatorios, tareas y más — todo privado, todo local.

[Visión del proyecto](docs/vision.md) · [Inicio rápido](#inicio-rápido--desarrollo) · [Producción](#inicio-en-producción) · [Documentación](docs/README.md) · [Roadmap](ROADMAP.md)

---

## Qué hace

- **Asistente personal para cada miembro** — cada usuario tiene su contexto, ubicación, rutinas
- **Multi-usuario con aprobación** — primer user es admin auto, los demás esperan aprobación o entran via invitación de un solo uso (link/QR)
- **Datos compartidos del hogar** — mercadería, eventos familiares (con alertas automáticas), notas, vencimientos de servicios, inventario
- **Briefings proactivos** — morning/bedtime/weather alerts entregados via Telegram a la hora que cada uno configura (sin pedirlo)
- **Acceso desde Telegram** — sin instalar nada, desde el celular
- **Mission Control dashboard** — métricas live (CPU/RAM/Disk/uptime), weather widget, multi-agent grid
- **Múltiples IAs** — Claude, Gemini, OpenAI, Grok, Ollama (local) — configurables por usuario
- **Memoria persistente** — recuerda preferencias, contexto, conversaciones previas
- **Voz** — TTS multi-proveedor (Edge TTS, Piper, ElevenLabs, OpenAI, Google)
- **Instalable sin .env** — primer arranque genera secrets; OAuth credentials de Google/GitHub/Spotify se setean desde el panel admin (cifradas con TokenCrypto)
- **Extensible** — 130+ MCP tools modulares (clima, dólar, recetas, mercadería, eventos, etc.). Agregar más tools nativas o vía MCP servers externos sin tocar el core
- **Privado** — corre en tu casa, tus datos no salen de tu red (excepto APIs de IA y el clima)

---

## Cómo funciona

```
Telegram / Navegador / Voz
        |
        v
+-------------------------------+
|          Clawmint             |
|    (servidor en tu casa)      |
|    http://localhost:3001      |
+---------------+---------------+
                |
                +-- Conversacion IA (Claude / Gemini / OpenAI / Grok / Ollama)
                +-- Multi-usuario (admin + invitaciones + status approval)
                +-- Datos compartidos del hogar (mercaderia, eventos, notas, servicios)
                +-- Memoria persistente por usuario
                +-- Rutinas proactivas (morning/bedtime briefs + weather alerts)
                +-- Mission Control dashboard (stats live, clima, agentes)
                +-- Terminal PTY (modo admin)
                +-- 130+ MCP tools (shell, git, files, weather, dolar, recetas, hogar, ...)
```

---

## Inicio rápido — desarrollo

Runtime: **Node >= 22**.

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

Al primer arranque el servidor detecta que no existe `bots.json` y lo crea automaticamente desde las variables de entorno.

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

## Inicio en produccion

**No requiere `.env` para arrancar** — primer uso genera `JWT_SECRET` y todas las credenciales se setean desde el panel admin de la UI (cifradas en SQLite con TokenCrypto).

### 1. Build del cliente

```bash
cd client && npm run build
# El server sirve client/dist/ desde el mismo origen (puerto 3001).
```

### 2. Servidor con PM2 — perfil prod

```bash
cd server
pm2 start ecosystem.config.js --only clawmint-prod
pm2 save
pm2 startup   # opcional: auto-start al boot
```

El perfil `clawmint-prod` usa `NODE_ENV=production`, sin watch, autorestart, max-memory 1GB, logs separados en `server/logs/prod-out.log` + `prod-err.log`. Activa security headers (X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) y `trust proxy`.

### 3. Primer arranque

1. Abrí `http://<host>:3001/`.
2. El primer usuario que se registre queda como **admin con status active** automáticamente.
3. Configurá OAuth credentials (Google/GitHub/Spotify) desde `Configuración → OAuth Creds`.
4. Invitá al resto de la familia desde `Configuración → Usuarios → Invitar miembro`.

---

## Stack

| Capa | Tecnologia |
|---|---|
| Runtime | Node.js 22+ (CommonJS) |
| HTTP / WS | Express 4 + `ws` |
| IA | Anthropic, Gemini, OpenAI, Grok, Ollama |
| Canales | Telegram Bot API + WebChat + P2P |
| Cliente | React 18 + Vite |
| Persistencia | SQLite (sql.js WASM) + JSON |
| TTS | Edge TTS, Piper, ElevenLabs, OpenAI, Google |
| Integraciones | Google Calendar, Gmail, Tasks (en desarrollo) |

---

## Documentacion

| Documento | Contenido |
|---|---|
| [docs/vision.md](docs/vision.md) | Vision del proyecto, principios, integraciones objetivo |
| [docs/architecture.md](docs/architecture.md) | Arquitectura del sistema, modulos y flujo de datos |
| [docs/README.md](docs/README.md) | Indice completo de documentacion |
| [ROADMAP.md](ROADMAP.md) | Estado actual y proximas fases |

---

## Comandos de Telegram

| Comando | Descripcion |
|---|---|
| `/start` | Inicio de sesion |
| `/nueva` | Nueva conversacion |
| `/registro <clave>` | Registrarse con clave de invitacion |
| `/modelo [nombre]` | Ver o cambiar modelo |
| `/provider [nombre]` | Cambiar provider de IA |
| `/modo [ask\|auto\|plan]` | Modo de permisos |
| `/agentes` | Listar agentes disponibles |
| `/costo` | Costo estimado de la sesion |
| `/estado` | Estado del chat |
| `/ayuda` | Todos los comandos |

---

## Archivos excluidos del repo

| Archivo | Descripcion |
|---|---|
| `server/.env` | Variables de entorno locales |
| `server/bots.json` | Tokens y estado de bots |
| `server/agents.json` | Agentes creados desde la UI |
| `server/provider-config.json` | API keys de providers |
| `server/logs.json` / `server/server.log` | Logs |
| `server/memory/` | Memoria por agente |
| `server/skills/` | Skills instalados |
