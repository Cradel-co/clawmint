'use strict';

/**
 * LimitsRepository — configuración de límites (rate limiting + sesiones) en SQLite.
 *
 * Tabla: limits (type, scope, scope_id, max_count, window_ms).
 * Método resolve() busca la regla más específica aplicable.
 */

const SCOPE_PRIORITY = ['provider', 'agent', 'user', 'bot', 'channel', 'global'];

class LimitsRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS limits (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT NOT NULL,
      scope      TEXT NOT NULL,
      scope_id   TEXT,
      max_count  INTEGER NOT NULL,
      window_ms  INTEGER,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      UNIQUE(type, scope, scope_id)
    )
  `;

  static DEFAULTS = {
    rate:    { max_count: 10, window_ms: 60000 },
    session: { max_count: 10, window_ms: null },
  };

  constructor(db) {
    this._db = db;
    this._cache = null;
  }

  init() {
    if (!this._db) return;
    this._db.exec(LimitsRepository.SCHEMA);
    this._loadCache();
  }

  // ── Cache ─────────────────────────────────────────────────────────────────

  _loadCache() {
    if (!this._db) return;
    const rows = this._db.prepare('SELECT * FROM limits WHERE enabled = 1').all();
    this._cache = rows;
  }

  _invalidateCache() {
    this._loadCache();
  }

  // ── Resolve ───────────────────────────────────────────────────────────────

  /**
   * Busca la regla más específica que aplique.
   * @param {'rate'|'session'} type
   * @param {object} context - { provider, agentKey, userId, botKey, channel }
   * @returns {{ max_count: number, window_ms: number|null }}
   */
  resolve(type, context = {}) {
    const rules = (this._cache || []).filter(r => r.type === type);
    if (!rules.length) return LimitsRepository.DEFAULTS[type] || { max_count: 10, window_ms: 60000 };

    const scopeMap = {
      provider: context.provider || null,
      agent:    context.agentKey || null,
      user:     context.userId   || null,
      bot:      context.botKey   || null,
      channel:  context.channel  || null,
      global:   null,
    };

    for (const scope of SCOPE_PRIORITY) {
      const scopeId = scopeMap[scope];
      if (scope !== 'global' && !scopeId) continue;

      const match = rules.find(r =>
        r.scope === scope && (scope === 'global' ? !r.scope_id : r.scope_id === scopeId)
      );
      if (match) return { max_count: match.max_count, window_ms: match.window_ms };
    }

    return LimitsRepository.DEFAULTS[type] || { max_count: 10, window_ms: 60000 };
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  list(filters = {}) {
    if (!this._db) return [];
    let sql = 'SELECT * FROM limits';
    const conditions = [];
    const params = [];

    if (filters.type) { conditions.push('type = ?'); params.push(filters.type); }
    if (filters.scope) { conditions.push('scope = ?'); params.push(filters.scope); }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY type, scope, scope_id';

    return this._db.prepare(sql).all(...params);
  }

  getById(id) {
    if (!this._db) return null;
    return this._db.prepare('SELECT * FROM limits WHERE id = ?').get(id) || null;
  }

  create({ type, scope, scope_id, max_count, window_ms, enabled }) {
    if (!this._db) return null;
    if (!type || !scope || max_count == null) throw new Error('type, scope y max_count son requeridos');
    if (!['rate', 'session'].includes(type)) throw new Error('type debe ser "rate" o "session"');
    if (!SCOPE_PRIORITY.includes(scope)) throw new Error(`scope debe ser uno de: ${SCOPE_PRIORITY.join(', ')}`);

    const result = this._db.prepare(`
      INSERT INTO limits (type, scope, scope_id, max_count, window_ms, enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      type,
      scope,
      scope_id || null,
      max_count,
      type === 'rate' ? (window_ms || 60000) : null,
      enabled != null ? (enabled ? 1 : 0) : 1,
    );

    this._invalidateCache();
    return this.getById(result.lastInsertRowid || this._db.prepare('SELECT last_insert_rowid() as id').get().id);
  }

  update(id, fields) {
    if (!this._db) return null;
    const existing = this.getById(id);
    if (!existing) return null;

    const sets = [];
    const params = [];

    for (const key of ['max_count', 'window_ms', 'enabled', 'scope_id']) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(key === 'enabled' ? (fields[key] ? 1 : 0) : fields[key]);
      }
    }

    if (!sets.length) return existing;
    params.push(id);
    this._db.prepare(`UPDATE limits SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    this._invalidateCache();
    return this.getById(id);
  }

  remove(id) {
    if (!this._db) return false;
    const result = this._db.prepare('DELETE FROM limits WHERE id = ?').run(id);
    this._invalidateCache();
    return result.changes > 0;
  }
}

module.exports = LimitsRepository;
