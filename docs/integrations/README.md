> Última actualización: 2026-03-17

# Integraciones externas

Servicios y SDKs externos que usa Clawmint.

---

## Índice

| Servicio | Módulo | Tipo de integración |
|---------|--------|---------------------|
| [Anthropic (Claude)](#anthropic-claude) | `providers/anthropic.js` | API REST (SDK) |
| [Google Gemini](#google-gemini) | `providers/gemini.js` | API REST (SDK) |
| [OpenAI](#openai) | `providers/openai.js` | API REST (SDK) |
| [Claude CLI (`claude -p`)](#claude-cli) | `core/ClaudePrintSession.js` | Proceso hijo (stdin/stdout) |
| [Telegram Bot API](#telegram-bot-api) | `channels/telegram/TelegramChannel.js` | HTTPS long polling |
| [faster-whisper](#faster-whisper) | `transcriber.js` | Proceso Python hijo |
| [Smithery (MCPs)](#smithery) | `mcps.js` | API REST + CLI |
| [ClawHub (skills)](#clawhub) | `skills.js` | API REST |

---

## Anthropic (Claude)

**SDK:** `@anthropic-ai/sdk` v0.78+

**Configuración:**
- API key: env `ANTHROPIC_API_KEY` o `provider-config.json`
- Modelo default: `claude-opus-4-6`
- Modelos disponibles: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, etc.

**Uso:**
```javascript
const stream = await client.messages.stream({
  model, max_tokens: 8192,
  system: systemPrompt,
  messages: history,
  tools: toolDefs,
})
```

**Features usados:** streaming, tool use

---

## Google Gemini

**SDK:** `@google/genai` v1.45+

**Configuración:**
- API key: env `GOOGLE_API_KEY` o `provider-config.json`
- Modelo default: `gemini-2.0-flash`
- Timeout: 60s por llamada (para evitar hang infinito)

**Uso:**
```javascript
const result = await ai.models.generateContentStream({
  model,
  contents: history,
  config: { systemInstruction: systemPrompt, maxOutputTokens: 8192 }
})
```

---

## OpenAI

**SDK:** `openai` v6.29+

**Configuración:**
- API key: env `OPENAI_API_KEY` o `provider-config.json`
- Modelo default: `gpt-4o`

**Uso:**
```javascript
const stream = await client.chat.completions.create({
  model, stream: true,
  messages: [{ role: 'system', content: systemPrompt }, ...history],
})
```

---

## Claude CLI

**Comando:** `claude -p --output-format stream-json --include-partial-messages --verbose`

No usa SDK. Spawnea un proceso hijo con `child_process.spawn()` y parsea el stream JSON de stdout.

**Características:**
- `--continue` para multi-turn (reutiliza sesión)
- Kill timeout: 18 minutos sin actividad
- Cleans env: elimina `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`
- Modes: `--permission-mode auto | ask | plan`
- Tracking: costo en USD, modelo usado, session_id, directorio de trabajo

**Eventos del stream JSON:**
```javascript
{ type: 'assistant', message: { content: [{ type: 'text', text: '...' }] } }
{ type: 'result', cost_usd: 0.003, session_id: 'uuid', cwd: '/path' }
```

---

## Telegram Bot API

**Protocolo:** HTTPS long polling (no webhooks)

**Endpoint base:** `https://api.telegram.org/bot<TOKEN>/`

**Métodos usados:**

| Método | Uso |
|--------|-----|
| `getMe` | Obtener info del bot al arrancar |
| `getUpdates` | Long polling (POLL_TIMEOUT=25s) |
| `sendMessage` | Enviar mensajes de texto |
| `editMessageText` | Animación de respuesta progresiva (throttle 1500ms) |
| `answerCallbackQuery` | Responder a botones inline |
| `deleteMessage` | Eliminar mensajes |

**Throttle:** Telegram limita a ~1 edición/s por mensaje. El sistema aplica throttle de 1500ms en `onChunk`.

**IPv4 forzado:** `family: 4` en todas las peticiones HTTPS para compatibilidad WSL2.

---

## faster-whisper

**Tipo:** Proceso Python hijo (`child_process.spawn`)

**Requisitos:**
- Python 3 en `~/.venvs/whisper/bin/python3`
- `faster-whisper` instalado (`pip install faster-whisper`)

**Parámetros:**
```python
faster_whisper.WhisperModel("medium", device="cpu", compute_type="int8")
segments, info = model.transcribe(audio_path, beam_size=5, language="es")
```

**Límites:** máx 5 minutos de audio, timeout de 5 minutos por transcripción.

---

## Smithery (MCPs)

**URL:** `https://registry.smithery.ai/servers`

**Uso:** búsqueda e instalación de Model Context Protocols.

```javascript
// Buscar
GET https://registry.smithery.ai/servers?q=query&pageSize=8

// Instalar
const config = { command, args, env }
await exec(`claude mcp add-json '${name}' '${JSON.stringify(config)}'`)
```

---

## ClawHub (skills)

**URL:** API pública de clawhub.ai

**Uso:** búsqueda e instalación de skills.

```javascript
// Buscar
GET https://api.clawhub.ai/skills/search?q=query

// Instalar (descarga SKILL.md)
GET https://raw.githubusercontent.com/<repo>/main/SKILL.md
```

Cada skill se guarda en `server/skills/<slug>/SKILL.md`.
