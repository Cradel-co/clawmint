'use strict';

/**
 * WebchatMessagesRepository — persistencia de mensajes y meta de WebChat en SQLite.
 *
 * - Tabla `webchat_messages`: payload de cada turno (role + content).
 * - Tabla `webchat_session_meta`: título, pinned, archived, agent, etc por sesión.
 *
 * Límite de 100 mensajes por sesión (FIFO). Limpieza de sesiones inactivas > 7 días.
 */

const MAX_MESSAGES_PER_SESSION = 100;
const STALE_DAYS = 7;

class WebchatMessagesRepository {
  constructor(db) {
    this._db = db || null;
  }

  /** Crea las tablas si no existen. Idempotente. */
  init() {
    if (!this._db) return;
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS webchat_session_meta (
        session_id  TEXT PRIMARY KEY,
        user_id     TEXT,
        title       TEXT,
        pinned      INTEGER NOT NULL DEFAULT 0,
        archived    INTEGER NOT NULL DEFAULT 0,
        agent_key   TEXT,
        share_scope TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'household'
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Migración idempotente para DBs viejas
    try { this._db.exec(`ALTER TABLE webchat_session_meta ADD COLUMN share_scope TEXT NOT NULL DEFAULT 'user'`); } catch {}
    try {
      this._db.exec(`CREATE INDEX IF NOT EXISTS idx_wcm_session ON webchat_messages (session_id, id)`);
      this._db.exec(`CREATE INDEX IF NOT EXISTS idx_wcm_content ON webchat_messages (content)`);
      this._db.exec(`CREATE INDEX IF NOT EXISTS idx_wcsm_user ON webchat_session_meta (user_id, archived, pinned, updated_at)`);
    } catch {}
  }

  // ── Mensajes ──────────────────────────────────────────────────────────────

  push(sessionId, role, content) {
    if (!this._db) return;
    this._db.prepare(
      `INSERT INTO webchat_messages (session_id, role, content) VALUES (?, ?, ?)`
    ).run(sessionId, role, content);
    this._touchMeta(sessionId);
    this._trim(sessionId);
  }

  pushPair(sessionId, userText, assistantText) {
    if (!this._db) return;
    const stmt = this._db.prepare(
      `INSERT INTO webchat_messages (session_id, role, content) VALUES (?, ?, ?)`
    );
    stmt.run(sessionId, 'user', userText);
    stmt.run(sessionId, 'assistant', assistantText);
    this._touchMeta(sessionId);
    this._trim(sessionId);
  }

  load(sessionId, limit = MAX_MESSAGES_PER_SESSION) {
    if (!this._db) return [];
    return this._db.prepare(
      `SELECT role, content FROM webchat_messages
       WHERE session_id = ? ORDER BY id DESC LIMIT ?`
    ).all(sessionId, limit).reverse();
  }

  /** Cuenta mensajes de una sesión (rápido, sin cargar contenido). */
  countMessages(sessionId) {
    if (!this._db) return 0;
    const r = this._db.prepare(
      `SELECT COUNT(*) as n FROM webchat_messages WHERE session_id = ?`
    ).get(sessionId);
    return r ? r.n : 0;
  }

  /** Borra todos los mensajes de una sesión. */
  clear(sessionId) {
    if (!this._db) return;
    this._db.prepare(`DELETE FROM webchat_messages WHERE session_id = ?`).run(sessionId);
  }

  // ── Meta de sesión ────────────────────────────────────────────────────────

  /** Crea (si no existe) la fila de meta y actualiza updated_at. Llamado en cada push. */
  _touchMeta(sessionId) {
    if (!this._db) return;
    this._db.prepare(`
      INSERT INTO webchat_session_meta (session_id, updated_at)
      VALUES (?, datetime('now'))
      ON CONFLICT(session_id) DO UPDATE SET updated_at = datetime('now')
    `).run(sessionId);
  }

  /** Setea o actualiza campos arbitrarios de meta. */
  setMeta(sessionId, fields = {}) {
    if (!this._db || !sessionId) return;
    const allowed = ['user_id', 'title', 'pinned', 'archived', 'agent_key', 'share_scope'];
    const cols = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.includes(k)) continue;
      cols.push(k);
      vals.push(v);
    }
    if (cols.length === 0) return;

    // upsert: insertar fila vacía si no existe, después update
    this._db.prepare(`
      INSERT OR IGNORE INTO webchat_session_meta (session_id) VALUES (?)
    `).run(sessionId);

