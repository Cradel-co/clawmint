> Última actualización: 2026-03-17

# Frontend

Aplicación React 18 + Vite. Se conecta al servidor en `http://localhost:3001` vía HTTP y WebSocket.

---

## Stack

| Herramienta | Versión | Uso |
|-------------|---------|-----|
| React | 18.3 | UI y estado global |
| Vite | 5.4 | Bundler y dev server |
| @xterm/xterm | 5.5 | Emulador de terminal |
| @xterm/addon-fit | 0.10 | Autoajuste de tamaño |
| @xterm/addon-web-links | 0.11 | Links clicables en terminal |

---

## Estructura de archivos

```
client/src/
├── App.jsx              # Estado global + tabs + layout raíz
├── main.jsx             # Punto de entrada React
├── App.css              # Estilos globales
└── components/
    ├── TerminalPanel.jsx   # Panel xterm.js + WebSocket (uno por sesión)
    ├── TabBar.jsx          # Barra de pestañas de sesiones
    ├── CommandBar.jsx      # Barra de comandos rápidos
    ├── AgentsPanel.jsx     # CRUD de agentes
    ├── TelegramPanel.jsx   # Gestión de bots Telegram
    ├── ProvidersPanel.jsx  # Configuración de providers de IA
    └── McpsPanel.jsx       # Gestión de MCPs
```

---

## App.jsx — Estado global

```javascript
// Estado principal
const [sessions, setSessions] = useState([])
// session: { id, title, command, type, httpSessionId, provider }

const [activeId, setActiveId] = useState(null)    // pestaña activa
const [telegramOpen, setTelegramOpen] = useState(false)
const [agentsOpen, setAgentsOpen] = useState(false)
const [providersOpen, setProvidersOpen] = useState(false)
```

**Flujo de creación de sesión:**
1. Usuario hace clic en "Nueva sesión" o usa CommandBar
2. `App.jsx` llama `POST /api/sessions` → obtiene `httpSessionId`
3. Agrega la sesión al array con metadata
4. El `TerminalPanel` correspondiente abre un WS con `{ type: 'init', sessionId: httpSessionId }`

---

## TerminalPanel.jsx

Componente principal. Gestiona un terminal xterm.js conectado al servidor por WebSocket.

### Características

| Característica | Implementación |
|----------------|----------------|
| Terminal visual | `@xterm/xterm` con tema oscuro |
| Streaming bidireccional | WebSocket nativo |
| Autoajuste de tamaño | `FitAddon` + `ResizeObserver` |
| Links clicables | `WebLinksAddon` |
| Reconexión automática | Backoff exponencial (5 intentos: 1s → 2s → 4s → 8s → 16s) |
| Persistencia de sesión | `sessionId` guardado en estado; se pasa al reconectar |
| Scrollback | 1000 líneas |

### Protocolo WS en TerminalPanel

```javascript
// 1. Abrir WS y enviar init
ws.send(JSON.stringify({
  type: 'init',
  sessionType: session.type,
  sessionId: session.httpSessionId,
  provider: session.provider,
  agentKey: session.agentKey,
  cols: terminal.cols,
  rows: terminal.rows,
}))

// 2. Reenviar input del usuario al servidor
terminal.onData(data => ws.send(JSON.stringify({ type: 'input', data })))

// 3. Recibir output y escribir en terminal
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data)
  if (msg.type === 'output') terminal.write(msg.data)
  if (msg.type === 'exit') terminal.write('\r\n[proceso terminado]\r\n')
  if (msg.type === 'session_id') { /* guardar sessionId */ }
}

// 4. Al redimensionar
terminal.onResize(({ cols, rows }) =>
  ws.send(JSON.stringify({ type: 'resize', cols, rows }))
)
```

---

## TabBar.jsx

Barra de pestañas con las sesiones activas. Permite crear nueva sesión, renombrar y cerrar. Se comunica con `App.jsx` vía props.

---

## CommandBar.jsx

Barra de comandos rápidos para crear sesiones predefinidas (bash, claude, etc.). Lee la lista de agentes desde `GET /api/agents` para generar botones dinámicos.

---

## AgentsPanel.jsx

Panel lateral para gestión de agentes.

- **GET /api/agents** — cargar lista
- **POST /api/agents** — crear agente
- **PATCH /api/agents/:key** — editar
- **DELETE /api/agents/:key** — eliminar

---

## TelegramPanel.jsx

Panel lateral para gestión de bots Telegram.

- **GET /api/telegram/bots** — listar bots y sus chats
- **POST /api/telegram/bots** — agregar bot (key + token)
- **DELETE /api/telegram/bots/:key** — eliminar
- **POST /api/telegram/bots/:key/start** / **stop** — control
- **PATCH /api/telegram/bots/:key** — editar configuración
- **POST /api/telegram/bots/:key/chats/:chatId/session** — vincular PTY
- **DELETE /api/telegram/bots/:key/chats/:chatId** — desconectar

---

## ProvidersPanel.jsx

Panel para configurar API keys y modelos por provider.

- **GET /api/providers** — listar providers disponibles
- **GET /api/providers/config** — leer config actual
- **PUT /api/providers/:name** — actualizar key/modelo
- **PUT /api/providers/default** — cambiar provider por defecto

---

## McpsPanel.jsx

Panel para gestionar Model Context Protocols.

- **GET /api/mcps** — listar MCPs
- Buscar en Smithery
- Instalar / desinstalar
- Sincronizar con Claude CLI

---

## Dev server

```bash
cd client && npm run dev
# → http://localhost:5173
# Proxy configurado en vite.config.js: /api → http://localhost:3001
```

Vite proxea todas las peticiones `/api/*` y WS al servidor, evitando problemas de CORS en desarrollo.
