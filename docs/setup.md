> Última actualización: 2026-03-17

# Setup e instalación

## Requisitos

| Herramienta | Versión mínima | Notas |
|-------------|----------------|-------|
| Node.js | 22+ | Se requiere `--env-file-if-exists` |
| npm | 10+ | Viene con Node 22 |
| Claude CLI | última | `npm install -g @anthropic-ai/claude-code` |
| Python 3 + faster-whisper | opcional | Solo para transcripción de audio |

## Instalación

```bash
# 1. Clonar el repositorio
git clone <repo-url>
cd terminal-live

# 2. Instalar dependencias del servidor
cd server && npm install

# 3. Instalar dependencias del cliente
cd ../client && npm install
```

## Configuración

### Variables de entorno

Crear `server/.env` a partir del template:

```env
PORT=3001

# Bot Telegram (opcional — también se puede configurar desde la UI)
BOT_TOKEN=123456789:AAF...
BOT_KEY=dev
BOT_DEFAULT_AGENT=claude
BOT_WHITELIST=123456789            # chat IDs separados por coma; vacío = todos
BOT_GROUP_WHITELIST=               # group IDs; vacío = todos
BOT_RATE_LIMIT=30                  # mensajes por hora (0 = sin límite)
BOT_RATE_LIMIT_KEYWORD=            # palabra para resetear el límite

# API keys de providers IA (alternativa: configurar desde la UI)
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AIza...
OPENAI_API_KEY=sk-...

# Debug
DEBUG_MEMORY=1                     # logs detallados del sistema de memoria
```

### Configuración de providers (UI)

Acceder a `http://localhost:5173` → icono de providers (arriba a la derecha) → ingresar API keys y seleccionar modelos.

Se persiste en `server/provider-config.json` (no versionado).

## Iniciar en desarrollo

```bash
# Terminal 1 — servidor
cd server && npm start
# → http://localhost:3001

# Terminal 2 — cliente
cd client && npm run dev
# → http://localhost:5173
```

> **Nota WSL2:** El servidor usa `--stack-size=65536` para evitar crashes de node-pty en WSL2. Si se usa PM2 u otro process manager, agregar ese flag al comando de inicio.

## Archivos generados en runtime

Los siguientes archivos se crean automáticamente y **no se versionan**:

| Archivo/Directorio | Descripción |
|--------------------|-------------|
| `server/bots.json` | Tokens y estado de bots Telegram |
| `server/agents.json` | Agentes creados |
| `server/provider-config.json` | API keys y modelos configurados |
| `server/logs.json` | Configuración de logs |
| `server/server.log` | Log del servidor |
| `server/memory/` | Base de datos SQLite y archivos de memoria por agente |
| `server/skills/` | Skills instalados desde ClawHub |
| `server/mcps/` | MCPs registrados |
| `client/dist/` | Build de producción |

## Build de producción

```bash
# Compilar cliente
cd client && npm run build
# → genera client/dist/

# El servidor sirve client/dist/ en /
# (ver rutas estáticas en server/index.js)
```

## Transcripción de audio (opcional)

Requiere Python + faster-whisper instalado:

```bash
python3 -m venv ~/.venvs/whisper
source ~/.venvs/whisper/bin/activate
pip install faster-whisper
```

La ruta del venv se puede sobrescribir en `server/transcriber.js` → variable `PYTHON_BIN`.
