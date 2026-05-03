# Changelog

Todos los cambios notables en este proyecto se documentan en este archivo.

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

---

## [1.5.0] — 2026-04-19

### Added

- **Mission Control dashboard** como landing default — métricas live CPU/RAM/Disk/Server (poll 3s), weather widget (Open-Meteo), grid de agentes, sidebar reorganizado en grupos labeled (Overview/Control/Comms/Familia/Productividad/Servicios/Settings).
- **Multi-usuario con aprobación admin** — columna `users.status` (active/pending/disabled). Primer usuario en DB vacía → admin + active automático. Demás → pending hasta aprobación. Endpoints `POST /api/auth/admin/users/:id/{approve,reject,reactivate}` + `GET /admin/users/pending/count` para badge.
- **Onboarding por invitación (Fase A)** — admin genera link `?invite=CODE` con código de un solo uso (TTL 1h-1sem, soft-revoke). Invitado bypassa el pending. Tabla `invitations` + endpoints `POST/GET/DELETE /api/auth/admin/invitations` + `GET /api/auth/invitations/:code` (público inspect). Modal con QR/link copiable en UsersPanel.
- **Datos compartidos del hogar (Fase B)** — tabla `household_data` flexible con kinds `grocery_item|family_event|house_note|service|inventory`. Cualquier user `status='active'` puede leer/escribir. 18 MCP tools: `grocery_*`, `family_event_*`, `house_note_*`, `service_*`, `inventory_*`, `household_summary`. Panel "Hogar" en sidebar (grupo Familia) con 5 tabs interactivas.
- **Pro-actividad (Fase C)** — 5 MCP tools `routine_morning_set/bedtime_set/weather_alert/disable/list` que crean `scheduled_actions` con cron derivado de hora HH:MM. Sección "Rutinas proactivas" en ProfilePanel con time pickers + toggles. El agente ejecuta `morning_brief`/`bedtime_brief` y envía via Telegram automáticamente.
- **LocationService** — combina LAN (`os.networkInterfaces`) + Tailscale (rango 100.64.0.0/10) + IP pública via ipwho.is (cache 24h) + override manual del admin. Endpoint `GET /api/system/location` + `PUT/DELETE` admin. Tools: `server_info`, `server_location`, `weather_get` (resuelve coords con prioridad user pref > server > args).
- **Pack environment** — `air_quality_get` (Open-Meteo Air, AQI europeo), `sun_get` (cálculo nativo amanecer/atardecer), `moon_phase` (cálculo nativo), `uv_index_get`, `holiday_check` (date.nager.at, cualquier país), `is_weekend`.
- **Pack finanzas/cultura** — `dolar_ar` (blue/oficial/MEP/CCL via dolarapi.com), `feriados_ar`, `currency_convert` (open.er-api.com), `crypto_price` (CoinGecko), `wikipedia_summary`, `recipe_random/search` (TheMealDB), `joke_get` (JokeAPI safe-mode).
- **Briefs proactivos** — `day_summary` (JSON estructurado), `morning_brief` y `bedtime_brief` (lenguaje natural listo para leer), `week_ahead` (forecast 7 días + eventos + reminders).
- **User location** — `user_location_save({name})` con geocoding automático via Nominatim (OSM, free), `user_location_get`, `user_location_forget`. Persiste en `userPreferencesRepo`. UI en ProfilePanel con search box + lat/lon manuales + notas.
- **OAuth credentials desde UI admin (sin .env)** — `SystemConfigRepository` cifra con `TokenCrypto` en DB. Panel `OAuthCredentialsPanel` para Google/GitHub/Spotify. Handlers `mcp-oauth-providers/{google,github,spotify}.js` se auto-registran en McpAuthService y leen credenciales dinámicamente (no requiere restart al cambiar).
- **JWT auto-persistido** en `${CONFIG_DIR}/.jwt-secret.key` (mode 0600, primer arranque genera). Tokens sobreviven reinicios sin requerir `JWT_SECRET` en `.env`.
- **Production setup completo** — PM2 perfil `clawmint-prod` (sin watch, NODE_ENV=production, autorestart, max-memory 1GB, logs separados en `server/logs/prod-*.log`). Security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy) gated por NODE_ENV. `trust proxy` activo. `x-powered-by` deshabilitado. `client/.env.production` con feature flags bakeados.
- **Endpoints REST nuevos**: `/api/system/stats`, `/api/system/location`, `/api/system/lan-addresses`, `/api/household/*`, `/api/system-config/*`, `/api/auth/admin/users/:id/{approve,reject,reactivate}`, `/api/auth/admin/users/pending/count`, `/api/auth/admin/invitations`, `/api/auth/invitations/:code`.
- **Paneles cliente nuevos**: `Dashboard.jsx` (Mission Control), `HouseholdPanel.jsx`, `OAuthCredentialsPanel.jsx`, `IntegrationsPanel.jsx`, `DevicesPanel.jsx`, `MusicPanel.jsx`, `StatusFooter.jsx`, `UserLocationSection.jsx`, `UserRoutinesSection.jsx`.
- **Bell badge para admin** en AppHeader con count de pendientes (poll cada 30s, pausa cuando tab oculta).

