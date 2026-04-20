'use strict';

/**
 * TaskRepository — persistencia de tareas del agente.
 *
 * Las tareas son scoped por `chat_id` (aislamiento entre conversaciones) y
 * soportan jerarquía vía `parent_id` con cascade delete.
 */
class TaskRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS tasks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id       TEXT NOT NULL,
      user_id       TEXT,
      agent_key     TEXT,
      title         TEXT NOT NULL,
      description   TEXT,
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','in_progress','completed','cancelled','blocked')),
      parent_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      metadata_json TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_chat     ON tasks(chat_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent   ON tasks(parent_id);
  `;

  static VALID_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled', 'blocked'];

  constructor(db) {
    this._db = db || null;
  }

  init() {
    if (!this._db) return;
    this._db.exec(TaskRepository.SCHEMA);
  }

  create({ chat_id, user_id, agent_key, title, description, parent_id, metadata }) {
    if (!this._db) return null;
    if (!chat_id) throw new Error('chat_id requerido');
    if (!title)   throw new Error('title requerido');
    const now = Date.now();
    this._db.prepare(`
      INSERT INTO tasks (chat_id, user_id, agent_key, title, description, parent_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chat_id,
      user_id || null,
      agent_key || null,
      title,
      description || null,
      parent_id || null,
      metadata ? JSON.stringify(metadata) : null,
      now, now,
    );
    // sqlite-wrapper no expone lastInsertRowid; se resuelve con last_insert_rowid()
    const idRow = this._db.prepare('SELECT last_insert_rowid() AS id').get();
    const id = idRow && (idRow.id ?? idRow['last_insert_rowid()']);
    return id ? this.getById(id, chat_id) : null;
  }

  getById(id, chatIdScope) {
    if (!this._db) return null;
    const row = chatIdScope && chatIdScope !== '*'
      ? this._db.prepare('SELECT * FROM tasks WHERE id = ? AND chat_id = ?').get(Number(id), String(chatIdScope))
      : this._db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id));
    return row ? this._hydrate(row) : null;
  }

  list({ chat_id, status, parent_id, limit = 20 }) {
    if (!this._db) return [];
    const where = [];
    const args = [];
    if (chat_id && chat_id !== '*') { where.push('chat_id = ?'); args.push(chat_id); }
    if (status)    { where.push('status = ?');    args.push(status); }
    if (parent_id !== undefined) {
      if (parent_id === null) where.push('parent_id IS NULL');
      else { where.push('parent_id = ?'); args.push(Number(parent_id)); }
    }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
    args.push(Number(limit));
    return this._db.prepare(sql).all(...args).map(r => this._hydrate(r));
  }

  children(parent_id, chat_id) {
    return this.list({ chat_id, parent_id, limit: 100 });
  }

  update(id, chat_id, fields) {
    if (!this._db) return false;
    const allowed = ['title', 'description', 'status', 'metadata'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (fields[key] === undefined) continue;
      if (key === 'metadata') {
        sets.push('metadata_json = ?');
        vals.push(fields.metadata ? JSON.stringify(fields.metadata) : null);
      } else if (key === 'status') {
        if (!TaskRepository.VALID_STATUSES.includes(fields.status)) {
          throw new Error(`status inválido: ${fields.status}`);
        }
        sets.push('status = ?');
        vals.push(fields.status);
      } else {
        sets.push(`${key} = ?`);
        vals.push(fields[key]);
      }
    }
    if (!sets.length) return false;
    sets.push('updated_at = ?');
    vals.push(Date.now());
    vals.push(Number(id));
    const where = chat_id && chat_id !== '*' ? 'id = ? AND chat_id = ?' : 'id = ?';
    if (chat_id && chat_id !== '*') vals.push(chat_id);
    const info = this._db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE ${where}`).run(...vals);
    return info.changes > 0;
  }

  remove(id, chat_id) {
    if (!this._db) return { removed: 0 };
    // Contar descendientes antes del cascade delete (para reportar al usuario).
    const descendants = this._countDescendants(Number(id));
    const info = chat_id && chat_id !== '*'
      ? this._db.prepare('DELETE FROM tasks WHERE id = ? AND chat_id = ?').run(Number(id), chat_id)
      : this._db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(id));
    return { removed: info.changes, descendants };
  }

  _countDescendants(id) {
    if (!this._db) return 0;
    let total = 0;
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      const children = this._db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(cur);
      for (const c of children) { total++; stack.push(c.id); }
    }
    return total;
  }

  _hydrate(row) {
    if (!row) return null;
    return {
      ...row,
      metadata: row.metadata_json ? safeParse(row.metadata_json) : null,
    };
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = TaskRepository;
