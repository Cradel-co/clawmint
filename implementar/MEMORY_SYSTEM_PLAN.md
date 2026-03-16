# Plan: Sistema de Memoria con Grafo Obsidian-style

## Objetivo

Reemplazar el sistema de memoria actual (archivos planos cargados completos en el system prompt)
por un sistema optimizado de tokens inspirado en Obsidian + embeddings, con visualización
en grafo de nodos conectados (red tipo cerebro) directamente en el cliente de terminal-live.

---

## Problema actual

- `buildMemoryContext` carga **todos** los archivos del agente siempre → desperdicio de tokens
- Los archivos `.md` no tienen estructura de tags ni links entre ellos
- No hay forma de visualizar ni navegar la memoria del agente
- El costo de tokens crece linealmente con la cantidad de notas

---

## Ahorro de tokens (por qué funciona)

```
HOY
  Cada conversación: MEMORY.md + todos los .md del agente
  20 notas × ~300 tokens = ~6.500 tokens fijos siempre

CON EL SISTEMA NUEVO
  Inicio: MEMORY.md instrucciones     →  ~200 tokens (fijo, siempre)
  + mensaje usuario → extrae tags → query SQLite → 2-3 notas relevantes → ~600 tokens
  Total: ~800 tokens

  Con 50 notas sigue siendo ~800 tokens. El costo no crece.
```

---

## El modelo mental: memoria como cerebro

El cerebro no guarda eventos completos ni archivos exactos. Guarda **fragmentos distribuidos**
que se reconstruyen al momento de recordar:

| Cerebro | Nuestro sistema |
|---------|----------------|
| Fragmento distribuido | Chunk pequeño y focalizado |
| Conexión neuronal fuerte | Link explícito en frontmatter |
| Asociación semántica | Embedding similar |
| Categoría conceptual | Tag compartido |
| Reconstrucción al recordar | Ensamble de top-K chunks en el contexto |
| Repetición fortalece la conexión | `access_count` sube el ranking |

**Los chunks son recuerdos.** No importa si la memoria está dividida —
de hecho es mejor que esté dividida. Un chunk = una idea focalizada.
Al responder, el sistema ensambla los fragmentos más activados por el contexto actual.

```
Mensaje: "hay un error con el refresh token"
  → tag "auth"       activa → chunks de sesiones
  → embedding similar activa → chunks de JWT
  → tag "errors"     activa → chunk de ese error específico
  → top-K chunks ensamblados → inyectados como contexto
```

---

## Dos modos de retrieval según el modelo

El sistema detecta el contexto de ejecución y usa estrategia distinta:

| Contexto | Modo | Por qué |
|----------|------|---------|
| **Claude Code** | Búsqueda por tags | Tiene acceso a herramientas y archivos, puede consultar el DB directamente |
| **Modelos API** (`startClaudeSession`) | Búsqueda por embeddings | No tiene acceso al filesystem; el servidor busca y le inyecta el resultado |

En ambos casos el resultado es el mismo: chunks relevantes ensamblados en el contexto.
La diferencia es quién hace la búsqueda y cómo.

---

## Granularidad de chunks

Notas pequeñas y focalizadas aprovechan mejor el filtrado que notas grandes:

```
❌ Una nota grande: "Todo sobre autenticación" → 800 tokens, se carga completa
✓  Chunks pequeños: "JWT expiración" (150t) + "refresh tokens" (100t) + "bcrypt" (80t)
                     se carga solo el chunk que importa
```

Cada chunk debe representar **una sola idea**. Si una nota crece mucho, dividirla.

---

## Storage: archivos + SQLite

**Decisión:** los archivos `.md` son el source of truth. SQLite es el índice de búsqueda.

- El agente escribe/edita el `.md` (como hoy)
- Un indexador sincroniza el `.md` al DB (al guardar, al iniciar servidor)
- Si el DB se borra, se puede reconstruir desde los archivos

---

## Schema SQLite

```sql
-- Nodo principal
CREATE TABLE notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_key  TEXT NOT NULL,
  filename   TEXT NOT NULL,       -- nombre del .md
  title      TEXT NOT NULL,       -- del frontmatter
  content    TEXT NOT NULL,       -- body markdown sin frontmatter
  embedding  BLOB,                -- NULL en fase 1, vector en fase 2
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(agent_key, filename)
);

-- Tags normalizados
CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

-- Relación nota ↔ tags (muchos a muchos)
CREATE TABLE note_tags (
  note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  tag_id  INTEGER REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

-- Links explícitos entre notas
CREATE TABLE note_links (
  from_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  to_id   INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  PRIMARY KEY (from_id, to_id)
);
```

---

## Tres tipos de conexión (la red tipo cerebro)

```
Tipo 1 — Links explícitos          →  fuerte   →  borde sólido grueso
Tipo 2 — Tags compartidos          →  medio    →  borde punteado
Tipo 3 — Similitud por embedding   →  suave    →  borde translúcido (fase 2)
```

