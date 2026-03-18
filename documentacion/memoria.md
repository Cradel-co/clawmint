# Sistema de Memoria Persistente

Memoria semántica por agente. Persiste entre sesiones, recupera notas relevantes por contexto y aprende conexiones con el uso.

---

## Arquitectura general

```
┌─────────────────────────────────────────────────────────────┐
│                        Capa de entrada                       │
│          Telegram (_sendToSession / _sendToApiProvider)      │
└──────────────────────────┬──────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
  claude-code (PTY)              providers API (Anthropic/
  spreading activation           OpenAI/Gemini)
                                 → embeddings si aplica
           │                               │
           └───────────────┬───────────────┘
                           ▼
              ┌────────────────────────┐
              │       memory.js        │
              │  SQLite  +  archivos   │
              └────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
   memory-consolidator.js          embeddings.js
   (haiku en background)           (vectores OpenAI/Gemini)
```

**Archivos implicados:**

| Archivo | Rol |
|---------|-----|
| `memory.js` | CRUD de notas, índice SQLite, spreading activation, señales, nudge |
| `embeddings.js` | Vectores para OpenAI y Gemini, cosine similarity |
| `memory-consolidator.js` | Worker background: haiku consolida turnos pendientes |
| `telegram.js` | Inyecta memoria al inicio de sesión, detecta señales, aplica ops |

---

## Almacenamiento

### Archivos markdown (`server/memory/<agentKey>/*.md`)

Fuente de verdad. Cada nota tiene frontmatter YAML:

```markdown
---
title: JWT y autenticación
tags: [auth, jwt, seguridad]
importance: 8
links: [usuarios.md]
---
Los tokens expiran en 24h. Usar RS256.
```

**Campos:** `title`, `tags[]`, `importance` (1-10), `links[]` (opcional).

### SQLite (`server/memory/index.db`)

Índice sobre los archivos. Se regenera al arrancar con `indexAllNotes()`.

```
notes              → metadatos + body sin frontmatter
tags / note_tags   → índice invertido de tags
note_links         → grafo: enlaces explícitos + lazos Hebbianos
consolidation_queue → cola de turnos pendientes de consolidar
note_embeddings    → vectores float[] por nota y provider
```

**Schema `note_embeddings`:**

```sql
CREATE TABLE note_embeddings (
  note_id    INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,          -- 'openai' | 'gemini'
  model      TEXT NOT NULL,          -- 'text-embedding-3-small' | 'gemini-embedding-001'
  vector     TEXT NOT NULL,          -- JSON: float[]
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (note_id, provider)
);
```

Vectores indexados lazy: se calculan la primera vez que se necesitan y se persisten. `indexNote()` los invalida automáticamente cuando cambia el contenido de la nota.

---

## Flujo completo por mensaje (claude-code)

```
Usuario envía mensaje
        │
        ▼
┌───────────────────────────────────────────────┐
│ 1. buildMemoryContext(agentKey, texto)         │
│    → solo en el PRIMER mensaje de la sesión   │
│                                               │
│    extractKeywords(texto)                     │
│      → quita stopwords, normaliza acentos     │
│                                               │
│    expandKeywords(keywords)                   │
│      → STEM_TABLE: "entra*"→auth, etc.        │
│      → normaliza acentos ("autenticación")    │
│                                               │
│    spreadingActivation(agentKey, expanded)    │
│      → Paso 1a: match en tags SQLite          │
│      → Paso 1b: match parcial en títulos      │
│      → Paso 1c: match en contenido (≥5 chars) │
│      → Paso 2: spreading 2 saltos (D=0.7)     │
│      → Paso 3: ACT-R BLA + Ebbinghaus         │
│      → Paso 4: top notas dentro de 800 tokens │
│                                               │
│    → bloque "## Memoria relevante" inyectado  │
│      en el mensaje como contexto del sistema  │
└───────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────┐
│ 2. detectSignals(agentKey, texto)             │
│    → busca patrones: "me llamo", "recuerda",  │
│      fechas, eventos de vida, conocimiento    │
│    → si señal ≥ umbral → shouldNudge = true   │
│                                               │
│    buildNudge(signals)                        │
│    → "[SISTEMA — ACCIÓN REQUERIDA: DEBÉS      │
│       guardar esto usando <save_memory>...]"  │
│    → se CONCATENA al mensaje del usuario      │
└───────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────┐
│ 3. sendMessage → Claude                       │
│    primer mensaje: memoria + TOOL_INSTRUCTIONS│
│      + texto + nudge (si aplica)              │
│    turnos siguientes: recordatorio de notas   │
│      guardadas en la misma sesión +           │
│      texto + nudge (si aplica)                │
└───────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────┐
│ 4. extractMemoryOps(rawResponse)              │
│    → busca <save_memory file="x.md">…         │
│    → busca <append_memory file="x.md">…       │
│    → retorna lista de ops + respuesta limpia  │
└───────────────────────────────────────────────┘
        │
        ├── ops.length > 0 ─────────────────────┐
        │                                        ▼
        │                         applyOps(agentKey, ops)
        │                           write() / append()
        │                           indexNote() async
        │                           _savedInSession += filename
        │
        └── shouldNudge && ops = 0 ─────────────┐
                                                 ▼
                                    _pendingMemory.push(turno)
                                    → encolado para consolidador
```

