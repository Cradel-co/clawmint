# Plan: WebChannel — Cliente propio desacoplado de Telegram

> **Estado (2026-03-19):** NO IMPLEMENTADO. Plan de arquitectura para crear un canal web nativo que funcione sin depender de Telegram como frontend.

---

## Objetivo

Crear un cliente de chat propio accesible desde el navegador que reemplace/complemente a Telegram como frontend principal. El usuario abre `localhost:3002/chat` y tiene la misma experiencia que por Telegram: conversar con IA, cambiar provider/modelo, ejecutar comandos, escuchar audio, etc.

---

## Por qué

- **Independencia:** no depender de Telegram para funcionar
- **UX propia:** control total sobre la interfaz, sin límites de la API de Telegram (4096 chars, throttle de edits, etc.)
- **Funcionalidades nuevas:** canvas HTML, grafo de memoria, file upload, streaming en tiempo real sin throttle
- **Multi-usuario:** autenticación propia sin whitelist de chat IDs

---

## Arquitectura

```
Hoy:
  Usuario → Telegram API → TelegramChannel → ConversationService → Provider IA

Nuevo:
  Usuario → WebSocket → WebChannel → ConversationService → Provider IA

Ambos canales coexisten. El usuario elige desde dónde hablar.
```

### Lo que ya existe y se reutiliza

| Componente | Estado |
|------------|--------|
| `BaseChannel.js` | ✅ Interfaz base lista |
| `ConversationService.js` | ✅ Desacoplado del canal |
| `ChatSettingsRepository.js` | ✅ Persistencia agnóstica |
| Providers IA (6) | ✅ Listos |
| TTS (6 providers) | ✅ Listos |
| Transcriber (Whisper) | ✅ Listo |
| Memory, Skills, Agents | ✅ Listos |

---

## Componentes a crear

### Backend

#### `server/channels/web/WebChannel.js`

Implementa `BaseChannel`. Se comunica por WebSocket en vez de Telegram API.

```javascript
class WebChannel extends BaseChannel {
  // Equivalencias con TelegramChannel:
  sendText(chatId, text)           // → ws.send({ type: 'chat:message', text })
  sendWithButtons(chatId, text, buttons) // → ws.send({ type: 'chat:message', text, buttons })
  editMessage(chatId, msgId, text) // → ws.send({ type: 'chat:edit', msgId, text })
  sendAudio(chatId, buffer)        // → ws.send({ type: 'chat:audio', data: base64 })
  sendTyping(chatId)               // → ws.send({ type: 'chat:typing' })
}
```

**Ventajas sobre Telegram:**
- Sin throttle de 1500ms para edits (streaming directo)
- Sin límite de 4096 chars por mensaje
- Soporte nativo de HTML/markdown rico
- File upload/download directo

#### Protocolo WebSocket (chat namespace)

```
Cliente → Servidor:
  { type: 'chat:send', text, chatId? }           // mensaje del usuario
  { type: 'chat:command', command, args }         // /modo, /provider, etc.
  { type: 'chat:audio', data: base64 }            // nota de voz
  { type: 'chat:action', action, data }           // click en botón inline

Servidor → Cliente:
  { type: 'chat:message', id, text, buttons? }    // mensaje del bot
  { type: 'chat:edit', id, text }                  // edición progresiva (streaming)
  { type: 'chat:typing' }                          // indicador de escritura
  { type: 'chat:audio', data: base64 }             // respuesta TTS
  { type: 'chat:status', provider, model, mode }   // estado actual del chat
  { type: 'chat:error', message }                   // error
```

#### Autenticación

Opciones por complejidad:

1. **Token estático** (MVP): variable de entorno `WEB_AUTH_TOKEN`, se pasa en el handshake WS
2. **Login simple**: usuario/contraseña en SQLite, JWT en cookie
3. **OAuth**: Google/GitHub login (futuro)

### Frontend

#### `client/src/components/ChatPanel.jsx`

Panel de chat estilo messaging app:

- **Lista de mensajes** con markdown renderizado, botones inline, timestamps
- **Input** con soporte para texto, comandos (autocompletado de `/`), y drag-drop de archivos
- **Sidebar** con: provider actual, modelo, modo de permisos, cwd, costo
- **Botón de micrófono** para grabar y enviar audio (transcripción Whisper)
- **Botón de speaker** para TTS de la última respuesta
- **Streaming en tiempo real** sin throttle — cada token se renderiza al llegar

#### Componentes auxiliares

| Componente | Función |
|------------|---------|
| `ChatMessage.jsx` | Render de un mensaje (markdown, código, botones) |
| `ChatInput.jsx` | Input con autocompletado de comandos |
| `ChatSidebar.jsx` | Estado: provider, modelo, modo, stats |
| `AudioRecorder.jsx` | Grabación de audio con MediaRecorder API |

---

## Fases de implementación

### Fase 1 — MVP Chat (prioridad alta)

- [ ] `WebChannel.js` con `sendText`, `sendWithButtons`, `editMessage`
- [ ] Protocolo WS para chat (send, message, edit, typing)
- [ ] `ChatPanel.jsx` básico (mensajes + input + streaming)
- [ ] Autenticación por token estático
- [ ] Ruta `/chat` en el cliente React
- [ ] Registrar WebChannel en `bootstrap.js`

### Fase 2 — Paridad con Telegram

- [ ] Comandos (`/modo`, `/provider`, `/modelo`, `/cd`, `/nueva`, etc.)
- [ ] Botones inline (provider selector, modo selector, config)
- [ ] Persistencia en SQLite (misma tabla `chat_settings`)
- [ ] Audio: grabar → transcribir → responder → TTS
- [ ] File upload (imágenes, documentos)

### Fase 3 — Superar Telegram

- [ ] Streaming sin throttle (token por token)
- [ ] Mensajes sin límite de longitud
- [ ] Canvas HTML (render de código, diagramas, tablas interactivas)
- [ ] Grafo de memoria D3 integrado
- [ ] Notificaciones push (Service Worker)
- [ ] Multi-chat (varias conversaciones simultáneas)
- [ ] Login con usuario/contraseña

---

## Archivos a crear/modificar

| Archivo | Acción |
|---------|--------|
| `server/channels/web/WebChannel.js` | **Crear** — canal WebSocket |
| `server/bootstrap.js` | **Modificar** — registrar WebChannel |
| `server/index.js` | **Modificar** — namespace WS para chat |
| `client/src/components/ChatPanel.jsx` | **Crear** — UI de chat |
| `client/src/components/ChatMessage.jsx` | **Crear** — render de mensaje |
| `client/src/components/ChatInput.jsx` | **Crear** — input con autocompletado |
| `client/src/App.jsx` | **Modificar** — agregar ruta /chat |

---

## Notas de diseño

- WebChannel y TelegramChannel coexisten — no se reemplaza Telegram, se complementa
- Mismo `ConversationService`, mismo `ChatSettingsRepository`, mismos providers
- El `chatId` en WebChannel puede ser el token/userId del handshake WS
- El streaming es directo: cada chunk del provider se envía al WS sin throttle
- Los botones inline se renderizan como componentes React, no como callbacks de Telegram