Tres niveles de relación = conexiones directas + asociaciones por categoría +
asociaciones semánticas difusas. Imita cómo funciona la memoria asociativa.

---

## Formato de notas con frontmatter

```markdown
---
title: JWT Auth Patterns
tags: [auth, jwt, security]
links: [debugging, sessions]
---
Contenido de la nota...
```

- `tags`: categorías → conexiones tipo 2 en el grafo
- `links`: referencias explícitas → conexiones tipo 1 en el grafo

---

## Cómo se inyecta la memoria en el contexto

**Opción A — El servidor filtra antes** (recomendada, transparente para el agente)
```
Mensaje usuario llega al servidor
  → extrae keywords/tags del texto
  → query SQLite WHERE tags IN (...)
  → inyecta solo notas relevantes en system prompt
  → LLM recibe mensaje + contexto filtrado
```

**Opción B — El agente consulta explícitamente**
```
LLM recibe mensaje
  → decide qué buscar
  → llama GET /api/memory/:agentKey/search?tags=auth,jwt
  → lee resultado, responde
```

La opción A no requiere cambios en el comportamiento del agente.
La opción B le da más control pero consume un turno extra de API.

---

## Backend — `server/memory.js`

Funciones nuevas:

#### `parseFrontmatter(content)`
Extrae `{ title, tags[], links[], body }` del YAML del archivo.

#### `indexNote(agentKey, filename)`
Parsea el `.md` y sincroniza la nota al DB (upsert en `notes`, `tags`, `note_tags`, `note_links`).

#### `buildGraph(agentKey?)`
Construye `{ nodes[], links[] }` para D3 desde el DB:
- Nodos: cada nota → `{ id, agentKey, filename, title, tags, preview }`
- Edges tipo `link`: de `note_links`
- Edges tipo `tag`: notas que comparten tag (desde `note_tags`)

#### `searchByTags(agentKey, tags[], q?)`
Query SQLite por tags (OR) y/o texto libre en title/content. Retorna resultados con score.

#### `buildMemoryContext` — actualizar
- Modo nuevo: recibe `tags[]` → usa `searchByTags` → carga solo lo relevante
- Modo legado: sigue aceptando `memoryFiles[]` para retrocompatibilidad

---

## Backend — `server/index.js`

```
GET  /api/memory/graph?agentKey=xxx
     → { nodes[], links[] } para D3
     → agentKey opcional (sin él incluye todos los agentes)

GET  /api/memory/:agentKey/search?tags=auth,jwt&q=texto
     → notas filtradas por tags y/o texto libre
```

---

## Frontend — `MemoryPanel.jsx` + `MemoryPanel.css`

Panel accesible con botón 🧠 en el header (fullscreen overlay).

**Grafo D3 force-directed (dark theme Obsidian):**
- Nodos = notas, coloreados por tag principal
- Tamaño proporcional a número de conexiones
- Edges sólidos gruesos = links explícitos (tipo 1)
- Edges punteados = tags compartidos (tipo 2)
- Edges translúcidos = similitud embedding (tipo 3, fase 2)
- Hover → resalta solo las conexiones del nodo
- Click → sidebar con contenido completo
- Filtro por tag, selector de agente, zoom/pan libre

**Sidebar:**
- Título, tags coloreados, lista de links
- Contenido completo del `.md`

---

## MEMORY.md del agente (meta-instrucciones)

Solo ~15 líneas. No contiene memoria real, solo instrucciones de uso:

```markdown
# Sistema de Memoria

Guardar: <save_memory file="nombre.md">contenido</save_memory>
Agregar: <append_memory file="nombre.md">contenido</append_memory>

Formato obligatorio (siempre incluir frontmatter):
---
title: Título descriptivo
tags: [tag1, tag2, tag3]
links: [otro-archivo]
---
Contenido...

Cuándo guardar: patrones recurrentes, preferencias del usuario,
decisiones arquitecturales, soluciones a errores.
NO guardar: contexto temporal, especulaciones.
```

---

## Economía de tokens — estrategias adicionales

### 1. Prompt caching (Anthropic)
Las partes estáticas del system prompt se marcan con `cache_control`.
Anthropic cobra 90% menos en tokens cacheados.

```
System prompt:
  [CACHEABLE] instrucciones base del agente   → se cachea entre conversaciones
  [CACHEABLE] MEMORY.md instrucciones         → se cachea entre conversaciones
  [DINÁMICO]  chunks recuperados del contexto → se recalcula por mensaje
```

El order importa: siempre primero lo estático (cacheable), al final lo dinámico.

---

### 2. Token budget para memoria
En lugar de "top-K chunks fijo", usar un presupuesto máximo de tokens:

```
Budget de memoria: 800 tokens
  → carga chunks por score de relevancia
  → corta cuando el siguiente chunk no entra en el budget
  → control preciso sin desperdiciar
```

