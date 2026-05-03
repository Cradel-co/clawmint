'use strict';

/**
 * SharedSessionsRepository — tokens opacos para compartir sesiones entre dispositivos.
 *
 * Schema: shared_sessions(id, token, session_id, owner_id, permissions, created_at, expires_at)
 *   - `token` es opaco e impredecible (crypto.randomBytes)
 *   - `permissions` es JSON: `{ read: true, write: false, allowedUserIds?: [] }`
 *   - `expires_at` en ms epoch; null = no expira
 *
 * Fase 12.4.
 */

const crypto = require('crypto');

class SharedSessionsRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS shared_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      token       TEXT NOT NULL UNIQUE,
      session_id  TEXT NOT NULL,
      owner_id    TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT '{"read":true,"write":false}',
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_shared_sessions_token ON shared_sessions(token);
    CREATE INDEX IF NOT EXISTS idx_shared_sessions_session ON shared_sessions(session_id);
  `;

  constructor(db) {
    this._db = db || null;
  }

  init() {
    if (!this._db) return;
    this._db.exec(SharedSessionsRepository.SCHEMA);
  }

  /**
   * Crea un share para una sesión. Retorna `{ token, expiresAt }`.
   * @param {object} args
   * @param {string} args.session_id
   * @param {string} args.owner_id
   * @param {object} [args.permissions]
   * @param {number} [args.ttlHours] — horas de vida; null = no expira
   */
  create({ session_id, owner_id, permissions, ttlHours }) {
    if (!this._db) return null;
    if (!session_id) throw new Error('session_id requerido');
    if (!owner_id) throw new Error('owner_id requerido');

    const token = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    const expires_at = ttlHours && ttlHours > 0 ? now + ttlHours * 3600_000 : null;
    const perms = JSON.stringify(permissions || { read: true, write: false });

    this._db.prepare(`
      INSERT INTO shared_sessions (token, session_id, owner_id, permissions, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(token, session_id, owner_id, perms, now, expires_at);

    return { token, session_id, owner_id, permissions: JSON.parse(perms), created_at: now, expires_at };
  }

  /** Resuelve un token a su record si válido y no expirado. Null si no existe o expiró. */
  getByToken(token) {
    if (!this._db || !token) return null;
    const row = this._db.prepare('SELECT * FROM shared_sessions WHERE token = ?').get(token);
    if (!row) return null;
    if (row.expires_at && row.expires_at < Date.now()) return null;
    return this._hydrate(row);
  }

  /** Lista shares creados por un usuario. */
  listByOwner(owner_id) {
    if (!this._db) return [];
    return this._db.prepare('SELECT * FROM shared_sessions WHERE owner_id = ? ORDER BY created_at DESC')
      .all(owner_id).map(r => this._hydrate(r));
  }

  /** Lista shares activos para una sesión (usado para broadcast). */
  listBySession(session_id) {
    if (!this._db) return [];
    const now = Date.now();
    return this._db.prepare('SELECT * FROM shared_sessions WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)')
      .all(session_id, now).map(r => this._hydrate(r));
  }

  remove(token) {
    if (!this._db) return false;
    const info = this._db.prepare('DELETE FROM shared_sessions WHERE token = ?').run(token);
    return info.changes > 0;
  }

  removeExpired() {
    if (!this._db) return 0;
    const info = this._db.prepare('DELETE FROM shared_sessions WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now());
    return info.changes;
  }

  _hydrate(row) {
    let permissions = { read: true, write: false };
    try { permissions = JSON.parse(row.permissions); } catch {}
    return {
      id: row.id,
      token: row.token,
      session_id: row.session_id,
      owner_id: row.owner_id,
      permissions,
      created_at: row.created_at,
      expires_at: row.expires_at,
    };
  }
}

module.exports = SharedSessionsRepository;