    const setClause = cols.map(c => `${c} = ?`).join(', ');
    this._db.prepare(`
      UPDATE webchat_session_meta
      SET ${setClause}, updated_at = datetime('now')
      WHERE session_id = ?
    `).run(...vals, sessionId);
  }

  getMeta(sessionId) {
    if (!this._db) return null;
    return this._db.prepare(`
      SELECT session_id, user_id, title, pinned, archived, agent_key, share_scope, created_at, updated_at
      FROM webchat_session_meta WHERE session_id = ?
    `).get(sessionId) || null;
  }

  /**
   * Borra una sesión completa: meta + mensajes.
   */
  deleteSession(sessionId) {
    if (!this._db || !sessionId) return false;
    this._db.prepare(`DELETE FROM webchat_messages WHERE session_id = ?`).run(sessionId);
    this._db.prepare(`DELETE FROM webchat_session_meta WHERE session_id = ?`).run(sessionId);
    return true;
  }

  /**
   * Lista sesiones con meta + primer mensaje del usuario para fallback de título.
   * Filtra archived = 0 por default. Filtrable por user_id.
   *
   * @param {object} [opts]
   * @param {number} [opts.limit=200]
   * @param {string} [opts.userId]
   * @param {boolean} [opts.includeArchived=false]
   */
  listSessions(opts = {}) {
    if (!this._db) return [];
    const { limit = 200, userId = null, includeArchived = false } = opts;

    const where = [];
    const params = [];
    if (userId) {
      // User ve: sus propias conversaciones + las marcadas como household + las legacy sin user_id
      where.push(`(m.user_id = ? OR m.share_scope = 'household' OR m.user_id IS NULL)`);
      params.push(userId);
    }
    if (!includeArchived) {
      where.push(`COALESCE(m.archived, 0) = 0`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    params.push(limit);

    return this._db.prepare(`
      SELECT
        s.session_id,
        COUNT(s.id) AS message_count,
        MAX(s.created_at) AS last_at,
        (SELECT content FROM webchat_messages w2
         WHERE w2.session_id = s.session_id AND w2.role = 'user'
         ORDER BY w2.id ASC LIMIT 1) AS first_user_msg,
        m.title AS title,
        COALESCE(m.pinned, 0) AS pinned,
        COALESCE(m.archived, 0) AS archived,
        COALESCE(m.share_scope, 'user') AS share_scope,
        m.agent_key AS agent_key,
        m.user_id AS user_id
      FROM webchat_messages s
      LEFT JOIN webchat_session_meta m ON m.session_id = s.session_id
      ${whereSql}
      GROUP BY s.session_id
      ORDER BY pinned DESC, last_at DESC
      LIMIT ?
    `).all(...params);
  }

  /**
   * Búsqueda full-text en contenido de mensajes y títulos.
   * Devuelve sesiones únicas matchedas, con un snippet del primer match.
   *
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.limit=50]
   * @param {string} [opts.userId]
   */
  search(query, opts = {}) {
    if (!this._db || !query || !query.trim()) return [];
    const { limit = 50, userId = null } = opts;
    const like = `%${query.trim().replace(/[%_]/g, '\\$&')}%`;

    const params = [like, like, like];
    let userClause = '';
    if (userId) {
      userClause = `AND (m.user_id = ? OR m.share_scope = 'household' OR m.user_id IS NULL)`;
      params.push(userId);
    }
    params.push(limit);

    return this._db.prepare(`
      SELECT
        s.session_id,
        MAX(s.created_at) AS last_at,
        COUNT(s.id) AS message_count,
        (SELECT content FROM webchat_messages w2
         WHERE w2.session_id = s.session_id AND w2.content LIKE ? ESCAPE '\\'
         ORDER BY w2.id ASC LIMIT 1) AS snippet,
        m.title AS title,
        m.agent_key AS agent_key,
        COALESCE(m.pinned, 0) AS pinned,
        COALESCE(m.share_scope, 'user') AS share_scope
      FROM webchat_messages s
      LEFT JOIN webchat_session_meta m ON m.session_id = s.session_id
      WHERE (s.content LIKE ? ESCAPE '\\' OR m.title LIKE ? ESCAPE '\\')
      AND COALESCE(m.archived, 0) = 0
      ${userClause}
      GROUP BY s.session_id
      ORDER BY last_at DESC
      LIMIT ?
    `).all(...params);
  }

  /** Limpia sesiones inactivas + sus metas. */
  cleanup() {
    if (!this._db) return;
    this._db.prepare(
      `DELETE FROM webchat_messages WHERE session_id IN (
         SELECT session_id FROM webchat_messages
         GROUP BY session_id
         HAVING MAX(created_at) < datetime('now', ?)
       )`
    ).run(`-${STALE_DAYS} days`);
    // Borrar metas huérfanas (sin mensajes)
    this._db.prepare(`
      DELETE FROM webchat_session_meta
      WHERE session_id NOT IN (SELECT DISTINCT session_id FROM webchat_messages)
    `).run();
  }

  _trim(sessionId) {
    const count = this._db.prepare(
      `SELECT COUNT(*) as n FROM webchat_messages WHERE session_id = ?`
    ).get(sessionId);
    if (count && count.n > MAX_MESSAGES_PER_SESSION) {
      const excess = count.n - MAX_MESSAGES_PER_SESSION;
      this._db.prepare(
        `DELETE FROM webchat_messages WHERE id IN (
           SELECT id FROM webchat_messages WHERE session_id = ? ORDER BY id ASC LIMIT ?
         )`
      ).run(sessionId, excess);
    }
  }
}

module.exports = WebchatMessagesRepository;
