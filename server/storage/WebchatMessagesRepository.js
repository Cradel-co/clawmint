'use strict';

/**
 * WebchatMessagesRepository — persistencia de mensajes de WebChat en SQLite.
 *
 * Límite de 100 mensajes por sesión (FIFO). Limpieza de sesiones
 * inactivas > 7 días.
 */

const MAX_MESSAGES_PER_SESSION = 100;
const STALE_DAYS = 7;

class WebchatMessagesRepository {
  constructor(db) {
    this._db = db || null;
  }

  /** Crea la tabla si no existe. Idempotente. */
  init() {
    if (!this._db) return;
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Índice para consultas por sesión
    try {
      this._db.exec(`CREATE INDEX IF NOT EXISTS idx_wcm_session ON webchat_messages (session_id, id)`);
    } catch {}
  }

  /**
   * Guarda un mensaje. Aplica FIFO si se excede el límite.
   * @param {string} sessionId
   * @param {string} role  — 'user' | 'assistant' | 'system'
   * @param {string} content
   */
  push(sessionId, role, content) {
    if (!this._db) return;
    this._db.prepare(
      `INSERT INTO webchat_messages (session_id, role, content) VALUES (?, ?, ?)`
    ).run(sessionId, role, content);
    this._trim(sessionId);
  }

  /**
   * Guarda par usuario + asistente de una vez.
   * @param {string} sessionId
   * @param {string} userText
   * @param {string} assistantText
   */
  pushPair(sessionId, userText, assistantText) {
    if (!this._db) return;
    const stmt = this._db.prepare(
      `INSERT INTO webchat_messages (session_id, role, content) VALUES (?, ?, ?)`
    );
    stmt.run(sessionId, 'user', userText);
    stmt.run(sessionId, 'assistant', assistantText);
    this._trim(sessionId);
  }

  /**
   * Carga los últimos N mensajes de una sesión.
   * @param {string} sessionId
   * @param {number} [limit=100]
   * @returns {Array<{ role: string, content: string }>}
   */
  load(sessionId, limit = MAX_MESSAGES_PER_SESSION) {
    if (!this._db) return [];
    return this._db.prepare(
      `SELECT role, content FROM webchat_messages
       WHERE session_id = ? ORDER BY id DESC LIMIT ?`
    ).all(sessionId, limit).reverse();
  }

  /**
   * Borra todos los mensajes de una sesión.
   * @param {string} sessionId
   */
  clear(sessionId) {
    if (!this._db) return;
    this._db.prepare(`DELETE FROM webchat_messages WHERE session_id = ?`).run(sessionId);
  }

  /**
   * Limpia sesiones inactivas de más de STALE_DAYS días.
   */
  cleanup() {
    if (!this._db) return;
    this._db.prepare(
      `DELETE FROM webchat_messages WHERE session_id IN (
         SELECT session_id FROM webchat_messages
         GROUP BY session_id
         HAVING MAX(created_at) < datetime('now', ?)
       )`
    ).run(`-${STALE_DAYS} days`);
  }

  /** Recorta mensajes viejos si la sesión excede el límite */
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
