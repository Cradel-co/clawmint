> Última actualización: 2026-03-17

# Relaciones del modelo de datos

---

## Diagrama conceptual

```
agents (JSON)
    │ 1:N
    ▼
notes ──────────────── note_tags ──── tags
  │                                    │
  │ (self-join via note_links)          │
  ▼                                    │
note_links ◄──────────── spreading activation consume ambos
  │
note_embeddings

chat_settings ──────────── (bot_key relaciona con bots.json)

consolidation_queue ──────── (agent_key relaciona con agents.json)
```

---

## Relaciones principales

### `notes` → `tags` (via `note_tags`)

```sql
-- Todas las tags de una nota
SELECT t.name
FROM tags t
JOIN note_tags nt ON nt.tag_id = t.id
WHERE nt.note_id = ?;

-- Todas las notas con un tag específico
SELECT n.*
FROM notes n
JOIN note_tags nt ON nt.note_id = n.id
JOIN tags t ON t.id = nt.tag_id
WHERE t.name = ? AND n.agent_key = ?;
```

---

### `notes` → `notes` (via `note_links`)

```sql
-- Vecinos de una nota (links de salida)
SELECT n.*, nl.co_access_count, nl.type
FROM note_links nl
JOIN notes n ON n.id = nl.to_id
WHERE nl.from_id = ?
ORDER BY nl.co_access_count DESC;

-- Notas más conectadas (hubs de conocimiento)
SELECT n.filename, n.title, COUNT(*) as degree
FROM note_links nl
JOIN notes n ON n.id = nl.from_id OR n.id = nl.to_id
GROUP BY n.id
ORDER BY degree DESC
LIMIT 10;
```

---

### `notes` → `note_embeddings`

```sql
-- Embedding de una nota para un provider específico
SELECT vector
FROM note_embeddings
WHERE note_id = ? AND provider = 'openai';

-- Notas sin embedding (para indexación pendiente)
SELECT n.id, n.agent_key, n.filename
FROM notes n
LEFT JOIN note_embeddings ne ON ne.note_id = n.id AND ne.provider = 'openai'
WHERE ne.note_id IS NULL;
```

---

### `chat_settings` → `bots.json`

La columna `bot_key` en `chat_settings` referencia el campo `key` en `bots.json`. No hay FK real (bots.json no está en SQLite), pero la consistencia se mantiene a nivel aplicación: al eliminar un bot, los settings de sus chats quedan huérfanos (no son perjudiciales — se sobrescriben si el bot se recrea con la misma key).

---

### `consolidation_queue` → `notes`

La cola solo referencia `agent_key` (string). Los registros `done` pueden contener en `turns` el texto que eventualmente generó notas, pero no hay FK directa. La trazabilidad es via `agent_key` + `processed_at`.

---

## JOINs frecuentes en spreading activation

El algoritmo de búsqueda usa una secuencia de queries optimizadas:

```sql
-- 1. Notas semilla (por tags)
SELECT DISTINCT n.id, n.filename, n.title, n.content, n.importance,
       n.access_count, n.last_accessed,
       COUNT(t.name) as tag_hits
FROM notes n
JOIN note_tags nt ON nt.note_id = n.id
JOIN tags t ON t.id = nt.tag_id
WHERE n.agent_key = ? AND t.name IN (?, ?, ...)   -- keywords expandidas
GROUP BY n.id;

-- 2. Spreading (vecinos a 1 salto)
SELECT n.*, nl.co_access_count
FROM note_links nl
JOIN notes n ON n.id = nl.to_id
WHERE nl.from_id IN (?)   -- IDs de nodos semilla

-- 3. Incrementar co_access_count (aprendizaje Hebbiano)
INSERT INTO note_links (from_id, to_id, co_access_count, type)
VALUES (?, ?, 1, 'learned')
ON CONFLICT(from_id, to_id) DO UPDATE SET co_access_count = co_access_count + 1;
```

---

## Semántica del modelo

El modelo de datos refleja una **memoria episódica asociativa**:

- **`notes`**: unidades de conocimiento atómicas (como notas de papel)
- **`tags`**: índice invertido de conceptos (como etiquetas físicas)
- **`note_links`**: red asociativa que aprende con el uso (más se co-acceden, más fuertes los links)
- **`note_embeddings`**: representación vectorial para búsqueda por similitud semántica (feature en desarrollo)
- **`consolidation_queue`**: buffer temporal antes de que el LLM decida si vale la pena recordar algo

El diseño está inspirado en modelos cognitivos:
- **ACT-R** (Anderson): `access_count` + `last_accessed` → activación de base
- **Ebbinghaus**: curva de olvido suavizada por `importance`
- **Hebbian learning**: "las neuronas que se activan juntas se conectan" → `note_links.co_access_count`
