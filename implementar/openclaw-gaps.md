# Brechas vs OpenClaw — Qué implementar

Análisis basado en comparación directa con OpenClaw (marzo 2026).

---

## 🔴 Alta prioridad

### 1. Multi-canal (WhatsApp, Discord, Slack)
OpenClaw soporta 22+ plataformas. Clawmint solo tiene Telegram.

**Enfoque sugerido:** Abstraer `TelegramBot` en una interfaz `ChannelAdapter` genérica.
Cada canal implementa: `send(chatId, text)`, `onMessage(handler)`, `onCommand(handler)`.

Canales a añadir por orden de demanda:
- [ ] Discord (discord.js — bot o webhook)
- [ ] WhatsApp (whatsapp-web.js o Baileys — requiere sesión QR)
- [ ] Slack (Bolt SDK)

**Archivos afectados:** `server/telegram.js` → refactor a `server/channels/telegram.js`, nuevo `server/channelManager.js`

---

### 2. Control de navegador vía CDP
OpenClaw tiene Chromium propio con CDP: screenshots, click, type, navigate.
Permite al agente navegar la web de forma autónoma como tool.

**Enfoque sugerido:** Nueva tool `browser_*` usando `puppeteer` o `playwright`.
Tools a exponer al agente:
- `browser_navigate(url)`
- `browser_screenshot()` → devuelve base64
- `browser_click(selector)`
- `browser_type(selector, text)`
- `browser_eval(js)`

**Archivos afectados:** nuevo `server/tools/browser.js`, registrar en `server/tools.js`

---

## 🟡 Media prioridad

### 3. Cron / tareas proactivas
OpenClaw permite que el agente actúe sin que el usuario inicie la conversación.
Casos de uso: recordatorios, reportes periódicos, alertas de monitoreo.

**Enfoque sugerido:** Módulo `server/scheduler.js` con `node-cron`.
API REST: `POST /api/cron` `{ agentKey, prompt, cron: "0 9 * * *", channel: "telegram", chatId }`.

**Archivos afectados:** nuevo `server/scheduler.js`, endpoint en `server/index.js`

---

### 4. Canvas / outputs HTML ricos
OpenClaw tiene A2UI: el agente hace push de HTML interactivo al cliente.
Clawmint solo muestra texto plano en terminal.

**Enfoque sugerido:** Nuevo tipo de mensaje WebSocket `{ type: "canvas", html: "..." }`.
El frontend renderiza en un panel lateral o modal con iframe sandboxed.

**Archivos afectados:** nuevo `client/src/components/CanvasPanel.jsx`, protocolo WS en `server/index.js`

---

## 🟢 Baja prioridad

### 5. Voz (transcripción + síntesis)
OpenClaw tiene wake word y Talk Mode.
Clawmint tiene transcripción Whisper parcial (solo en Telegram).

**Enfoque sugerido:**
- Transcripción: exponer `faster-whisper` vía API REST para uso desde browser también
- Síntesis: integrar TTS (piper-tts local o ElevenLabs API)

---

### 6. Seguridad DM Pairing
OpenClaw requiere aprobación explícita para usuarios desconocidos.
Clawmint usa whitelist estática.

**Enfoque sugerido:** Flujo de aprobación dinámica:
- Nuevo usuario → bot envía código de 6 dígitos al owner
- Owner responde `/aprobar <código>` → se añade a whitelist automáticamente
- Timeout configurable (ej. 10 min)

**Archivos afectados:** `server/telegram.js`, `server/bots.json` (nuevo campo `pendingApprovals`)

---

## Notas de arquitectura

- El refactor multi-canal es el más disruptivo pero desbloquea todo lo demás.
- CDP / browser es el diferenciador más visible para usuarios técnicos.
- Cron es relativamente sencillo y de alto valor percibido.
- Canvas requiere coordinación frontend+backend pero es muy llamativo visualmente.