---

### 3. Dedup por conversación
Si el chunk A ya fue inyectado en el turno 2, no re-inyectarlo en el turno 7
aunque siga siendo relevante. Trackear qué chunks ya están en el contexto activo.

```
conversationChunks = Set()   ← persiste durante la sesión
si chunk.id in conversationChunks → skip
```

---

### 4. Compresión automática al guardar
Cuando el agente guarda un chunk que supera un límite (ej. 400 tokens),
el sistema lo resume antes de guardarlo. El chunk original se archiva,
el activo es el comprimido.

---

### 5. Decay de relevancia
Chunks que no se recuperan hace mucho bajan en el ranking de score.
Evita cargar recuerdos obsoletos que ya no aplican al trabajo actual.

```
score_final = score_relevancia × decay(días_sin_acceso)
```

---

### 6. Sin re-inyección si el tema no cambió
Si los últimos N turnos hablan del mismo tema, no recalcular memoria en cada turno.
Solo recalcular cuando hay un topic shift detectable (embedding del mensaje
diverge del embedding promedio de los últimos turnos).

---

## Habilidades avanzadas

### 2. Importancia al guardar

No todos los recuerdos valen igual. La importancia se asigna al momento de guardar
y controla qué tan rápido decae el chunk:

```
importancia: 1-10
decay_rate = base_rate / importancia

importancia 1  → decae en semanas
importancia 10 → persiste meses o años
```

El agente infiere la importancia del contexto:

| Señal | Importancia |
|-------|------------|
| Decisión arquitectural mayor | 9-10 |
| Preferencia explícita del usuario | 8 |
| Solución a error recurrente | 7 |
| Patrón de código útil | 5-6 |
| Detalle menor de implementación | 2-3 |

La importancia también amplifica el **spreading activation**: chunks de alta importancia
activan sus vecinos con más fuerza en el grafo.

---

### 4. Anti-patrones (memoria permanente)

Una categoría especial de memoria que funciona distinto a todo lo demás. No es contextual — es **preventiva**.

```sql
tier: 'permanent'   -- nunca decae, nunca se archiva
type: 'antipattern' -- se chequea antes de actuar, no al recuperar contexto
```

Ejemplos:
```
"No usar moment.js — el usuario prefiere date-fns"
"No commitear sin correr tests — se quemó dos veces"
"No responder con listas largas — el usuario prefiere respuestas cortas"
```

**La diferencia clave:** los anti-patrones se chequean *antes* de que el agente actúe.
Si la acción matchea un anti-patrón, el sistema interrumpe y avisa.

```
Agente está por instalar moment.js
  → chequea anti-patrones con tag "dependencias"
  → encuentra "no usar moment.js"
  → avisa antes de ejecutar
```

---

### 5. Superficie proactiva

La memoria pasa de **pasiva** (solo responde si la consultan) a **activa**
(observa la conversación y habla cuando detecta relevancia alta).

```
Cada mensaje del usuario:
  → calcular embedding del mensaje
  → comparar contra chunks activos en DB
  → si similitud > 0.85 → surfacear el chunk
```

Dos niveles:

| Nivel | Cuándo | Comportamiento |
|-------|--------|----------------|
| **Suave** | similitud media | El agente menciona el recuerdo al final de su respuesta |
| **Urgente** | similitud alta + es anti-patrón | El agente avisa antes de responder |

**Control de ruido:** el mismo chunk no puede surfacearse más de una vez por conversación
(cooldown por sesión). El umbral de similitud evita falsos positivos.

```
"Estoy teniendo problemas con el login"
  → similitud 0.91 con chunk "Error JWT expiración - nov 2025"
  → "Tuve un recuerdo relevante de noviembre sobre esto: [preview]"
```

---

## Fases

| Fase | Qué | Dependencias |
|------|-----|--------------|
| 1 | Frontmatter + SQLite index + tags + grafo visual | `better-sqlite3` |
| 2 | Embeddings semánticos (conexiones tipo 3) | `sqlite-vec` + Ollama o API Anthropic |

---

## Archivos a modificar / crear

| Archivo | Acción |
|---------|--------|
| `server/memory.js` | Agregar `parseFrontmatter`, `indexNote`, `buildGraph`, `searchByTags`, actualizar `buildMemoryContext` |
| `server/index.js` | Agregar endpoints `/api/memory/graph` y `/api/memory/:agentKey/search` |
| `server/package.json` | Agregar `better-sqlite3` (fase 1), `sqlite-vec` (fase 2) |
| `client/package.json` | Agregar `d3` |
| `client/src/components/MemoryPanel.jsx` | Crear (grafo D3 + sidebar) |
| `client/src/components/MemoryPanel.css` | Crear (dark theme Obsidian) |
| `client/src/App.jsx` | Importar panel, agregar botón 🧠 |
