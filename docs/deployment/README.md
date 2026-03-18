> Última actualización: 2026-03-17

# Deployment

---

## Índice

| Documento | Descripción |
|-----------|-------------|
| Este README | Setup básico, variables de entorno, PM2, Nginx |
| [docker.md](./docker.md) | Deploy con Docker (multi-stage build, volúmenes, Claude CLI) |

---

## Entornos

| Entorno | Descripción |
|---------|-------------|
| **Desarrollo local** | `npm start` (servidor) + `npm run dev` (cliente Vite) |
| **Producción nativa** | Servidor Node.js + cliente compilado en `client/dist/` |
| **Docker** | Ver [docker.md](./docker.md) |

---

## Arranque en producción

```bash
# 1. Compilar cliente
cd client && npm run build

# 2. Arrancar servidor (sirve también el cliente compilado en /)
cd server && node --stack-size=65536 --env-file-if-exists=.env index.js
```

El servidor sirve `client/dist/` estáticamente en la raíz `/`.

---

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3001` | Puerto HTTP del servidor |
| `BOT_TOKEN` | — | Token del bot Telegram (opcional; también vía UI) |
| `BOT_KEY` | `dev` | Nombre interno del bot (para bots.json) |
| `BOT_DEFAULT_AGENT` | `claude` | Agente por defecto del bot |
| `BOT_WHITELIST` | vacío (todos) | IDs de chats privados permitidos, separados por coma |
| `BOT_GROUP_WHITELIST` | vacío (todos) | IDs de grupos permitidos, separados por coma |
| `BOT_RATE_LIMIT` | `30` | Mensajes/hora por chat (0 = sin límite) |
| `BOT_RATE_LIMIT_KEYWORD` | — | Palabra para resetear el límite de rate |
| `ANTHROPIC_API_KEY` | — | API key Anthropic (alternativa: UI) |
| `GOOGLE_API_KEY` | — | API key Google Gemini (alternativa: UI) |
| `OPENAI_API_KEY` | — | API key OpenAI (alternativa: UI) |
| `DEBUG_MEMORY` | `0` | `1` = logs detallados del sistema de memoria |

---

## Compatibilidad WSL2

El servidor incluye dos workarounds específicos para WSL2:

1. **`--stack-size=65536`** en el comando de arranque: node-pty crashea con el stack default en WSL2.
2. **IPv4 forzado** en peticiones HTTPS salientes (Telegram API): WSL2 tiene problemas con IPv6 en algunos entornos.
3. **Limpieza de env**: se eliminan `CLAUDECODE` y `CLAUDE_CODE_ENTRYPOINT` del entorno al spawnear PTYs para evitar conflictos con la CLI de Claude.

---

## Persistencia

Todos los datos en runtime se guardan localmente en `server/`:

```
server/
├── memory/index.db          # SQLite (notas, tags, links, cola, chat_settings)
├── memory/<agentKey>/       # Archivos .md de memoria por agente
├── agents.json              # Agentes creados
├── bots.json                # Tokens y estado de bots Telegram
├── provider-config.json     # API keys y configuración de providers
├── reminders.json           # Recordatorios activos
├── mcps/                    # MCPs registrados
├── skills/                  # Skills instalados
├── logs.json                # Configuración de logs
└── server.log               # Log del servidor (rotación manual via API)
```

No hay base de datos externa. Todo es local y portable.

---

## Gestión de logs

| Operación | Comando |
|-----------|---------|
| Ver últimas 100 líneas | `GET /api/logs/tail?lines=100` |
| Deshabilitar logging | `POST /api/logs/config` con `{"enabled": false}` |
| Limpiar log | `DELETE /api/logs` |

Los errores (`level: ERROR`) se loguean siempre, independientemente de la configuración.

---

## PM2 (opcional)

```bash
# ecosystem.config.js
module.exports = {
  apps: [{
    name: 'clawmint',
    script: 'server/index.js',
    node_args: '--stack-size=65536',
    env: {
      PORT: 3001,
      NODE_ENV: 'production'
    }
  }]
}

pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

---

## Nginx (proxy reverso, opcional)

```nginx
server {
  listen 80;
  server_name tu-dominio.com;

  location / {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400;   # necesario para WebSocket de larga duración
  }
}
```
