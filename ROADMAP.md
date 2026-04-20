# Roadmap Clawmint — Agente Familiar Doméstico

> Ver [docs/vision.md](docs/vision.md) para la visión completa del proyecto.

## Estado actual (2026-04-19)

### Infraestructura completada (sesiones 1-5)
- [x] PtySession idle timeout, ShellSession cleanup, log rotation, índices SQLite
- [x] Retry 3x con backoff, rate limit, timeout 120s, resume tras restart
- [x] Refactor index.js 1704→170 LOC (routes/ + ws/ modules)
- [x] Refactor TelegramChannel 1580→400 LOC, webhook mode, outbound throttle
- [x] Frontend: responsive, accesibilidad WCAG AA, performance, WebChat status
- [x] MCP tools: **130+ herramientas** modulares en 32 archivos (bash, git, files, pty, memory, telegram, webchat, critter, location, environment, finance, briefs, household, routines, etc.)
- [x] 6 providers IA: Anthropic, Claude Code CLI, Gemini, OpenAI, Grok, Ollama
- [x] TTS multi-proveedor: Edge TTS, Piper, ElevenLabs, OpenAI, Google
- [x] Memoria persistente: SQLite + embeddings + consolidación automática
- [x] Canales: Telegram, WebChat, P2P (deskcritter)
- [x] Modos ask/auto/plan para todos los providers
- [x] Tracking de costo por provider
- [x] Sliding window: compresión automática de historial
- [x] **Production setup** — PM2 perfil `clawmint-prod`, security headers, JWT auto-persist, instalable sin `.env`
- [x] **Mission Control dashboard** — landing default con stats live (CPU/RAM/Disk) + clima + multi-agent grid + sidebar reorganizado en 7 grupos labeled
- [x] **Paleta visual warm-only** (orange/amber/peach/red) reemplaza navy/cyan

### Issues abiertos (infraestructura)
- #57 Lighthouse Performance: build producción + sourcemaps off
- #63 Orquestación multi-agente con AgentOrchestrator
- #64 Live Canvas — workspace visual generado por agentes

---

## Fase 1 — Multi-usuario (#152)

**Objetivo**: Cada miembro de la familia tiene su identidad y contexto.

### 1.1 Modelo de datos
- Tablas: `users`, `channels`, `access_keys`
- Roles: admin, miembro, invitado
- Relación padre→hijo con `parent_id`

### 1.2 Registro por invitación
- Admin crea usuario → genera clave temporal (8h de expiración)
- Hijo envía `/registro <clave>` → se vincula su identidad (Telegram/WebChat)
- Renovación: solo si la clave anterior expiró o fue usada
- Sin límite de claves por canal

### 1.3 Contexto por usuario
- Historial de conversación separado por usuario
- Memoria persistente por usuario (no solo por agente)
- Permisos: padre ve todo, hijo ve solo lo suyo

### 1.4 Comandos
- `/crear_usuario nombre:X rol:miembro` (solo admin)
- `/registro <clave>` (nuevo usuario)
- `/usuarios` (listar miembros del hogar, solo admin)

**Archivos clave**: `server/storage/`, `server/services/ConversationService.js`, `server/channels/`

---

## Fase 2 — Integraciones core (OAuth2 + Google)

**Objetivo**: El agente accede a correo, calendario y tareas de cada miembro.

### 2.1 OAuth2 para Google
- Flujo de autorización por usuario
- Almacenar tokens (access + refresh) cifrados en SQLite
- Renovación automática de tokens expirados
- Endpoint: `/api/auth/google/connect` → redirige a Google → callback

### 2.2 Google Calendar
- MCP tools: `calendar_list_events`, `calendar_create_event`, `calendar_delete_event`
- Consultar eventos de hoy, esta semana, rango personalizado
- Crear eventos con título, fecha, hora, descripción
- Alertas: "Tienes cita en 30 minutos"

### 2.3 Gmail
- MCP tools: `email_list`, `email_read`, `email_send`, `email_search`
- Listar correos no leídos, filtrar por importancia
- Resumir correos largos con IA
- Responder correos (con confirmación del usuario)

### 2.4 Google Tasks
- MCP tools: `tasks_list`, `tasks_create`, `tasks_complete`, `tasks_delete`
- Listas de compras compartidas por el hogar
- Tareas asignadas por miembro
- "Agrega leche a la lista de compras"

**Archivos nuevos**: `server/mcp/tools/calendar.js`, `server/mcp/tools/email.js`, `server/mcp/tools/tasks.js`, `server/auth/google-oauth.js`

---

## Fase 3 — Rutinas proactivas

**Objetivo**: El agente no solo responde, también avisa y actúa por iniciativa propia.

### 3.1 Scheduler de rutinas
- Definir rutinas por usuario: "cada mañana a las 7:00"
- Ejecutar acciones: consultar calendario, correo, clima → componer resumen
- Enviar por Telegram/WebChat al usuario

### 3.2 Resumen matutino
- Eventos del día (Calendar)
- Correos importantes sin leer (Gmail)
- Tareas pendientes (Tasks)
- Clima y pronóstico
- Personalizado por miembro

### 3.3 Alertas contextuales
- "Tienes cita en 30 min" (Calendar)
- "Llegó un correo de [contacto importante]" (Gmail)
- "Dylan no ha completado sus tareas de hoy"

