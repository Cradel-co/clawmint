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

---

## Componentes nuevos (v1.5.0)

### Dashboard.jsx (Mission Control)

Landing default. Reemplaza la pantalla anterior con un dashboard modular:

- **Hero**: título "Mission Control" + hostname + uptime pill + status LIVE/SYNC/OFFLINE.
- **Métricas live** (poll 3s a `/api/system/stats`): 4 tiles grandes — CPU%, Memoria, Disco, Uptime — con barras de progreso coloreadas (verde <70% / amarillo 70-90% / rojo >90%).
- **WeatherWidget**: hook `useWeather` que prioriza coords así: user pref (`/api/user-preferences/location`) → server location (`/api/system/location`) → localStorage cache → browser geo → fallback Madrid. Open-Meteo, sin API key. Refresca cada 15min.
- **Status grid**: WebSocket clients, Sesiones PTY, Telegram bots running, Providers IA configurados, P2P Nodriza (si enabled).
- **Multi-Agent System grid**: cards coloreadas por agente con name + model + status.

### HouseholdPanel.jsx

Sección "Hogar" en sidebar (grupo Familia, color naranja). 5 tabs:
- **Mercadería** (`grocery_item`) — list interactivo con check/uncheck + cantidad + delete. Form al tope para agregar.
- **Eventos** (`family_event`) — date picker + tipo (cumple/cita/reunión) + alert days before. Badge "vence en Nd" en rojo si <3 días.
- **Notas** (`house_note`) — title + content + tags. Para info estable: wifi, plomero, escuela.
- **Servicios** (`service`) — name + dueDate + amount/currency. Marca pagado o vencido en rojo si <5 días.
- **Inventario** (`inventory`) — items de heladera/despensa con cantidad y location.

REST: `/api/household/:kind` CRUD + `complete/uncomplete`. Permiso: cualquier user `status='active'`.

### OAuthCredentialsPanel.jsx (admin)

Tab en `Configuración → OAuth Creds` para configurar credentials de OAuth providers sin tocar `.env`. 3 cards (Google, GitHub, Spotify):

- Form: client_id (text) + client_secret (password con toggle eye/eye-off).
- Muestra los redirect URIs a registrar en cada provider.
- Botones Guardar / Limpiar / Docs (link al provider).
- Status badge "Configurado" verde si ya seteado, "Sin credenciales" gris.

REST: `GET /api/system-config/oauth` + `PUT /api/system-config/oauth/:provider`.

### IntegrationsPanel.jsx

Hub catálogo con cards de servicios externos conocidos (Google Calendar, Gmail, Drive, Tasks, Spotify, Home Assistant, Slack, Discord, Telegram, Web Search, SQLite). Auto-detecta MCPs configurados → estado "Conectada" / "No configurada". Filtros por categoría (Google/Hogar/Media/Comms/Datos).

Click "Configurar" abre modal con el JSON listo para copiar al panel MCPs (sin OAuth) o link al wizard MCP OAuth.

### DevicesPanel.jsx + MusicPanel.jsx

Placeholders para Home Assistant y Spotify. Detectan si el MCP correspondiente está configurado. Si no, setup guides paso a paso. Si sí, ejemplos de comandos para usar desde el chat.

### StatusFooter.jsx

Barra fija al pie de la app, persistente en todas las secciones. Muestra:
- CPU%, RAM (used/total), Disco% — barras coloreadas según umbral.
- Uptime del server.
- Sesiones PTY activas.
- Bots Telegram running.
- P2P peers (si nodriza enabled).
- Status WebSocket "ONLINE/OFFLINE" pill.

Poll cada 5s a `/api/system/stats`. Pausa cuando la pestaña está oculta (visibility API).

### UserLocationSection.jsx

Dentro de ProfilePanel. Form con search box que llama a Nominatim (OSM) y muestra hasta 5 sugerencias. Click en sugerencia rellena lat/lon. Persiste en `userPreferencesRepo` (key `location`). El widget de clima del Dashboard la usa automáticamente con prioridad sobre browser geo.

### UserRoutinesSection.jsx

Dentro de ProfilePanel. 3 cards (Morning brief / Bedtime brief / Weather alert) con time picker + (umbral lluvia para weather) + toggle Activar/Desactivar. Guarda en `userPreferencesRepo` (key `routine_pref:<type>`). El agente activa el cron real cuando el user le pide "activá mi rutina morning".

---

## Layout y navegación (v1.5.0)

### Sidebar (NAV_GROUPS)

7 grupos labeled (definidos en `sectionMeta.js`):

| Grupo | Sections |
|---|---|
| Overview | dashboard |
| Control | terminal, chat |
| Comms | telegram, contacts |
| Familia | household |
| Productividad | tasks, scheduler, skills |
| Servicios | integrations, devices, music |
| Settings | config |

Sidebar collapsable (icon-only ↔ labeled). Items gated por `SECTION_FLAGS` (env var `VITE_FEATURE_*`). Scroll interno con scrollbar custom delgado cuando hay muchos items.

### AppHeader

- Brand a la izquierda (Claw**mint** v1.0) — click va al Dashboard.
- Search bar central (placeholder, no funcional aún — UX shortcut).
- Health pill ("Health OK" verde / "Health DOWN" rojo con pulse) según `wsConnected`.
- **Bell icon** con badge naranja para admin si hay users pending (poll a `/api/auth/admin/users/pending/count` cada 30s, pausa en tab oculta). Click va a `Configuración → Usuarios`.
- User avatar + theme toggle + power (logout).

### Paleta visual (warm-only)

```
--accent-orange  #f97316   (primary brand)
--accent-red     #ef4444   (errors, badges)
--accent-amber   #fbbf24   (alias --accent-cyan, info/secondary)
--accent-peach   #fb923c   (alias --accent-blue, telegram/peach)
--accent-yellow  #f59e0b   (warnings)
--accent-green   #10b981   (success)
--accent-purple  #a855f7   (contacts)
--accent-pink    #ec4899   (events)

--bg-primary     #0a0a0c   (near-black)
--bg-card        #16161a
--bg-secondary   #111114
--text-primary   #f5f5f7
```

### WS reconnect (lib/wsManager.js)

- Backoff exponencial los primeros 5 intentos (1s, 2s, 4s, 8s, 16s).
- Después: cap a 30s entre intentos **forever** — antes se rendía a los 5.
- Método `forceReconnect()` que resetea contador y conecta inmediato.
- `lib/listenerWs.js` agrega listeners `visibilitychange` y `online` que llaman `forceReconnect()` al volver a la tab o al recuperar red.
- `ReconnectBanner.jsx` con grace period 1.5s al mount inicial — no parpadea durante el handshake normal.
