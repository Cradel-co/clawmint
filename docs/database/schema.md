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

## Tabla: `users` — multi-usuario con aprobación

Identidad central de cada miembro de la familia. Gestionada por `UsersRepository` + `AuthService`.

| Columna | Tipo | Constraints | Descripción |
|---------|------|-------------|-------------|
| `id` | TEXT | PK | UUID v4 |
| `name` | TEXT | NOT NULL | Nombre legible |
| `role` | TEXT | NOT NULL DEFAULT 'user' | `'admin'` \| `'user'` |
| `status` | TEXT | NOT NULL DEFAULT 'pending' | `'active'` \| `'pending'` \| `'disabled'` |
| `email` | TEXT | UNIQUE | (agregada por AuthService migration) |
| `password_hash` | TEXT | | bcrypt hash (nullable si OAuth-only) |
| `email_verified` | INTEGER | DEFAULT 0 | |
| `avatar_url` | TEXT | | URL del avatar (de OAuth o subido) |
| `created_at` | INTEGER | NOT NULL | timestamp ms |
| `updated_at` | INTEGER | NOT NULL | timestamp ms |

**Migración**: la columna `status` se agrega via `ALTER TABLE` idempotente. Al primer arranque post-deploy, los users existentes se setean a `'active'` (no lockear users legacy).

**Lifecycle**:
- DB vacía + primer registro → `role='admin'` + `status='active'` automático.
- Subsiguientes (sin invitación) → `status='pending'`. Login devuelve 403 con `code: 'pending'`.
- Con invitación válida (`auto_approve=1`) → `status='active'` directo.
- Admin puede `approve`/`reject`/`reactivate` desde `Configuración → Usuarios`.

---

## Tabla: `invitations` — onboarding por código (Fase A)

Invitaciones de un solo uso para que el admin agregue miembros sin tener que aprobar uno por uno. Gestionada por `InvitationsRepository`.

| Columna | Tipo | Constraints | Descripción |
|---------|------|-------------|-------------|
| `code` | TEXT | PK | hex random 32 chars |
| `created_by` | TEXT | NOT NULL, FK users.id | Admin que generó |
| `created_at` | INTEGER | NOT NULL | timestamp ms |
| `expires_at` | INTEGER | NOT NULL | default created_at + 24h, configurable |
| `used_at` | INTEGER | NULL | timestamp ms del consumo |
| `used_by_user_id` | TEXT | FK users.id | NULL hasta que se use |
| `role` | TEXT | NOT NULL DEFAULT 'user' | Rol al consumir |
| `family_role` | TEXT | | Etiqueta familiar: `mamá`, `papá`, `hijo`, etc. |
| `auto_approve` | INTEGER | NOT NULL DEFAULT 1 | 1 = bypass status='pending' |
| `revoked_at` | INTEGER | | Soft revoke por admin (no se borra, queda auditable) |

**Índices**:
```sql
CREATE INDEX idx_invitations_created_by ON invitations(created_by);
CREATE INDEX idx_invitations_expires_at ON invitations(expires_at);
```

**Estados** (`InvitationsRepository.getStatus`):
- `valid` — vigente, no usada, no revocada.
- `used` — `used_at` no es null.
- `expired` — `expires_at < now`.
- `revoked` — `revoked_at` no es null.

**Cleanup**: `cleanup()` borra invitaciones usadas hace >30 días o expiradas hace >7 días.

---

## Tabla: `household_data` — datos compartidos del hogar (Fase B)

Tabla flexible para datos compartidos entre todos los miembros `status='active'`. Gestionada por `HouseholdDataRepository`.

| Columna | Tipo | Constraints | Descripción |
|---------|------|-------------|-------------|
| `id` | TEXT | PK | UUID v4 |
| `kind` | TEXT | NOT NULL | `grocery_item` \| `family_event` \| `house_note` \| `service` \| `inventory` |
| `title` | TEXT | NOT NULL | Título legible |
| `data_json` | TEXT | | Payload JSON variable según `kind` |
| `date_at` | INTEGER | | Timestamp ms (events/services) |
| `alert_days_before` | INTEGER | | Días antes para alerta automática (events/services) |
| `completed_at` | INTEGER | | NULL = pendiente; usado en grocery/inventory/service |
| `created_by` | TEXT | NOT NULL, FK users.id | |
| `updated_by` | TEXT | FK users.id | Último que tocó |
| `created_at` | INTEGER | NOT NULL | |
| `updated_at` | INTEGER | NOT NULL | |

**Índices**:
```sql
CREATE INDEX idx_household_kind ON household_data(kind);
CREATE INDEX idx_household_date ON household_data(date_at);
CREATE INDEX idx_household_completed ON household_data(completed_at);
```

**Payload `data_json` por kind**:
- `grocery_item`: `{ quantity?: string, category?: string }`
- `family_event`: `{ type: 'birthday'|'appointment'|'meeting'|'other', recurrence: 'yearly'|'none', notes?: string }`
- `house_note`: `{ content: string, tags: string[] }`
- `service`: `{ amount?: number, currency: 'ARS', notes?: string }`
- `inventory`: `{ quantity: string, location: 'heladera'|'despensa'|'freezer'|'otros' }`

---

## Tabla: `system_config` — config global cifrada (instalable sin .env)

Key/value persistente para configuración global del server. Permite OAuth credentials cifradas, override de location manual, etc. Gestionada por `SystemConfigRepository`.

| Columna | Tipo | Constraints | Descripción |
|---------|------|-------------|-------------|
| `key` | TEXT | PK | Identificador (ej: `oauth:google:client_secret`) |
| `value` | TEXT | | Valor (cifrado si `is_secret=1`) |
| `is_secret` | INTEGER | DEFAULT 0 | 1 = cifrado con TokenCrypto (AES-256-GCM) |
| `updated_at` | INTEGER | NOT NULL | |

**Keys conocidas**:
- `oauth:google:client_id`, `oauth:google:client_secret` (secret)
- `oauth:github:client_id`, `oauth:github:client_secret` (secret)
- `oauth:spotify:client_id`, `oauth:spotify:client_secret` (secret)
- `location:manual:latitude`, `location:manual:longitude`, `location:manual:name`

Otros consumers pueden agregar keys con prefijo propio. `listByPrefix('foo:')` retorna todas las keys que empiezan con `foo:`, descifrando los secrets automáticamente.

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
