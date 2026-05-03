> Última actualización: 2026-04-19

# Visión — Clawmint como Agente Familiar Doméstico

## Qué es Clawmint

Clawmint es un **agente familiar doméstico**: un asistente de IA que corre en el hogar (Raspberry Pi, mini PC, NAS o cualquier servidor local), accesible para todos los miembros de la familia a través de Telegram, web o voz.

No es una app en la nube. Es **tu** agente, en **tu** casa, con **tus** datos.

## El problema que resuelve

La vida diaria de una familia involucra decenas de micro-gestiones: revisar correos, coordinar horarios, recordar citas, hacer listas de compras, saber quién tiene qué compromiso. Hoy eso se reparte entre 5+ apps que nadie revisa consistentemente.

Clawmint centraliza todo en un solo punto de contacto inteligente que **conoce a cada miembro del hogar** y puede actuar en su nombre.

## Principios

1. **Local-first** — corre en hardware del hogar. Los datos de la familia no salen de casa (excepto las llamadas a APIs de IA y servicios conectados).
2. **Multi-usuario** — cada miembro tiene su identidad, su contexto, sus permisos. El padre administra; los hijos acceden a lo suyo.
3. **Extensible** — nuevas integraciones se agregan como MCP tools sin tocar el core.
4. **Accesible** — Telegram como canal principal: todos lo tienen, no requiere instalar nada.
5. **Proactivo** — no solo responde preguntas. Avisa, recuerda, resume, anticipa.

## Escenarios de uso

### Resumen matutino
> Cada mañana a las 7:00, Clawmint envía a cada miembro un resumen personalizado:
> - Eventos del día (Google Calendar)
> - Correos importantes sin leer (Gmail)
> - Tareas pendientes
> - Clima y si necesita paraguas

### Coordinación familiar
> "¿A qué hora tiene Dylan la clase de inglés?"
> Clawmint consulta el calendario de Dylan y responde al instante.

### Gestión de correo
> "Léeme los correos importantes de hoy"
> Clawmint filtra el spam, resume los correos relevantes, y puede responder por ti.

### Recordatorios y tareas
> "Recuérdame comprar leche cuando salga del trabajo"
> "Agrega pilas a la lista de compras"

### Lista de mercadería compartida del hogar
> Cualquier miembro agrega "manteca" desde Telegram o el panel Hogar; toda la familia la ve. Marcan items como comprados, agregan notas. La lista persiste y es buscable por categoría.

### Eventos familiares con alertas automáticas
> Admin carga el cumple de Tomás (15 junio); el agente avisa N días antes a toda la familia. Sirve para cumpleaños, vencimientos de servicios (gas/luz/internet), citas médicas, reuniones.

### Onboarding familiar
> Admin genera link de invitación desde el panel Usuarios; lo comparte por WhatsApp/SMS. La persona entra al link, se registra, queda activa **al instante** sin esperar aprobación. Cada miembro tiene su rol familiar (mamá, papá, hijo, abuela).

### Briefings proactivos
> Cada miembro configura su rutina en Profile: morning brief 7am + bedtime brief 22:30 + alerta clima si llueve >60% mañana. El agente envía mensajes automáticos via Telegram a la hora indicada (no spamea — solo dispara cuando hay info útil).

### Control del hogar (parcial via MCP plug-and-play)
> "Apaga las luces de la sala"
> "¿Cuánto consumimos de electricidad este mes?"

### Asistente de estudio (futuro)
> Los hijos pueden preguntarle al agente sobre tareas escolares, con acceso controlado por el padre.

## Público objetivo

Familias que quieren un asistente inteligente **privado** y **personalizable**, no atado a ecosistemas cerrados (Alexa, Google Home). Usuarios técnicos que pueden instalar un servidor en casa, o familias que reciben el sistema ya configurado.

## Integraciones objetivo

### Implementadas (free, sin API key)

| Integración | Propósito | Estado |
|-------------|-----------|--------|
| **Open-Meteo** | Clima + air quality + UV index | ✅ |
| **OpenStreetMap Nominatim** | Geocoding de ciudades del user | ✅ |
| **ipwho.is** | IP geo del server (LAN/Tailscale/pública) | ✅ |
| **dolarapi.com** | Cotizaciones del dólar AR (blue/oficial/MEP/CCL/cripto) | ✅ |
| **CoinGecko** | Precios crypto en USD/EUR/ARS | ✅ |
| **open.er-api.com** | Conversión de monedas (cualquier par ISO 4217) | ✅ |
| **Wikipedia REST** | Resúmenes rápidos en es/en/pt | ✅ |
| **TheMealDB** | Recetas con ingredientes y pasos | ✅ |
| **JokeAPI** | Chistes seguros multilenguaje | ✅ |
| **date.nager.at** | Feriados nacionales por país | ✅ |

### Implementadas (OAuth via UI admin — sin .env)

