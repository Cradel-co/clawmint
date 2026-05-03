'use strict';

/**
 * HookRepository — persistencia de reglas de hooks.
 *
 * Schema: hooks(id, event, scope_type, scope_id, handler_type, handler_ref,
 *               priority, timeout_ms, enabled, reason, created_at, updated_at).
 *
 * CRUD + queries por event/scope para que `HookLoader` cargue al boot.
 */

const VALID_EVENTS = [
  'pre_tool_use', 'post_tool_use', 'user_prompt_submit', 'assistant_response',
  'session_start', 'session_end', 'pre_compact', 'post_compact',
  'tool_error', 'permission_decided',
];
const VALID_SCOPE_TYPES   = ['chat', 'user', 'agent', 'channel', 'global'];
const VALID_HANDLER_TYPES = ['shell', 'http', 'skill', 'js'];

class HookRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS hooks (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      event          TEXT NOT NULL,
      scope_type     TEXT NOT NULL DEFAULT 'global',
      scope_id       TEXT,
      handler_type   TEXT NOT NULL,
      handler_ref    TEXT NOT NULL,
      priority       INTEGER NOT NULL DEFAULT 50,
      timeout_ms     INTEGER NOT NULL DEFAULT 10000,
      enabled        INTEGER NOT NULL DEFAULT 1,
      reason         TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hooks_event_enabled ON hooks(event, enabled);
  `;

  static VALID_EVENTS = VALID_EVENTS;
  static VALID_SCOPE_TYPES = VALID_SCOPE_TYPES;
  static VALID_HANDLER_TYPES = VALID_HANDLER_TYPES;

  constructor(db) {
    this._db = db || null;
  }

  init() {
    if (!this._db) return;
    this._db.exec(HookRepository.SCHEMA);
  }

  create({ event, scope_type = 'global', scope_id = null, handler_type, handler_ref, priority = 50, timeout_ms = 10000, enabled = true, reason = null }) {
    if (!this._db) return null;
    if (!VALID_EVENTS.includes(event)) throw new Error(`event inválido: ${event}`);
    if (!VALID_SCOPE_TYPES.includes(scope_type)) throw new Error(`scope_type inválido: ${scope_type}`);
    if (!VALID_HANDLER_TYPES.includes(handler_type)) throw new Error(`handler_type inválido: ${handler_type}`);
    if (!handler_ref) throw new Error('handler_ref requerido');
    if (scope_type !== 'global' && !scope_id) throw new Error(`scope_id requerido para scope_type='${scope_type}'`);

    const now = Date.now();
    this._db.prepare(`
      INSERT INTO hooks (event, scope_type, scope_id, handler_type, handler_ref, priority, timeout_ms, enabled, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event, scope_type, scope_id || null, handler_type, handler_ref,
      Number(priority), Number(timeout_ms), enabled ? 1 : 0, reason, now, now
    );
    const idRow = this._db.prepare('SELECT last_insert_rowid() AS id').get();
    const id = idRow && (idRow.id ?? idRow['last_insert_rowid()']);
    return id ? this.getById(id) : null;
  }

  getById(id) {
    if (!this._db) return null;
    return this._hydrate(this._db.prepare('SELECT * FROM hooks WHERE id = ?').get(Number(id)));
  }

  list(filter = {}) {
    if (!this._db) return [];
    const where = [];
    const args = [];
    if (filter.event)        { where.push('event = ?');       args.push(filter.event); }
    if (filter.scope_type)   { where.push('scope_type = ?');  args.push(filter.scope_type); }
    if (filter.scope_id)     { where.push('scope_id = ?');    args.push(filter.scope_id); }
    if (filter.handler_type) { where.push('handler_type = ?'); args.push(filter.handler_type); }
    if (filter.enabled !== undefined) {
      where.push('enabled = ?');
      args.push(filter.enabled ? 1 : 0);
    }
    const sql = `SELECT * FROM hooks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority DESC, created_at ASC`;
    return this._db.prepare(sql).all(...args).map(r => this._hydrate(r));
  }

  update(id, fields) {
    if (!this._db) return null;
    const allowed = ['event', 'scope_type', 'scope_id', 'handler_type', 'handler_ref', 'priority', 'timeout_ms', 'enabled', 'reason'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (fields[k] === undefined) continue;
      if (k === 'event' && !VALID_EVENTS.includes(fields[k])) throw new Error(`event inválido: ${fields[k]}`);
      if (k === 'scope_type' && !VALID_SCOPE_TYPES.includes(fields[k])) throw new Error(`scope_type inválido`);
      if (k === 'handler_type' && !VALID_HANDLER_TYPES.includes(fields[k])) throw new Error(`handler_type inválido`);
      if (k === 'enabled') { sets.push(`enabled = ?`); vals.push(fields[k] ? 1 : 0); continue; }
      sets.push(`${k} = ?`);
      vals.push(fields[k]);
    }
    if (!sets.length) return this.getById(id);
    sets.push('updated_at = ?');
    vals.push(Date.now());
    vals.push(Number(id));
    const info = this._db.prepare(`UPDATE hooks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return info.changes > 0 ? this.getById(id) : null;
  }

  remove(id) {
    if (!this._db) return false;
    const info = this._db.prepare('DELETE FROM hooks WHERE id = ?').run(Number(id));
    return info.changes > 0;
  }

  count() {
    if (!this._db) return 0;
    const row = this._db.prepare('SELECT COUNT(*) AS n FROM hooks').get();
    return Number((row && (row.n ?? row['COUNT(*)'])) || 0);
  }

  _hydrate(row) {
    if (!row) return null;
    return {
      ...row,
      enabled: row.enabled === 1 || row.enabled === true,
    };
  }
}

module.exports = HookRepository;
