> Última actualización: 2026-03-17

# Base de datos

Clawmint usa **SQLite** (`server/memory/index.db`) gestionado por `better-sqlite3`. Un único archivo, sin servidor, zero-config.

---

## Índice

| Documento | Descripción |
|-----------|-------------|
| [schema.md](./schema.md) | Tablas completas: columnas, tipos, índices, constraints |
| [relaciones.md](./relaciones.md) | Relaciones implícitas, JOINs frecuentes y semántica del modelo |

---

## Tablas por dominio

### Memoria de agentes

| Tabla | Descripción |
|-------|-------------|
| `notes` | Notas de memoria indexadas por agente y filename |
| `tags` | Tags (sustantivos) extraídos del contenido |
| `note_tags` | Relación N:M entre notas y tags |
| `note_links` | Links Hebbianos entre notas (aprendidos por co-acceso) |
| `note_embeddings` | Vectores de embedding para búsqueda semántica |

### Consolidación

| Tabla | Descripción |
|-------|-------------|
| `consolidation_queue` | Cola de consolidación procesada cada 2 minutos |

### Configuración por chat

| Tabla | Descripción |
|-------|-------------|
| `chat_settings` | Provider y modelo seleccionados por chat de Telegram |

---

## Archivos relacionados

| Archivo | Rol |
|---------|-----|
| `server/memory.js` | Define `DB_SCHEMA`, gestiona toda la lógica de memoria |
| `server/storage/ChatSettingsRepository.js` | Define schema de `chat_settings`, CRUD |
| `server/memory-consolidator.js` | Lee y escribe `consolidation_queue` |
| `server/storage/DatabaseProvider.js` | Helper para abrir SQLite (disponible, sin uso activo) |

---

## Configuración SQLite

```javascript
db.pragma('journal_mode = WAL');   // escrituras no bloquean lecturas
db.pragma('foreign_keys = ON');    // integridad referencial activa
```
