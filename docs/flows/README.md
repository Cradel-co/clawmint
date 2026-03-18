> Última actualización: 2026-03-17

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
