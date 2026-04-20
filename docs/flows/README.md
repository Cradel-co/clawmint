> Última actualización: 2026-04-19

# Flujos de negocio

Descripción de los flujos principales del sistema.

---

## Índice

| Flujo | Descripción |
|-------|-------------|
| [Mensaje por WebSocket (AI)](#mensaje-por-websocket-ai) | Usuario del navegador envía mensaje a un LLM |
| [Mensaje por Telegram](#mensaje-por-telegram) | Usuario de Telegram envía mensaje al bot |
| [Memoria: detección y guardado](#memoria-detección-y-guardado) | El LLM detecta información importante y la persiste |
| [Memoria: recuperación e inyección](#memoria-recuperación-e-inyección) | Contexto de memoria inyectado antes de responder |
| [Cambio de provider en Telegram](#cambio-de-provider-en-telegram) | Usuario cambia de Claude a Gemini en medio de una conversación |
| [Vinculación PTY ↔ Telegram](#vinculación-pty--telegram) | Un chat de Telegram se conecta a una sesión PTY del navegador |
| [Multi-user lifecycle](#multi-user-lifecycle) | Registro abierto → status pending → admin approve → activo |
| [Onboarding por invitación](#onboarding-por-invitación) | Admin genera link/QR → user entra activo sin esperar aprobación |
| [Rutina proactiva](#rutina-proactiva) | El agente arma cron y manda morning/bedtime/weather brief solo |

---

## Mensaje por WebSocket (AI)

**Actores:** Usuario (navegador), servidor (`index.js`), provider de IA

**Precondiciones:** Servidor corriendo, provider configurado con API key válida

**Pasos:**

1. Cliente abre WS a `ws://localhost:3001`
2. Cliente envía `{ type: 'init', sessionType: 'ai', provider: 'anthropic', agentKey: 'mi-agente', cols, rows }`
3. Servidor crea sesión AI (sin PTY), devuelve `{ type: 'session_id', id: 'uuid' }`
4. Cliente envía `{ type: 'input', data: 'pregunta del usuario' }`
5. Servidor llama `providers.get('anthropic').chat({ systemPrompt, history, apiKey, model })`
6. Por cada chunk de texto: servidor envía `{ type: 'output', data: chunk }`
7. Al terminar: servidor envía `{ type: 'exit' }`
8. Cliente actualiza historial para siguiente mensaje

**Condiciones de error:**
- API key inválida → el provider lanza error → servidor envía `{ type: 'output', data: '[Error: ...]' }` + `{ type: 'exit' }`
- Timeout del provider → idem

**Resultado:** Respuesta del LLM renderizada en xterm.js en tiempo real.

---

## Mensaje por Telegram

**Actores:** Usuario (Telegram), `TelegramBot`, `ConversationService`, provider o `ClaudePrintSession`

**Precondiciones:** Bot corriendo (long polling activo), chat en la whitelist (o whitelist vacía)

**Pasos:**

1. `TelegramBot` recibe update via long polling (POLL_TIMEOUT=25s)
2. Validación: whitelist, rate limit, tipo de chat (grupo requiere mención o respuesta al bot)
3. Si hay audio: `transcriber.transcribe()` → texto
4. Si hay acción pendiente (`_pendingHandler`): tratar como respuesta de flujo en curso
5. Si empieza con `/`: `_commandHandler.handle()`
6. Si es texto normal: `_sendToSession()` o `_sendToApiProvider()` según el provider activo del chat

**Para `claude-code`:**
- Si no hay sesión activa: crea nueva `ClaudePrintSession({ permissionMode: claudeMode })`
- `memory.buildMemoryContext()` → inyecta contexto de memoria como primer mensaje
- `session.sendMessage(text, onChunk)` donde `onChunk` edita el mensaje de Telegram cada 1500ms (throttle)
- Al terminar: `memory.extractMemoryOps()` → guarda notas si el LLM las incluyó en la respuesta

**Para providers API (Anthropic/Gemini/OpenAI):**
- Construye historial de conversación
- `provider.chat({ systemPrompt, history, apiKey, model })` → async generator
- Igual animación de edición progresiva
- Al terminar: agrega respuesta al historial

**Condiciones de error:**
- Rate limit alcanzado → bot responde con aviso y keyword de reset
- Chat no en whitelist → bot responde "No tenés acceso"
- Error del LLM → bot responde con el error

**Resultado:** Respuesta del LLM enviada como mensaje de Telegram (con posibles botones post-respuesta).

---

## Memoria: detección y guardado

**Actores:** `memory.js`, LLM, `memory-consolidator.js`

**Precondiciones:** `agentKey` definido para el chat, señales configuradas en `preferences.json`

**Pasos:**

1. Antes de enviar mensaje al LLM: `memory.detectSignals(agentKey, text)` → evalúa si el texto contiene patrones de importancia (ej: "recuerda", "me llamo", "trabajo en")
2. Si `shouldNudge`: se agrega al final del mensaje el `TOOL_INSTRUCTIONS` con formato para guardar memoria
3. LLM responde incluyendo un bloque especial:
   ```
   <memory_write file="laboral.md">
   ---
   title: Info laboral
   tags: [google, sre]
   importance: 9
   ---
   Trabajo en Google como SRE.
   </memory_write>
   ```
4. `memory.extractMemoryOps(response)` extrae los bloques y los elimina del texto visible
5. `memory.applyOps(agentKey, ops)` → escribe los archivos y los indexa en SQLite
6. Si hay señales pero el LLM no guardó nada: `consolidator.enqueue()` para consolidación diferida

**Consolidación diferida (memory-consolidator):**
- Cada 2 minutos: procesa `consolidation_queue`
- Para cada ítem: llama al LLM con el contexto de los turnos acumulados
- LLM decide si vale la pena guardar y qué guardar
- Crea/actualiza archivos de memoria

**Resultado:** Nota de memoria creada/actualizada en `memory/<agentKey>/<file>.md` + indexada en SQLite.

---

## Memoria: recuperación e inyección

**Actores:** `memory.js`, LLM

**Precondiciones:** Agente con memoria existente

**Pasos:**

1. Al recibir mensaje del usuario, `memory.buildMemoryContext(agentKey, text)` ejecuta:
   a. `memory.extractKeywords(text)` + `memory.expandKeywords(keywords)` → keywords expandidas
   b. `memory.spreadingActivation(agentKey, keywords)`:
      - Nodos semilla: notas con tags/título/contenido que matchean keywords
      - Spreading (2 saltos, decay 0.7): propaga activación por links Hebbianos
      - ACT-R BLA: pondera por frecuencia de acceso (`access_count`, `last_accessed`)
      - Ebbinghaus: aplica curva de olvido según `importance` y tiempo desde último acceso
   c. Token budget: selecciona top notas hasta 800 tokens (≈ 3200 chars)
2. Contexto de memoria se prepende al primer mensaje de la sesión:
   ```
   [Memoria relevante]
   ## Info laboral
   Trabajo en Google como SRE...

   ---

   Pregunta del usuario
   ```
3. LLM responde con contexto relevante inyectado

**Aprendizaje Hebbiano:**
- Al acceder a un conjunto de notas, `memory.reinforceConnections(noteIds)` incrementa `co_access_count` en `note_links`
- Notas co-accedidas frecuentemente tienen mayor peso en spreading

**Resultado:** LLM responde con información personalizada del usuario sin necesitar re-explicarla.

---

## Cambio de provider en Telegram

**Actores:** Usuario (Telegram), `CallbackHandler`, `ChatSettingsRepository`

**Precondiciones:** Bot activo con múltiples providers configurados

**Pasos:**

1. Usuario envía `/modelo` o accede al menú de configuración
2. Bot muestra teclado inline con providers disponibles (Anthropic, Gemini, OpenAI, claude-code)
3. Usuario hace clic en un provider
4. `CallbackHandler` recibe callback query con `data: 'provider:anthropic'`
5. `chatSettingsRepo.save(botKey, chatId, { provider: 'anthropic', model: null })`
6. Bot confirma el cambio con mensaje
7. Próximo mensaje del usuario usa el nuevo provider

**Para cambio de modelo específico:**
- `CallbackHandler` recibe `data: 'setmodel:claude-opus-4-6'`
- `chatSettingsRepo.save(botKey, chatId, { provider: 'anthropic', model: 'claude-opus-4-6' })`

**Condiciones de error:**
- API key no configurada para el provider → bot avisa con mensaje de error

**Resultado:** Chat usa el nuevo provider/modelo en todos los mensajes siguientes.

---

## Vinculación PTY ↔ Telegram

**Actores:** Usuario (navegador), Usuario (Telegram), `index.js`, `TelegramChannel`

**Precondiciones:** Bot activo, sesión PTY creada desde el navegador

**Pasos desde el navegador:**

1. Usuario abre `TelegramPanel` en el navegador
2. Selecciona un chat de Telegram y hace clic en "Vincular sesión"
3. UI llama `POST /api/telegram/bots/:key/chats/:chatId/session` con `sessionId` opcional
4. `index.js` llama `telegram.linkSession(key, chatId, sessionId)`
5. `TelegramBot` asocia `chat.sessionId = sessionId` en memoria

**Una vez vinculado:**

6. El usuario de Telegram envía mensajes
7. `TelegramBot` detecta `chat.sessionId` y escribe el input en la sesión PTY
8. Output del PTY se devuelve al chat de Telegram
9. `events.emit('telegram:session', { sessionId, from, text })` → broadcast a navegadores conectados

**Desvinculación:**
- `DELETE /api/telegram/bots/:key/chats/:chatId` → `telegram.disconnectChat(key, chatId)`

**Resultado:** El chat de Telegram controla una sesión de terminal en tiempo real desde el celular.

---

## Multi-user lifecycle

**Actores:** Usuario nuevo, admin existente, `AuthService`, `UsersRepository`, `AppHeader` (bell badge), `UsersPanel`

**Precondiciones:** Servidor corriendo, al menos un admin ya registrado (el primer registro siempre crea admin auto).

**Pasos (registro abierto):**

1. Usuario entra al cliente web → `AuthPanel` modo registro
2. `POST /api/auth/register` con `{ name, email, password }` (sin `inviteCode`)
3. `AuthService` consulta si la DB está vacía:
   - Si vacía → crea user con `role='admin'`, `status='active'` → 201 + token JWT inmediato
   - Si ya hay users → crea user con `status='pending'` → 202 (sin token)
4. UI del nuevo user muestra "Tu cuenta está pendiente de aprobación"
5. `AppHeader` del admin polea cada 30s `GET /api/auth/admin/users/pending/count` → bell badge con contador
6. Admin abre `UsersPanel` (Settings → Usuarios) → ve lista con sus pending
7. Admin clickea "Aprobar" → `POST /api/auth/admin/users/:id/approve`
8. `UsersRepository.updateStatus(id, 'active')` → emite `users:approved` (opcional)
9. Próximo login del user devuelve token (status=active ya pasa el gate)

**Estados terminales:** `active`, `pending`, `disabled`

**Condiciones de error:**
- Email duplicado en register → 409 Conflict
- Login con `status='pending'` → 403 con mensaje "pending approval"
- Login con `status='disabled'` → 403 con mensaje "account disabled"

**Resultado:** Onboarding controlado — solo el admin abre la puerta a nuevos miembros (a menos que use el flujo invitación).

---

## Onboarding por invitación

**Actores:** Admin, usuario nuevo, `InvitationsRepository`, `AuthService`, `UsersPanel` modal

**Precondiciones:** Admin logueado, sistema corriendo.

**Pasos:**

1. Admin abre `UsersPanel` → tab "Invitaciones" → "Nueva invitación"
2. Form: `ttlHours` (default 24), `role` (default 'user'), `familyRole` (ej: "mamá", "papá", "hijo")
3. `POST /api/auth/admin/invitations` con esos campos
4. `InvitationsRepository.create({ createdBy: admin.id, ttlMs, role, familyRole })`:
   - Genera `code` hex 32 chars
   - `auto_approve = 1` por default → bypass del status pending
5. UI muestra modal con:
   - Link: `https://<host>/?invite=<code>`
   - QR code generado client-side (qrcode.react)
   - Botón "Copiar"
6. Admin comparte link/QR por WhatsApp/Telegram/foto
7. Usuario clickea el link → cliente parsea `?invite=<code>` → `AuthPanel` lo guarda en estado
8. Antes de mostrar el form: `GET /api/auth/invitations/:code` (público, sin auth)
   - Si `valid=true` → muestra el familyRole prefilled ("Te están invitando como: mamá")
   - Si `expired/used/revoked` → error visible
9. User completa `name + email + password` → submit
10. `POST /api/auth/register` con `{ name, email, password, inviteCode }`
11. `AuthService`:
    - Valida invitación (no expirada, no usada, no revocada)
    - Crea user con `role` de la invitación, `status='active'` (auto_approve)
    - `InvitationsRepository.markUsed(code, userId)`
    - Devuelve 201 + token JWT inmediato
12. User entra directo al dashboard sin esperar aprobación

**Soft-revoke (admin cancela invitación):**
- `DELETE /api/auth/admin/invitations/:code` → marca `revoked_at` (no borra)
- Próximo intento de uso devuelve 410 Gone

**Cleanup automático:**
- `InvitationsRepository.cleanup()` corre periódicamente, borra invitaciones con `expires_at < now() - 7 días` (mantiene auditoría reciente)

**Resultado:** Familia se incorpora sin fricción de aprobación manual.

---

## Rutina proactiva

**Actores:** Usuario, agente IA, `routine_*` MCP tools, `Scheduler`, `_executeAiTask`, canal del user (Telegram/WebChat)

**Precondiciones:** User activo, canal vinculado (telegramChatId o webchat session), `LocationService` con coords resueltas.

**Pasos:**

1. Usuario le pide al agente: *"mandame el resumen de la mañana todos los días a las 7"*
2. Agente decide invocar `routine_morning_set({ time: "07:00" })`
3. Wrapper de la tool:
   - Calcula cron desde HH:MM → `0 7 * * *`
   - Crea `scheduled_action` en DB con:
     - `kind: 'ai_task'`
     - `cron: '0 7 * * *'`
     - `payload: { agentKey, channel: 'telegram', chatId, prompt: 'Generá el morning brief para este usuario' }`
     - `userId` del owner
4. Confirma al user: "Listo, te mando el resumen cada día a las 7am"
5. **Tick del Scheduler (cada 30s):**
   - Lee `scheduled_actions` con `next_run <= now()`
   - Para `kind: 'ai_task'` → llama `_executeAiTask(action)`
6. `_executeAiTask`:
   - Resuelve provider/agent activo del user
   - Construye `ConversationService` efímero (sin canal interactivo, solo despacho)
   - Inyecta el prompt como user message
   - Stream tools normalmente (`morning_brief`, `weather_get`, `calendar_list_events` si hay OAuth, `telegram_send_message` al final)
7. Agente:
   - `morning_brief()` arma el resumen (clima del día + eventos + tareas + dólar + chiste)
   - `telegram_send_message({ chatId, text })` lo envía al user
8. Scheduler recalcula `next_run` desde el cron → siguiente disparo mañana 7am

**Tools de control adicionales:**
- `routine_bedtime_set({ time: "22:30" })` → resumen del día siguiente para mentalizar
- `routine_weather_alert({ time: "06:30" })` → solo dispara si hay lluvia/calor extremo/UV alto
- `routine_disable({ kind })` → marca `scheduled_action.enabled = 0`
- `routine_list()` → muestra las rutinas activas del user

**Condiciones de error:**
- Si `_executeAiTask` falla (provider down, etc.) → log + `failed_at`, reintento al próximo tick (max 3)
- Si `telegram_send_message` falla → log + se descarta este disparo (no acumula backlog)

**Resultado:** Pro-actividad real — el agente actúa por iniciativa según los horarios que el usuario configuró conversacionalmente.