---

## expandKeywords — normalización semántica

Antes de pasar keywords a `spreadingActivation`, se normalizan y expanden con `expandKeywords(keywords)`.

```
["autenticación", "entrando"] ──▶ expandKeywords ──▶ ["autenticacion", "entrando", "auth", "login", "acceso"]
```

**Dos transformaciones:**

1. **`_stripAccents(s)`** — elimina tildes: `"autenticación"` → `"autenticacion"`.
   Implementación: `s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')`.

2. **STEM_TABLE (~70 entradas)** — mapea prefijos de palabras a tags canónicos:

| Prefijo | Tags que agrega |
|---------|----------------|
| `entra` | `auth, login, acceso` |
| `autoriz` | `auth, permisos` |
| `credenci` | `auth, login` |
| `contrase` | `auth, seguridad` |
| `jwt`, `token` | `auth, jwt` |
| `postgres`, `mysql` | `postgresql, database` |
| `deploy`, `docker` | `deploy, infra` |
| `react`, `frontend` | `react, frontend` |
| `node`, `express` | `nodejs, backend` |
| `bug`, `error`, `falla` | `debug, error` |
| … | … (~65 más) |

**Efecto:** "entrar al sistema" → recupera notas con tag `auth` aunque el usuario no haya escrito esa palabra exacta.

---

## Visibilidad multi-turno (`_savedInSession`)

**Problema:** `buildMemoryContext` solo se llama en el turno 0. Si el usuario guarda una nota en el turno 1, el turno 2 no la ve en el contexto.

**Solución:** `chat._savedInSession[]` — lista de filenames guardados en la sesión actual.

```
Turno 1: Claude guarda "auth.md"
  applyOps → write() → _savedInSession.push("auth.md")

Turno 2: usuario envía mensaje
  messageText = "[Notas guardadas en esta conversación: auth.md]\n\n" + texto
  → Claude sabe que auth.md existe aunque no esté en la memoria del turno 0
```

Aplica solo al path **claude-code** (`_sendToSession`). Los providers API (`_sendToApiProvider`) reenvían `aiHistory` completo en cada turno, por lo que ya tienen visibilidad nativa.

---

## Spreading Activation — recuperación sin embeddings

Combina tres modelos cognitivos para puntuar cada nota:

```
keywords del usuario
        │
        ▼  expandKeywords()
        │  • normaliza acentos
        │  • aplica STEM_TABLE (~70 entradas)
        │
        ▼
┌─── Paso 1: semillas ───────────────────────┐
│  1a. tags SQLite ∩ keywords expandidos     │  activación = tag_hits + 2 si título matchea
│  1b. título de nota contiene keyword       │  activación = 0.5
│  1c. contenido contiene keyword (≥5 chars) │  activación = 0.3
└────────────────────────────────────────────┘
        │
        ▼
┌─── Paso 2: spreading (2 saltos) ───────────┐
│  para cada semilla → vecinos via note_links │
│  spread = activation × W × D              │
│  W = min(1.0, co_access_count / 10)        │  peso Hebbiano
│  D = 0.7 por salto (decay)                 │
│  cap en 1.0                                │
└────────────────────────────────────────────┘
        │
        ▼
┌─── Paso 3: modulación ─────────────────────┐
│  ACT-R BLA (Anderson):                     │
│    B = ln(n × t^(-0.5) / 0.5)             │  n=accesos, t=vida en seg
│                                            │
│  Ebbinghaus retention:                     │
│    R = e^(-días / (importance × 7))        │  importance alta = olvido lento
│                                            │
│  score = activation × (1 + max(0, B)) × R │
└────────────────────────────────────────────┘
        │
        ▼
  Ordenar por score, acumular hasta 800 tokens
  trackAccess(ids) + reinforceConnections(ids)  ← async
```

**Fallback:** si score=0 en todas → top-3 notas por importance + updated_at.

---

## Embeddings — recuperación para OpenAI y Gemini

Se activa automáticamente cuando `provider ∈ {openai, gemini}` y hay apiKey.

```
buildMemoryContext(agentKey, texto, { provider, apiKey })
        │
        ├─ provider soportado? ──No──▶ spreading activation (síncrono)
        │
        ▼ Sí → retorna Promise<string>
        │
        ▼
embed(texto, provider, apiKey)         ← embedding del query
  • openai  → text-embedding-3-small (1536 dims)
  • gemini  → gemini-embedding-001   (3072 dims)
        │
        ▼
Para cada nota del agente:
  getVector(db, noteId, provider)
    ├─ existe en note_embeddings → usar
    └─ no existe → embed(título+contenido) → saveVector()  [lazy]
        │
        ▼
cosineSimilarity(queryVec, noteVec)
  → score ∈ [0, 1]
  → filtrar por minScore=0.30
  → top-5 dentro de 800 tokens
        │
        ├─ sin resultados → fallback a spreading activation
        │
        ▼
trackAccess + reinforceConnections ← async
```