| Integración | Propósito | Estado |
|-------------|-----------|--------|
| **Google OAuth** (Calendar/Gmail/Drive/Tasks) | Un par client_id/secret cubre los 4 | ✅ Auto-registrables vía SystemConfig |
| **GitHub OAuth** | Issues, PRs, repos | ✅ Auto-registrable |
| **Spotify OAuth** | Control de reproducción (requiere Premium) | ✅ Auto-registrable |

### Pendientes (vía MCP plug-and-play del usuario)

| Integración | Propósito | Cómo |
|-------------|-----------|------|
| **Home Assistant** | Domótica: luces, temperatura, cámaras | Agregar el MCP `homeassistant` desde el panel Integraciones |
| **Spotify (control directo)** | Reproducción/playlist via UI | Agregar MCP `spotify` |
| **Slack/Discord** | Mensajería de equipo | Agregar MCPs respectivos |

Cada integración se implementa como un conjunto de **MCP tools** — el mismo patrón que ya usan bash, git, files, telegram, webchat y critter. El panel "Integraciones" del cliente lista los servicios catalogados y muestra estado (conectado/no configurado) según lo que el admin tenga en MCPs activos.

## Qué ya existe

La infraestructura core está construida y es sólida:

- **ConversationService** — motor de conversación con IA, retry, rate limit, streaming, tool calling.
- **6 providers de IA** — Anthropic, Claude Code CLI, Gemini, OpenAI, Grok, Ollama (local).
- **130+ MCP tools** distribuidas en 32 archivos:
  - Core (32 originales): shell, git, files, pty, memoria, telegram, webchat, P2P critter.
  - Productividad: tasks, skills, scheduler/cron, typed memory, hooks, search, web, notebook, plan mode, monitor, push notification.
  - Hogar (Fase B): grocery, family_event, house_note, service, inventory, household_summary.
  - Pro-actividad (Fase C): routine_morning_set, routine_bedtime_set, routine_weather_alert, routine_disable, routine_list.
  - Datos del entorno: location, weather, sun, moon_phase, uv_index, air_quality, holiday_check, is_weekend.
  - Finanzas/cultura: dolar_ar, currency_convert, crypto_price, wikipedia_summary, recipe, joke_get, feriados_ar.
  - Briefs proactivos: day_summary, morning_brief, bedtime_brief, week_ahead.
  - User location: user_location_save/get/forget (con geocoding OSM automático).
  - LSP, MCP OAuth, Workspace.
- **Canales** — Telegram (bot completo), WebChat, P2P (deskcritter).
- **Memoria persistente** — SQLite + embeddings + consolidación automática.
- **TTS multi-proveedor** — Edge TTS, Piper, ElevenLabs, OpenAI, Google.
- **Recordatorios/alarmas** + Scheduler con cron + LoopRunner agéntico.
- **Multi-usuario con aprobación** — `users.status` (active/pending/disabled), primer user es admin auto, demás esperan aprobación o usan invitación con auto-approve.
- **Onboarding por invitación** — admin genera link/QR de un solo uso (TTL configurable), invitado entra activo al instante.
- **Datos compartidos del hogar** — tabla `household_data` flexible, panel "Hogar" en sidebar con 5 tabs, 18 MCP tools.
- **Pro-actividad** — rutinas configurables desde Profile (morning/bedtime/weather alert) que disparan briefs automáticos vía Scheduler.
- **Mission Control dashboard** — landing default con stats CPU/RAM/Disk live, weather widget, multi-agent grid.
- **OAuth credentials desde UI admin** — Google/GitHub/Spotify auto-registrables sin tocar `.env`. Cifradas con TokenCrypto.
- **JWT auto-persistido** — instalable sin `.env`. Primer arranque genera y guarda en `.jwt-secret.key`.
- **LocationService** — LAN + Tailscale + IP pública geo + override manual del admin.
- **Production setup** — PM2 perfil `clawmint-prod`, security headers gated por NODE_ENV, WS reconnect infinito.
- **Arquitectura modular** — DI, routes, ws handlers, todo desacoplado.

## Qué falta

1. **OAuth Google funcional end-to-end** — el framework está; falta agregar los MCPs reales de Calendar/Gmail/Drive/Tasks (vía Smithery o npm) y completar el flujo de tokens.
2. **MCP tools server-side de Google** — calendar, email, drive, tasks (los tools existentes son del cliente al MCP externo; el del catálogo del agente es plug-and-play).
3. **Memoria semántica buscable cross-user** — "¿qué dijimos sobre vacaciones?" búsqueda en convos pasadas (módulo embeddings ya existe, falta wirearlo).
4. **Permisos granulares por miembro** — hoy todos los `status='active'` ven todo el household. Falta restricciones tipo "este hijo no ve los emails del padre".
5. **Backup automático** configurable de la DB.
6. **Vista de actividad por miembro** en el panel admin de Usuarios.

## Relación con el estado actual

Clawmint no se "reinventa" — **evoluciona**. La terminal PTY, los agentes de IA, las skills y el MCP siguen siendo capacidades disponibles. Lo que cambia es el enfoque: de herramienta para desarrolladores a asistente para familias. Las capacidades técnicas (consola, git, archivos) quedan como "modo avanzado" para el administrador.