### 3.4 Clima
- Integración OpenWeather API
- MCP tool: `weather_current`, `weather_forecast`
- "¿Necesito paraguas hoy?"

**Archivos nuevos**: `server/scheduler.js`, `server/mcp/tools/weather.js`

---

## Fase 4 — Dashboard familiar

**Objetivo**: Replantear el web client como panel del hogar.

### 4.1 Vista de inicio
- Eventos del día para el usuario actual
- Tareas pendientes
- Mensajes/correos recientes
- Clima

### 4.2 Gestión de integraciones
- Conectar/desconectar Google (OAuth flow desde el navegador)
- Estado de cada integración por miembro
- Configuración de rutinas

### 4.3 Gestión de miembros
- Panel admin: crear/editar/eliminar usuarios
- Generar claves de invitación
- Ver actividad por miembro

### 4.4 Chat integrado
- WebChat existente, mejorado con contexto de usuario
- Acceso rápido a acciones frecuentes

---

## Fase 5 — Domótica y expansiones

**Objetivo**: El agente controla el hogar y se expande.

### 5.1 Home Assistant (via MCP server existente)
- Ya existen MCP servers maduros para HA: oficial (v2025.2+), `homeassistant-ai/ha-mcp`, `allenporter/mcp-server-home-assistant`
- Clawmint ya soporta MCP servers externos (`server/mcps.js` + `/api/mcps`) — la integración es plug-and-play
- El admin configura la URL del MCP server de HA y las tools aparecen automáticamente para la IA
- No se crea un MCP desde cero — se conecta al existente
- Casos de uso: luces, temperatura, cámaras, sensores, automatizaciones
- "Apaga las luces de la sala", "¿Qué temperatura hay?", "¿Está cerrada la puerta?"

### 5.2 Contactos
- Google Contacts: buscar, consultar
- "¿Cuál es el teléfono de [persona]?"

### 5.3 Google Drive
- Buscar y leer documentos compartidos
- "Busca el presupuesto del mes en Drive"

### 5.4 Música
- Spotify: control de reproducción
- "Ponme música para concentrarme"

---

## Sesiones técnicas pendientes

Estas mejoras técnicas se priorizan según las necesidades de las fases anteriores.

### Búsqueda avanzada (ex sesión 6)
- grep tool (ripgrep con fallback), glob tool
- Tool filtering por contexto (reducir tokens)

### Base de datos (ex sesión 7)
- FTS5 para búsqueda semántica en memoria
- Políticas de retención y backup automático

### Seguridad (ex sesión 8)
- Audit log de tools, dashboard de uso
- Sandbox mode para acceso restringido

### Multi-agente (ex sesión 9 + #63)
- Agentes con tools restringidas por rol
- Handoff entre agentes
- Workflows automatizados

---

## Prioridad de fases

```
Fase 1 — Multi-usuario          ████████████ COMPLETADA (status approval + invitaciones)
Fase 2 — Integraciones Google   ██████░░░░░░ EN PROGRESO (OAuth handlers ready, falta los MCPs reales)
Fase 3 — Rutinas proactivas     ████████████ COMPLETADA (routine_* tools + UI Profile)
Fase 4 — Dashboard familiar     ████████░░░░ EN PROGRESO (Mission Control + Hogar OK; falta gestión avanzada miembros)
Fase 5 — Domótica               ░░░░░░░░░░░░ FUTURO (HA/Spotify via MCPs externos plug-and-play)
```

### Fase 1 — done
- Tabla `users` con columna `status` (active/pending/disabled).
- Primer user → admin auto.
- Demás → pending hasta aprobación admin (UsersPanel) o invitación con `auto_approve=1`.
- Tabla `invitations` + endpoints `/api/auth/admin/invitations` + UI modal con QR/link.
- Endpoints `POST /admin/users/:id/{approve,reject,reactivate}` + `GET /admin/users/pending/count`.
- Bell badge en AppHeader para admin con pendientes (poll 30s).

### Fase 3 — done
- 5 MCP tools `routine_morning_set/bedtime_set/weather_alert/disable/list` que generan crons.
- Sección "Rutinas proactivas" en ProfilePanel con time pickers.
- Briefs proactivos: `day_summary`, `morning_brief`, `bedtime_brief`, `week_ahead`.
- LocationService para auto-resolver coords del clima (user pref > server > args).
- Pack environment: weather, air quality, sun, moon, UV, holidays.

### Fase 4 — partial (lo que falta)
- Vista de actividad por miembro en UsersPanel (login activity, mensajes enviados, comandos invocados).
- Permisos granulares: hoy todos los `status='active'` ven todo el household. Falta restricciones tipo "este hijo no ve los emails del padre".
- Memoria semántica buscable cross-user ("¿qué dijimos sobre vacaciones?") — módulo embeddings ya existe, falta wiring.
- Backup automático de la DB.

### Fase 2 — partial (lo que falta)
- OAuth providers Google/GitHub/Spotify auto-registrables ya están (handlers lazy-leen credenciales de `SystemConfig` o env vars).
- Falta agregar los **MCPs reales** de Calendar/Gmail/Drive/Tasks (vía Smithery o npm) y completar el flujo de tokens persistidos.
- Panel "OAuth Creds" admin para configurar credentials sin `.env` ya está.