**Caché:** vectores calculados se persisten en SQLite (`note_embeddings`) y se cachean en RAM (`_vectorCache`). Al actualizar una nota, `indexNote()` invalida automáticamente su vector.

---

## Consolidador (haiku en background)

Para cuando Claude ignora el nudge o la sesión termina sin guardar.

```
Señal detectada pero Claude no guardó
        │
        ▼
_pendingMemory.push({ text, types, ts })
        │
Al cerrar sesión (/nueva, reset, callback):
        ▼
consolidator.enqueue(agentKey, chatId, _pendingMemory, 'session_end')
        │
        ▼  intervalo cada 2 min (o /compact manual)
processQueue()
  toma hasta 5 items 'pending'
        │
        ▼
_processItem(item)
  status → 'processing'
        │
        ▼
_runHaiku(prompt)
  spawn claude --dangerously-skip-permissions -p
               --model claude-haiku-4-5-20251001
               --output-format text
        │
        ▼
parsear output:
  <save_memory>   → applyOps(agentKey, ops)
  <new_topic>     → events.emit('memory:topic-suggestion')
                    → Telegram bot pregunta Sí/No al usuario
        │
        ▼
  status → 'done'  /  'error' + message
```

---

## Aprendizaje Hebbiano

"Neuronas que se activan juntas, se conectan."

```
Cada vez que se recuperan varias notas juntas:

reinforceConnections([id1, id2, id3])
  → INSERT INTO note_links (from_id, to_id, co_access_count+1, type='learned')
  → ON CONFLICT: co_access_count++

Peso W = min(1.0, co_access_count / 10)

Tras 10 co-recuperaciones conjuntas, W=1.0 → spreading máximo entre ellas.
```

---

## Señales de importancia

`detectSignals(agentKey, texto)` busca patrones en el texto del usuario:

| Tipo | Ejemplos | Importance |
|------|---------|-----------|
| `explicit` | "recuerda que", "no olvides", "anotá" | 10 |
| `personal` | "me llamo", "tengo X años", "trabajo en" | 9 |
| `life_event` | "murió", "nació", "me casé", "empecé" | 9 |
| `date_event` | "el 23 de...", "cumpleaños de" | 9 |
| `preference` | "prefiero", "odio", "siempre uso" | 8 |
| `knowledge` | "aprendí", "descubrí", "el error era" | 7 |

Si `importance ≥ umbral` del agente → `shouldNudge = true` → nudge imperativo añadido al mensaje.

---

## Preferencias por agente

Archivo `server/memory/<agentKey>/preferences.json`:

```json
{
  "version": 1,
  "signals": {
    "explicit":   { "enabled": true, "importance": 10 },
    "personal":   { "enabled": true, "importance": 9 },
    "life_event": { "enabled": true, "importance": 9 },
    "date_event": { "enabled": true, "importance": 9 },
    "preference": { "enabled": true, "importance": 8 },
    "knowledge":  { "enabled": true, "importance": 7 }
  },
  "settings": {
    "nudgeThreshold":        7,
    "consolidationEnabled":  true,
    "debug":                 false
  },
  "topics": []
}
```

**Debug en caliente:** cambiar `"debug": true` → logs activos en ≤30s sin reiniciar.

---

## Flujo para providers API (Anthropic/OpenAI/Gemini)

Diferencias respecto a claude-code:

```
_sendToApiProvider(chatId, text, chat, providerName)
        │
        ▼
buildMemoryContext(agentKey, text, { provider, apiKey })
  ├─ openai/gemini → Promise<string> via embeddings
  └─ anthropic     → string via spreading activation
        │
        ▼  await si es Promise
        │
systemPrompt = basePrompt + memoryCtx + TOOL_INSTRUCTIONS
        │
        ▼
detectSignals → nudge concatenado al userContent
        │
        ▼
chat.aiHistory.push({ role:'user', content: userContent })
        │
        ▼
provider.chat({ systemPrompt, history, apiKey, model })
  → loop agentic (tool calls si hay <save_memory> en tools)
        │
        ▼
extractMemoryOps(finalText)
  → applyOps + _pendingMemory si nudge sin save
```

**Nota:** `aiHistory` es el historial completo de la sesión, reenviado en cada turno (a diferencia de claude-code que usa `--continue` nativo).

---

## Comandos Telegram relacionados

| Comando | Acción |
|---------|--------|
| `/compact` | Sin args: stats de memoria + botón "Consolidar ahora". Con args: sugiere agregar tópico. |
| `/nueva` | Encola `_pendingMemory` antes de limpiar la sesión. |
| Botón "Sí, agregar tópico" | `consolidator.addTopic(agentKey, name)` → escribe en `preferences.json`. |
| Botón "Consolidar ahora" | Encola pending + dispara `processQueue()` manualmente. |
