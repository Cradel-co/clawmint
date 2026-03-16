> Última modificación: 2026-03-16

# Módulo Cliente

Frontend React + Vite que provee la interfaz web del terminal, la gestión de bots de Telegram, agentes, skills, providers y memoria.

---

## Índice

- [Estructura de archivos](#estructura-de-archivos)
- [Stack](#stack)
- [Componentes](#componentes)
  - [App.jsx](#appjsx)
  - [TabBar.jsx](#tabbарjsx)
  - [TerminalPanel.jsx](#terminalpaneljsx)
  - [TelegramPanel.jsx](#telegrampaneljsx)
  - [AgentsPanel.jsx](#agentspaneljsx)
  - [ProvidersPanel.jsx](#providerspaneljsx)
  - [McpsPanel.jsx](#mcpspaneljsx)
  - [CommandBar.jsx](#commandbarjsx)
- [WebSocket y reconexión](#websocket-y-reconexión)
- [Build para producción](#build-para-producción)
- [Variables de entorno del cliente](#variables-de-entorno-del-cliente)

---

## Estructura de archivos

```
client/
├── src/
│   ├── App.jsx                  # Raíz: layout, tabs, estado global
│   └── components/
│       ├── TabBar.jsx           # Barra de pestañas de terminales
│       ├── TabBar.css
│       ├── TerminalPanel.jsx    # Terminal xterm.js + WebSocket
│       ├── TelegramPanel.jsx    # Panel de bots y chats de Telegram
│       ├── TelegramPanel.css
│       ├── AgentsPanel.jsx      # Gestión de agentes de rol
│       ├── AgentsPanel.css
│       ├── ProvidersPanel.jsx   # Configuración de providers de IA
│       ├── McpsPanel.jsx        # Panel de MCPs
│       └── CommandBar.jsx       # Barra de comandos global
│           CommandBar.css
├── index.html
├── vite.config.js
└── package.json
```

---

## Stack

| Tecnología | Uso |
|---|---|
| React 18 | UI declarativa con hooks |
| Vite | Dev server con HMR + build |
| xterm.js (`@xterm/xterm`) | Emulador de terminal en el navegador |
| `@xterm/addon-fit` | Redimensionado automático del terminal |
| `@xterm/addon-web-links` | Links clickeables en el terminal |

---

## Componentes

### App.jsx

Raíz de la aplicación. Maneja:

- Estado global de tabs (terminales abiertas)
- Routing entre paneles (Terminal, Telegram, Agentes, Providers, MCPs)
- Creación de nuevas sesiones PTY, AI y bash desde la CommandBar
- Broadcast de eventos Telegram recibidos por WS

Cada tab de terminal tiene:
```js
{
  id: string,          // UUID local
  type: 'pty'|'ai',
  title: string,
  command: string|null,
  provider: string|null,
  httpSessionId: string|null,
  sessionId: string|null,   // asignado por el servidor al conectar
}
```

### TabBar.jsx

Barra horizontal de pestañas. Soporta scroll horizontal cuando hay muchas tabs. Cada tab muestra el título y un botón de cierre. La tab activa se resalta.

### TerminalPanel.jsx

Terminal completo basado en xterm.js conectado al servidor por WebSocket.

**Ciclo de vida:**
1. Al montar: inicializa el terminal xterm.js y llama a `connect()`
2. `connect()`: abre el WS y envía `init` con `sessionType`, `command`, `provider` y el `sessionId` previo si existe
3. Al recibir `session_id`: lo guarda en `sessionIdRef` para reconexiones
4. Al recibir `output`: escribe en el terminal
5. Al cerrar WS inesperadamente: reconexión automática (ver sección [WebSocket y reconexión](#websocket-y-reconexión))
6. Al desmontar: marca `manualCloseRef = true` y cierra el WS

Incluye una barra de input inferior para dispositivos sin teclado físico.

### TelegramPanel.jsx

Panel de gestión de bots de Telegram. Permite:

- Ver y agregar bots (con token)
- Iniciar/detener bots
- Ver chats activos por bot
- Configurar whitelist, rate limit, agente por defecto
- Recibir notificaciones en tiempo real de mensajes entrantes via WS (`telegram_session`)

### AgentsPanel.jsx

CRUD de agentes de rol. Permite crear, editar y eliminar agentes con:

- Key, descripción, comando
- System prompt
- Provider de IA (selector de providers configurados)
- Archivos de memoria asociados

### ProvidersPanel.jsx

Configuración de providers de IA. Muestra todos los providers disponibles (Anthropic, Gemini, OpenAI, Claude Code) con su estado de configuración (API key presente/ausente) y permite:

- Ingresar o actualizar API keys
- Cambiar el modelo por defecto de cada provider
- Seleccionar el provider por defecto global

### McpsPanel.jsx

Panel de configuración de Model Context Protocol (MCP). Permite agregar y gestionar servidores MCP que amplían las capacidades de los agentes.

### CommandBar.jsx

Barra de comandos en la parte inferior de la pantalla. Acepta comandos como:

| Comando | Acción |
|---|---|
| `/nueva` o vacío + Enter | Nueva terminal PTY |
| `/bash` | Nueva terminal Bash |
| `/ai [provider]` | Nueva sesión AI con provider opcional |
| `/claude` | Nueva sesión Claude Code |

---

## WebSocket y reconexión

`TerminalPanel.jsx` implementa reconexión automática con **exponential backoff**:

| Intento | Espera |
|---|---|
| 1 | 1s |
| 2 | 2s |
| 3 | 4s |
| 4 | 8s |
| 5 | 16s |

Después de 5 intentos fallidos muestra `[no se pudo reconectar — recargá la página]`.

Al reconectar, el cliente envía el `sessionId` guardado en el mensaje `init`. El servidor:
- Para sesiones **PTY**: retoma la sesión existente y envía el historial de output acumulado
- Para sesiones **AI**: recupera el historial de conversación del Map `aiSessionHistories` (válido hasta 24h desde el último mensaje)

El cierre manual (desmonte del componente) no dispara reconexión: se usa `manualCloseRef` para distinguirlo de un cierre inesperado.

---

## Build para producción

```bash
cd client
npm run build
```

Genera `client/dist/`. Configurar el servidor web para servir ese directorio y hacer proxy de `/api` y el WebSocket (`/`) al backend en `localhost:3001`.

**Ejemplo nginx:**

```nginx
server {
    listen 80;
    server_name tu-dominio.com;

    root /ruta/a/clawmint/client/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://localhost:3001;
    }

    location /ws {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

---

## Variables de entorno del cliente

Crear `client/.env.local` (ignorado por git):

| Variable | Descripción | Default |
|---|---|---|
| `VITE_WS_URL` | URL del servidor WebSocket | `ws://localhost:3001` |
| `VITE_API_URL` | URL base de la API REST | `http://localhost:3001` |

Si no se definen, el cliente usa `localhost:3001` por defecto.