### Changed

- **Paleta visual warm-only** — `--accent-orange #f97316` (primary brand), `--accent-red #ef4444`, `--accent-amber #fbbf24` (alias `--accent-cyan`), `--accent-peach #fb923c` (alias `--accent-blue`). Background near-black `#0a0a0c`. Sidebar reorganizada en 7 grupos labeled.
- **`uiStore.wsConnected` default `false`** — no muestra "Health OK" engañoso al bootstrap; cambia a true cuando el listener confirma `onopen`.
- **WS reconnect infinito** — antes se rendía a los 5 intentos; ahora retry forever con cap 30s entre intentos. Listeners `visibilitychange` y `online` fuerzan reconexión inmediata.
- **`/api/mcps` GET libre** para users autenticados (era admin-only); mutaciones siguen requiriendo admin.
- **130+ MCP tools totales** (era ~32) en 32 archivos — los nuevos packs no rompen los originales.

### Fixed

- **Flash de consolas en Windows** al leer disk stats — `execSync('wmic ...')` reemplazado por `fs.statfsSync()` (Node 18.15+, syscall nativo). Cero subprocess.
- **MemoryPanel setState-in-render** → reemplazado por `useEffect`. Evita updates fantasma.
- **Sidebar overflow** cuando hay muchos grupos — cambio `overflow: hidden` → `overflow-y: auto` con scrollbar custom.
- **Step1Admin race** — si el server detecta que la DB ya no está vacía durante el wizard, el cliente ahora muestra mensaje claro en vez de tokens vacíos.
- **WS reconnect** post-restart del server — antes quedaba "Reconectando..." eterno tras 5 retries; ahora se recupera solo o al volver a la tab.

### Docs

- Nueva entrada extensa en CHANGELOG (esta).
- `CLAUDE.md`, `docs/vision.md`, `README.md` actualizados con 130+ tools, multi-user, onboarding, household, pro-actividad, OAuth via UI, instalable sin .env.
- `docs/database/schema.md` documenta 3 tablas nuevas (`invitations`, `household_data`, `system_config`) + columna `users.status`.
- `docs/api_contract/README.md` documenta 20+ endpoints nuevos.
- `docs/modules/README.md` documenta `InvitationsRepository`, `HouseholdDataRepository`, `SystemConfigRepository`, `LocationService`, `mcp-oauth-providers/`.
- `docs/integrations/README.md` lista 10 APIs externas free + 3 OAuth providers auto-registrables.
- `docs/architecture.md` agrega flujos: multi-user lifecycle, OAuth credentials sin .env, datos compartidos del hogar, pro-actividad.
- `docs/frontend/README.md` documenta 9 paneles/secciones nuevas + paleta warm + WS reconnect.
- `ROADMAP.md` raíz: Fase 1 multi-usuario marcada `[x]` completada, Fase 3 rutinas `[x]`, Fase 4 dashboard `[~]` en progreso.
- `docs/roadmap.md` consolidado a redirect.
- `implementar/*.md` (10 archivos pre-roadmap) movidos a `docs/legacy/implementar/`.

