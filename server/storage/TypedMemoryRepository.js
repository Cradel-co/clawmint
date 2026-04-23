'use strict';

/**
 * TypedMemoryRepository — memoria tipada persistida.
 *
 * Complementa el `memory.js` existente (archivos .md por agente). Esta tabla
 * indexa memoria por `kind ∈ {user, feedback, project, reference, freeform}`
 * con scope (`user`, `chat`, `agent`, `global`). El body vive en disco en
 * `memory/<scope_type>/<scope_id>/<name>.md` — la row tiene metadata + path.
 *
 * Separación vs `memory.js`:
 *   - `memory.js` — libre, por agentKey, sin tipo
 *   - `typed_memory` — estructurado, indexable, MEMORY.md auto-generado
 *
 * No se migra memory.js; conviven. Fase 8 no rompe el flujo actual.
 */

const VALID_KINDS = ['user', 'feedback', 'project', 'reference', 'freeform'];
const VALID_SCOPE_TYPES = ['user', 'chat', 'agent', 'global'];

class TypedMemoryRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS typed_memory (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_type   TEXT NOT NULL CHECK(scope_type IN ('user','chat','agent','global')),
      scope_id     TEXT,
      kind         TEXT NOT NULL CHECK(kind IN ('user','feedback','project','reference','freeform')),
      name         TEXT NOT NULL,
      description  TEXT,
      body_path    TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      UNIQUE(scope_type, scope_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_tm_scope_kind ON typed_memory(scope_type, scope_id, kind);
  `;

  static VALID_KINDS = VALID_KINDS;
  static VALID_SCOPE_TYPES = VALID_SCOPE_TYPES;

  constructor(db) {
    this._db = db || null;
  }

  init() {
    if (!this._db) return;
    this._db.exec(TypedMemoryRepository.SCHEMA);
  }

  create({ scope_type, scope_id = null, kind, name, description = null, body_path }) {
    if (!this._db) return null;
    if (!VALID_SCOPE_TYPES.includes(scope_type)) throw new Error(`scope_type inválido: ${scope_type}`);
    if (!VALID_KINDS.includes(kind)) throw new Error(`kind inválido: ${kind}`);
    if (!name) throw new Error('name requerido');
    if (!body_path) throw new Error('body_path requerido');
    if (scope_type !== 'global' && !scope_id) throw new Error(`scope_id requerido para scope='${scope_type}'`);

    const now = Date.now();
    this._db.prepare(`
      INSERT INTO typed_memory (scope_type, scope_id, kind, name, description, body_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scope_type, scope_id || null, kind, name, description, body_path, now, now);
    const idRow = this._db.prepare('SELECT last_insert_rowid() AS id').get();
    const id = idRow && (idRow.id ?? idRow['last_insert_rowid()']);
    return id ? this.getById(id) : null;
  }

  /** Upsert por (scope_type, scope_id, name). Útil para re-escribir una memoria. */
  upsert(fields) {
    const existing = this.findByName({ scope_type: fields.scope_type, scope_id: fields.scope_id, name: fields.name });
    if (existing) {
      return this.update(existing.id, fields);
    }
    return this.create(fields);
  }

  getById(id) {
    if (!this._db) return null;
    return this._db.prepare('SELECT * FROM typed_memory WHERE id = ?').get(Number(id)) || null;
  }

  findByName({ scope_type, scope_id, name }) {
    if (!this._db) return null;
    const scopeId = scope_id || null;
    if (scopeId === null) {
      return this._db.prepare('SELECT * FROM typed_memory WHERE scope_type = ? AND scope_id IS NULL AND name = ?').get(scope_type, name) || null;
    }
    return this._db.prepare('SELECT * FROM typed_memory WHERE scope_type = ? AND scope_id = ? AND name = ?').get(scope_type, scopeId, name) || null;
  }

  list({ scope_type, scope_id, kind } = {}) {
    if (!this._db) return [];
    const where = [];
    const args = [];
    if (scope_type) { where.push('scope_type = ?'); args.push(scope_type); }
    if (scope_id)   { where.push('scope_id = ?');   args.push(scope_id); }
    if (kind)       { where.push('kind = ?');       args.push(kind); }
    const sql = `SELECT * FROM typed_memory ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`;
    return this._db.prepare(sql).all(...args);
  }

  update(id, fields) {
    if (!this._db) return null;
    const allowed = ['kind', 'name', 'description', 'body_path'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (fields[k] === undefined) continue;
      if (k === 'kind' && !VALID_KINDS.includes(fields[k])) throw new Error(`kind inválido: ${fields[k]}`);
      sets.push(`${k} = ?`);
      vals.push(fields[k]);
    }
    if (!sets.length) return this.getById(id);
    sets.push('updated_at = ?');
    vals.push(Date.now());
    vals.push(Number(id));
    this._db.prepare(`UPDATE typed_memory SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.getById(id);
  }

  remove(id) {
    if (!this._db) return false;
    const info = this._db.prepare('DELETE FROM typed_memory WHERE id = ?').run(Number(id));
    return info.changes > 0;
  }

  count(filter = {}) {
    const rows = this.list(filter);
    return rows.length;
  }
}

module.exports = TypedMemoryRepository;
