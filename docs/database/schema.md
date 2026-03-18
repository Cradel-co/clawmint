> Última actualización: 2026-03-17

# Schema de base de datos

**Archivo:** `server/memory/index.db` (SQLite)
**Definido en:** `server/memory.js` (constante `DB_SCHEMA`) + `server/storage/ChatSettingsRepository.js`

---

## Tabla: `notes`

Notas de memoria indexadas. La fuente de verdad del contenido es el archivo `.md`; esta tabla es el índice para búsqueda eficiente.

| Columna | Tipo | Constraints | Descripción |
|---------|------|-------------|-------------|
| `id` | INTEGER | PK AUTOINCREMENT | ID interno |
| `agent_key` | TEXT | NOT NULL | Clave del agente dueño de la nota |
| `filename` | TEXT | NOT NULL | Nombre del archivo `.md` (ej: `laboral.md`) |
| `title` | TEXT | NOT NULL | Título de la nota (del frontmatter YAML) |
| `content` | TEXT | NOT NULL | Contenido completo de la nota |
| `importance` | INTEGER | DEFAULT 5 | Importancia 1-10 (del frontmatter o default) |
| `access_count` | INTEGER | DEFAULT 0 | Contador de accesos (ACT-R BLA) |
| `last_accessed` | DATETIME | | Última vez que se accedió |
| `created_at` | DATETIME | DEFAULT CURRENT_TIMESTAMP | |
| `updated_at` | DATETIME | DEFAULT CURRENT_TIMESTAMP | |

**Constraints:**
- `UNIQUE(agent_key, filename)` — un archivo por agente

**Índices implícitos:** por `(agent_key, filename)` (UNIQUE constraint crea índice automáticamente)

---

## Tabla: `tags`

Catálogo normalizado de tags (sustantivos extraídos del frontmatter YAML).

| Columna | Tipo | Constraints | Descripción |
|---------|------|-------------|-------------|
| `id` | INTEGER | PK | ID interno |
| `name` | TEXT | UNIQUE NOT NULL | Nombre del tag (lowercase) |

---

## Tabla: `note_tags`

Relación N:M entre notas y tags.

| Columna | Tipo | Constraints | Descripción |
|---------|------|-------------|-------------|
| `note_id` | INTEGER | PK, FK → `notes(id)` ON DELETE CASCADE | |
| `tag_id` | INTEGER | PK, FK → `tags(id)` ON DELETE CASCADE | |

---

## Tabla: `note_links`

Links entre notas. Aprende por co-acceso (Hebbiano): cada vez que dos notas se recuperan juntas, `co_access_count` se incrementa.

| Columna | Tipo | Constraints | Descripción |
|---------|------|-------------|-------------|
| `from_id` | INTEGER | PK, FK → `notes(id)` ON DELETE CASCADE | Nota origen |
| `to_id` | INTEGER | PK, FK → `notes(id)` ON DELETE CASCADE | Nota destino |
| `co_access_count` | INTEGER | DEFAULT 0 | Número de veces co-accedidas |
| `type` | TEXT | DEFAULT 'explicit' | `'explicit'` (del frontmatter) \| `'learned'` (por co-acceso) |

---

## Tabla: `note_embeddings`

Vectores de embedding para búsqueda semántica (feature en desarrollo).

| Columna | Tipo | Constraints | Descripción |
|---------|------|-------------|-------------|
| `note_id` | INTEGER | PK, FK → `notes(id)` ON DELETE CASCADE | |
| `provider` | TEXT | PK NOT NULL | `'openai'` \| `'gemini'` |
| `model` | TEXT | NOT NULL | Modelo que generó el embedding |
| `vector` | TEXT | NOT NULL | JSON array de floats |
| `created_at` | DATETIME | DEFAULT CURRENT_TIMESTAMP | |
| `updated_at` | DATETIME | DEFAULT CURRENT_TIMESTAMP | |

---

## Tabla: `consolidation_queue`

Cola de señales pendientes de consolidación. `memory-consolidator.js` la procesa cada 2 minutos.

| Columna | Tipo | Constraints | Descripción |
|---------|------|-------------|-------------|
| `id` | INTEGER | PK AUTOINCREMENT | |
| `agent_key` | TEXT | NOT NULL | Agente al que pertenece |
| `chat_id` | TEXT | | Chat de Telegram origen |
| `turns` | TEXT | NOT NULL | JSON: `[{text, types, ts}]` — turnos a consolidar |
| `source` | TEXT | DEFAULT 'signal' | `'signal'` \| `'session_end'` \| `'manual'` |
| `status` | TEXT | DEFAULT 'pending' | `'pending'` \| `'processing'` \| `'done'` \| `'error'` |
| `error` | TEXT | | Mensaje de error si falló |
| `created_at` | DATETIME | DEFAULT CURRENT_TIMESTAMP | |
| `processed_at` | DATETIME | | Cuándo fue procesado |

---

## Tabla: `chat_settings`

Provider y modelo seleccionados por chat de Telegram. Gestionada por `ChatSettingsRepository`.

| Columna | Tipo | Constraints | Descripción |
|---------|------|-------------|-------------|
| `bot_key` | TEXT | PK, NOT NULL | Clave del bot Telegram |
| `chat_id` | TEXT | PK, NOT NULL | ID del chat (como string) |
| `provider` | TEXT | NOT NULL DEFAULT 'claude-code' | Provider activo |
| `model` | TEXT | | Modelo específico (null = default del provider) |

**Constraints:**
- `PRIMARY KEY (bot_key, chat_id)` — un setting por (bot, chat)

---

## Archivos de memoria (Markdown)

Complementan el índice SQLite. Son la fuente de verdad del contenido.

**Ruta:** `server/memory/<agentKey>/<filename>.md`

**Formato (frontmatter YAML):**
```markdown
---
title: Título conciso de la nota
tags: [sustantivo1, sustantivo2, sustantivo3]
importance: 8
links: [otra-nota.md, tercera.md]
---

Contenido de la nota.
Puede ser multilinea.
```

**Campos del frontmatter:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `title` | string | Título indexado en SQLite |
| `tags` | string[] | Tags usados en búsqueda por spreading activation |
| `importance` | number (1-10) | Peso en curva de olvido de Ebbinghaus (default: 5) |
| `links` | string[] | Links explícitos a otras notas del mismo agente |

**Archivos especiales:**

| Archivo | Descripción |
|---------|-------------|
| `memory/<agentKey>/preferences.json` | Preferencias del agente: señales, settings, tópicos |
| `memory/defaults.json` | Preferencias globales (aplican a todos los agentes) |