---

## [1.4.0] — 2026-03-25

### Added
- Comando `/restart` para reiniciar servidor PM2 desde Telegram
- Comando `/run` (alias `/cmd`) para ejecutar comandos de terminal desde el chat
- Botón 🔄 Restart en el submenú de monitor de Telegram
- Registro de nuevos comandos en el menú del bot

### Fixed
- Suprimir mensaje duplicado cuando Claude ya respondió via MCP tools (#70)
- Auto-remove de botones inline después de interacción con callback
- Tests desactualizados: destructuring de tools, conteo hardcodeado, path comparison Linux (#72)

---

## [1.3.0] — 2026-03-24

### Added
- Canal WebChat completo con ConversationService integration (`server/channels/web/`)
- Reproductor de audio personalizado con visualización de transcripción en WebChat
- Renderizado HTML en mensajes del chat WebChat
- Persistencia de historial y grabación de audio en WebChat
- Panel de MCPs con iconos Lucide y mejoras de UX en frontend (#39)
- MCP tools para WebChat — paridad con Telegram (`webchat_send_message`, etc.)
- MCP client pool para herramientas externas (`server/mcp-pool/`)
- Providers API con tools, modos, costo, `edit_file` y PTY interactivo
- Resiliencia de providers — retry, rate limit, timeout, resume
- Critter tools, relay fallback, channel filtering y Ollama tool-use
- Módulo Nodriza: configuración, conexión WebRTC con señalización, rutas REST y sesión P2P
- Adaptador P2PBotAdapter para DataChannel
- `transcribePCM` para audio P2P en transcriber
- Telegram: 4 nuevas MCP tools expandidas

### Fixed
- Dropdown sync al cambiar provider/agente en WebChat (#32)
- Contraste WCAG AA en todos los CSS (#50)
- Error handling silencioso + mejoras UX (#52)
- Estabilidad crítica: pty_exec, git tool
- Ollama: carga dinámica de modelos desde API
- Ollama marcado como siempre configurado
- WebChat: file upload, TTS error, mic validation, inline buttons
- WebChat: persist history for all providers
- WebChat: tools en system prompt
- Telegram: await consolidator processQueue
- Telegram: unificar audio status con msg flow
- Timers persistentes con `unref()`
- MCP pool: cerrar transport al desconectar
- Transcriber: usar ffmpeg en vez de ogg-opus-decoder
- Dependencias: agregar sharp, remover ogg-opus-decoder no usado
- Seguridad: remover provider-config.json del tracking

### Changed
- Refactor: `index.js` de 1704 → 170 LOC — rutas y WS handlers extraídos a módulos

### Docs
- Actualización de CLAUDE.md y ROADMAP.md
- Documentación de providers, channel filtering, critter tools

---

## [1.2.0] — 2026-03-22

### Added
- MCP memory tools con tags IDF-weighted y continuidad de sesión

---

## [1.1.0] — 2026-03-22

### Added
- Panel WebChat, MCP telegram tools, botones inline dinámicos con callbacks
- Visión multi-provider: fotos en Telegram con OCR kheiron-tools + fallback minicpm-v
- Ollama: visión con minicpm-v y fallback para claude-code
- Git hooks para proteger rama main y conventional commits

### Fixed
- Ollama: redimensionar imágenes a 512px antes de enviar a minicpm-v
- Vision: parsear output de kheiron OCR correctamente
- Telegram: diagnóstico de errores en fotos, silenciar stderr de OCR
- Telegram: fallback sin parse_mode en editMessageText
- TTS: carga resiliente de voice-providers y mejoras en comandos Telegram

### Changed
- Ollama: usar sharp en vez de Python para redimensionar imágenes

### Docs
- Plan de WebChannel desacoplado de Telegram
- Reescribir ARQUITECTURA.md y completar CLAUDE.md
- Actualizar estado de implementación en planes
- Plan P2P y docs de ia-local

---

## [0.9.0] — 2026-03-19

### Added
- Provider Grok (xAI) con soporte streaming y modelos configurables (`server/providers/grok.js`)
- Provider Ollama para modelos locales (`server/providers/ollama.js`)
- Sistema TTS multi-proveedor desacoplado: Edge TTS, Piper TTS, SpeechT5, ElevenLabs, OpenAI TTS, Google TTS (`server/voice-providers/`)
- Módulo TTS central con selección dinámica de proveedor (`server/tts.js`, `server/tts-config.js`)
- Persistencia de sesión Claude en SQLite para resume tras reinicio del servidor
- Persistencia del modo de permisos Claude (`ask`/`auto`/`plan`) en SQLite — sobrevive reinicios
- Configuración PM2 para gestión de procesos en producción (`server/ecosystem.config.js`)
- Auto-arranque del servidor con PM2 + systemd al encender la máquina
- Modularización del transcriptor de audio (`server/transcriber.js`)

### Fixed
- Robustecer persistencia de sesión Claude: reintentar sin `--resume` cuando la sesión es inválida
- Limpiar sesión rota en caso de error para evitar reintento con `--resume`
- Sincronizar `cwd` de `claudeSession` al cambiar directorio con `/cd` y `>>cd`
- Persistir `monitorCwd` (elegido por el usuario) en vez del `cwd` interno de Claude
- `_isClaudeBased` reconoce `'claude-code'` como provider válido (fix `/permisos`)

### Changed
- Piper TTS: extracción por OS, lock de concurrencia y preload al inicio

---

## [0.5.0] — 2026-03-16

### Added
- Soporte `groupWhitelist` en bots de Telegram para control de acceso en grupos
- Sistema de recordatorios/alarmas para el bot (`/recordar`, `/recordatorios`)

### Changed
- README reestructurado al estilo visual de proyecto open source
- Documentación detallada movida a `/documentacion` (servidor y cliente)

---

## [0.4.0] — 2026-03-15

### Added
- Inicialización automática de `bots.json` desde variables de entorno en primer arranque
- Provider configurable por agente (Anthropic, Gemini, OpenAI, Claude Code)
- Reconexión WebSocket con exponential backoff y persistencia de historial AI (24h)

---

## [0.3.0] — 2026-03-14

### Added
- Transcripción de audio con faster-whisper (mensajes de voz en Telegram)
- Comandos `/dir`, `/monitor`, `/ls`, `/cat`, `/mkdir` en el bot
- Respuestas chunked para mensajes largos en Telegram
- Configuración de bot desde panel web

---

## [0.2.0] — 2026-03-13

### Added
- Modo consola bash en Telegram (`/consola`)
- Navegación jerárquica por botones inline
- Módulo de memoria por agente
- Logger global con archivo `server.log`
- Panel de agentes en la UI web
- Sistema de skills (locales + ClawHub)
- Comando `/id`, rate-limit keyword bypass

---

## [0.1.0] — 2026-03-12

### Added
- Terminal PTY real con xterm.js + node-pty
- Servidor Express + WebSocket (puerto 3001)
- Cliente React + Vite (puerto 5173)
- Bot de Telegram con long polling y streaming progresivo
- Sesiones AI con Claude Code CLI (`claude -p`)
- API REST para sesiones, agentes, skills y memoria
- README inicial con instalación y comandos
