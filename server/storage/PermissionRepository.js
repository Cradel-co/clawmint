'use strict';

/**
 * PermissionRepository — persistencia de reglas de permisos por scope y tool pattern.
 *
 * Schema: (scope_type, scope_id, tool_pattern) → action ∈ {auto, ask, deny}
 *
 * Resolución:
 *   - Scopes evaluados en orden: chat → user → role → channel → global
 *   - Dentro de cada scope, patrón más específico gana (menos wildcards)
 *   - Sin match → null (el PermissionService aplica default 'auto')
 */

const VALID_SCOPE_TYPES = ['chat', 'user', 'role', 'channel', 'global'];
const VALID_ACTIONS = ['auto', 'ask', 'deny'];
const SCOPE_PRIORITY = ['chat', 'user', 'role', 'channel', 'global'];

class PermissionRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS permissions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_type    TEXT NOT NULL CHECK(scope_type IN ('chat','user','role','channel','global')),
      scope_id      TEXT,
      tool_pattern  TEXT NOT NULL,
      action        TEXT NOT NULL CHECK(action IN ('auto','ask','deny')),
      reason        TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_permissions_scope_tool ON permissions(scope_type, scope_id, tool_pattern);
  `;

  constructor(db) {
    this._db = db || null;
  }

  init() {
    if (!this._db) return;
    this._db.exec(PermissionRepository.SCHEMA);
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  create({ scope_type, scope_id = null, tool_pattern, action, reason = null }) {
    if (!this._db) return null;
    if (!VALID_SCOPE_TYPES.includes(scope_type)) {
      throw new Error(`scope_type inválido: ${scope_type} (válidos: ${VALID_SCOPE_TYPES.join(', ')})`);
    }
    if (!VALID_ACTIONS.includes(action)) {
      throw new Error(`action inválido: ${action} (válidos: ${VALID_ACTIONS.join(', ')})`);
    }
    if (!tool_pattern || typeof tool_pattern !== 'string') {
      throw new Error('tool_pattern requerido');
    }
    if (scope_type !== 'global' && !scope_id) {
      throw new Error(`scope_id requerido para scope_type='${scope_type}'`);
    }
    const now = Date.now();
    this._db.prepare(`
      INSERT INTO permissions (scope_type, scope_id, tool_pattern, action, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(scope_type, scope_id || null, tool_pattern, action, reason, now, now);
    const idRow = this._db.prepare('SELECT last_insert_rowid() AS id').get();
    const id = idRow && (idRow.id ?? idRow['last_insert_rowid()']);
    return id ? this.getById(id) : null;
  }

  getById(id) {
    if (!this._db) return null;
    return this._db.prepare('SELECT * FROM permissions WHERE id = ?').get(Number(id)) || null;
  }

  list(filter = {}) {
    if (!this._db) return [];
    const where = [];
    const args = [];
    if (filter.scope_type) { where.push('scope_type = ?'); args.push(filter.scope_type); }
    if (filter.scope_id)   { where.push('scope_id = ?');   args.push(filter.scope_id); }
    const sql = `SELECT * FROM permissions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return this._db.prepare(sql).all(...args);
  }

  remove(id) {
    if (!this._db) return false;
    const info = this._db.prepare('DELETE FROM permissions WHERE id = ?').run(Number(id));
    return info.changes > 0;
  }

  // ── Resolución ──────────────────────────────────────────────────────────

  /**
   * Resuelve la regla aplicable a `toolName` para el contexto dado.
   * @param {string} toolName
   * @param {object} ctx
   * @param {string} [ctx.chatId]
   * @param {string} [ctx.userId]
   * @param {string} [ctx.role]      rol del usuario ('admin'|'user')
   * @param {string} [ctx.channel]
   * @returns {{ action: 'auto'|'ask'|'deny', rule: object } | null}
   */
  resolve(toolName, ctx = {}) {
    if (!this._db || !toolName) return null;

    const scopeToId = {
      chat:    ctx.chatId,
      user:    ctx.userId,
      role:    ctx.role,
      channel: ctx.channel,
      global:  null,
    };

    for (const scope of SCOPE_PRIORITY) {
      const scopeId = scopeToId[scope];
      if (scope !== 'global' && !scopeId) continue;

      // Cargar reglas de este scope (con scope_id específico o NULL para global)
      const rules = scope === 'global'
        ? this._db.prepare('SELECT * FROM permissions WHERE scope_type = ? AND scope_id IS NULL').all(scope)
        : this._db.prepare('SELECT * FROM permissions WHERE scope_type = ? AND scope_id = ?').all(scope, String(scopeId));

      // Filtrar las que matchean el toolName
      const matches = rules.filter(r => _matchesPattern(toolName, r.tool_pattern));
      if (!matches.length) continue;

      // El patrón más específico gana (menor cantidad de wildcards = mayor specificity).
      // Tie-break: created_at DESC (la más reciente gana).
      matches.sort((a, b) => {
        const specA = _specificity(a.tool_pattern);
        const specB = _specificity(b.tool_pattern);
        if (specA !== specB) return specB - specA; // mayor specificity gana
        return (b.created_at || 0) - (a.created_at || 0);
      });

      const best = matches[0];
      return { action: best.action, rule: best };
    }

    return null;
  }

  count() {
    if (!this._db) return 0;
    const row = this._db.prepare('SELECT COUNT(*) AS n FROM permissions').get();
    return Number((row && (row.n ?? row['COUNT(*)'])) || 0);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Glob matching simple: '*', 'prefix_*', exact. */
function _matchesPattern(name, pattern) {
  if (pattern === '*') return true;
  if (pattern.endsWith('_*')) {
    const prefix = pattern.slice(0, -2);
    return name === prefix || name.startsWith(prefix + '_');
  }
  return name === pattern;
}

/**
 * Specificity score: más alto = más específico.
 * - '*' → 0
 * - 'prefix_*' → largo del prefix
 * - nombre exacto → 1000 + largo
 */
function _specificity(pattern) {
  if (pattern === '*') return 0;
  if (pattern.endsWith('_*')) return pattern.length - 2;
  return 1000 + pattern.length;
}

PermissionRepository._internal = { _matchesPattern, _specificity };
module.exports = PermissionRepository;
