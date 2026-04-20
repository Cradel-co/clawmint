> Última actualización: 2026-04-19

# Integraciones externas

Servicios y SDKs externos que usa Clawmint, agrupados por tipo.

---

## Índice

### Providers de IA (SDKs oficiales)

| Servicio | Módulo |
|---|---|
| [Anthropic (Claude)](#anthropic-claude) | `providers/anthropic.js` |
| [Google Gemini](#google-gemini) | `providers/gemini.js` |
| [OpenAI](#openai) | `providers/openai.js` |
| Grok (xAI) | `providers/grok.js` |
| Ollama (local) | `providers/ollama.js` |
| [Claude CLI (`claude -p`)](#claude-cli) | `core/ClaudePrintSession.js` |

### Canales de mensajería

| Servicio | Módulo |
|---|---|
| [Telegram Bot API](#telegram-bot-api) | `channels/telegram/TelegramChannel.js` |
| WebChat | `channels/web/WebChannel.js` |
| P2P (deskcritter via nodriza) | `nodriza.js` |

### Audio / TTS

| Servicio | Módulo |
|---|---|
| [faster-whisper](#faster-whisper) | `transcriber.js` |
| Edge TTS / Piper / SpeechT5 / ElevenLabs / OpenAI TTS / Google TTS | `voice-providers/` |

### MCPs externos / Skills

| Servicio | Módulo |
|---|---|
| [Smithery (MCPs)](#smithery) | `mcps.js` |
| [ClawHub (skills)](#clawhub) | `skills.js` |

### APIs externas free (consumidas por MCP tools)

Sin API key, sin registro. Usadas por las tools de `mcp/tools/{location,environment,arFinance,briefs,userLocation}.js`.

| Servicio | Tool(s) que la usa |
|---|---|
| [Open-Meteo (weather + air quality + UV)](#open-meteo) | `weather_get`, `air_quality_get`, `uv_index_get` |
| [OpenStreetMap Nominatim (geocoding)](#openstreetmap-nominatim) | `user_location_save`, ProfilePanel |
| [ipwho.is (IP geolocalización)](#ipwhois) | `LocationService.getPublicGeo` |
| [date.nager.at (feriados)](#datenagerat) | `holiday_check`, `feriados_ar` |
| [dolarapi.com (cotización dólar AR)](#dolarapicom) | `dolar_ar` |
| [CoinGecko (crypto prices)](#coingecko) | `crypto_price` |
| [open.er-api.com (currency conversion)](#opener-apicom) | `currency_convert` |
| [Wikipedia REST](#wikipedia-rest) | `wikipedia_summary` |
| [TheMealDB (recetas)](#themealdb) | `recipe_random`, `recipe_search` |
| [JokeAPI](#jokeapi) | `joke_get` |

### MCP OAuth providers (auto-registrables, sin .env)

Si admin configura credentials desde el panel `OAuthCredentialsPanel` (o vía env vars), los handlers de `server/mcp-oauth-providers/` se auto-registran en `McpAuthService` y proveen flow OAuth completo:

| Provider | mcp_name(s) registrados | Credentials key |
|---|---|---|
| [Google](#google-oauth) | `google-calendar`, `google-gmail`, `google-drive`, `google-tasks` | `GOOGLE_CLIENT_ID/SECRET` |
| [GitHub](#github-oauth) | `github` | `GITHUB_CLIENT_ID/SECRET` |
| [Spotify](#spotify-oauth) | `spotify` | `SPOTIFY_CLIENT_ID/SECRET` |

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

---

## APIs externas free (sin API key)

Todas se llaman desde tools MCP. Sin SDK ni dependencias — usan `https.get` nativo.

### Open-Meteo

**URL:** `https://api.open-meteo.com/v1/forecast` y `https://air-quality-api.open-meteo.com/v1/air-quality`

**Tools:** `weather_get`, `air_quality_get`, `uv_index_get`. Resuelve coords con prioridad: user pref → server location → args.

```
GET /v1/forecast?latitude=X&longitude=Y&current_weather=true
                 &daily=weathercode,temperature_2m_max,temperature_2m_min,
                        precipitation_probability_max,uv_index_max
                 &timezone=auto&forecast_days=4
```

WMO weather codes mapeados a labels en español (despejado, lluvia, tormenta, etc.).

### OpenStreetMap Nominatim

**URL:** `https://nominatim.openstreetmap.org/search`

**Uso:** geocoding bidireccional. Free sin key, ~1 req/sec recomendado.

```
GET /search?q=Bahía+Blanca&format=json&limit=5&addressdetails=1
```

Headers: `User-Agent: Clawmint/1.0` requerido por TOS de OSM. Usado por:
- `user_location_save({ name })` — geocoding automático cuando user pasa solo `name`.
- `UserLocationSection` panel — search box con autocompletado.

### ipwho.is

**URL:** `https://ipwho.is/?fields=ip,success,country,country_code,region,city,postal,latitude,longitude,timezone`

**Uso:** geo de la IP pública del server. Free sin key, ~10k req/mes.

Cache 24h en `LocationService._publicIpCache`. Se invoca lazy al primer request de location o cuando admin pide refresh manual.

### date.nager.at

**URL:** `https://date.nager.at/api/v3/PublicHolidays/<year>/<countryCode>`

**Uso:** feriados nacionales por país (ISO-3166 alpha-2). Tools: `holiday_check`, `feriados_ar`. Country code se deriva auto de la IP pública del server (fallback `AR`).

### dolarapi.com

**URL:** `https://dolarapi.com/v1/dolares` y `/v1/dolares/{type}`

**Uso:** cotizaciones del dólar en Argentina. Tipos: `blue`, `oficial`, `mep`, `ccl`, `cripto`, `turista`, `mayorista`, `tarjeta`. Tool: `dolar_ar`.

```json
{
  "moneda": "USD",
  "casa": "blue",
  "compra": 1390,
  "venta": 1410,
  "fechaActualizacion": "..."
}
```

### CoinGecko

**URL:** `https://api.coingecko.com/api/v3/simple/price`

**Uso:** precios de cripto en cualquier moneda. Tool: `crypto_price({ symbols, vs })`.

```
GET /simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true
```

Free, sin key. Limitada a ~30 req/min.

### open.er-api.com

**URL:** `https://open.er-api.com/v6/latest/<base>`

**Uso:** conversión de monedas (any pair). Tool: `currency_convert({ amount, from, to })`. Tasas oficiales actualizadas diariamente.

### Wikipedia REST

**URL:** `https://<lang>.wikipedia.org/api/rest_v1/page/summary/<term>`

**Uso:** resumen rápido de un término en español/inglés/portugués. Tool: `wikipedia_summary({ term, lang })`. Devuelve título, extracto, URL, thumbnail.

### TheMealDB

**URL:** `https://www.themealdb.com/api/json/v1/1/{random,search}.php`

**Uso:** recetas con ingredientes y pasos. Tools: `recipe_random()`, `recipe_search({ query })`. Recetas mayormente en inglés.

### JokeAPI

**URL:** `https://v2.jokeapi.dev/joke/{category}?lang=es&safe-mode&blacklistFlags=...`

**Uso:** chistes seguros (sin nsfw/religious/political). Tool: `joke_get({ lang, category })`. Categorías: `Any`, `Misc`, `Programming`, `Pun`. Idiomas: `es`, `en`, `de`, `fr`, `pt`.

---

## MCP OAuth providers (auto-registrables)

Carpeta `server/mcp-oauth-providers/`. Si las credenciales están en `SystemConfigRepository` (UI admin) o en env vars, los handlers se auto-registran en `McpAuthService` al boot. Lectura dinámica — no requiere restart cuando admin cambia las credenciales.

### Google OAuth

**Credentials:** `oauth:google:client_id` + `oauth:google:client_secret` en `system_config` o `GOOGLE_CLIENT_ID/SECRET` en env.

**Providers registrados:** `google-calendar`, `google-gmail`, `google-drive`, `google-tasks` (un solo par cubre los 4).

**Scopes derivados de `mcp_name`:**
- `google-calendar`: `https://www.googleapis.com/auth/calendar`
- `google-gmail`: `https://www.googleapis.com/auth/gmail.modify`
- `google-drive`: `https://www.googleapis.com/auth/drive.readonly`
- `google-tasks`: `https://www.googleapis.com/auth/tasks`

**Setup**:
1. Console Google Cloud → OAuth 2.0 Client IDs.
2. Habilitar Calendar/Gmail/Drive/Tasks APIs.
3. Agregar redirect URIs: `http://<host>:3001/api/mcp-auth/callback/google-{calendar,gmail,drive,tasks}` (los 4).
4. Pegar client_id + client_secret en `Configuración → OAuth Creds → Google`.

### GitHub OAuth

**Credentials:** `GITHUB_CLIENT_ID/SECRET`.

**Setup**: GitHub → Settings → Developer Settings → OAuth Apps → New. Callback URL: `http://<host>:3001/api/mcp-auth/callback/github`.

**Scopes**: `repo read:user user:email`.

### Spotify OAuth

**Credentials:** `SPOTIFY_CLIENT_ID/SECRET`.

**Setup**: Spotify Developer Dashboard → Create App → Settings → Redirect URI: `http://<host>:3001/api/mcp-auth/callback/spotify`.

**Scopes** (incluye control de reproducción, requiere Premium):
```
user-read-playback-state user-modify-playback-state user-read-currently-playing
playlist-read-private playlist-modify-private playlist-modify-public
user-read-private user-read-email streaming
```
