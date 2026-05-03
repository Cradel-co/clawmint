'use strict';

/**
 * McpAuthRepository — tokens cifrados de MCPs externos con OAuth.
 *
 * Schema:
 *   mcp_auth(id, mcp_name, user_id, encrypted_token, token_type, expires_at,
 *            created_at, updated_at)
 *   UNIQUE(mcp_name, user_id)
 *
 * El repo NO cifra ni descifra — recibe `encrypted_token` ya procesado por
 * `TokenCrypto` desde el service layer. Diseño por separation of concerns:
 * el repo es CRUD puro sobre la tabla, el cifrado vive en otro módulo.
 */

class McpAuthRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS mcp_auth (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      mcp_name         TEXT NOT NULL,
      user_id          TEXT NOT NULL,
      encrypted_token  TEXT NOT NULL,
      token_type       TEXT DEFAULT 'bearer',
      expires_at       INTEGER,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      UNIQUE(mcp_name, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_auth_mcp_user ON mcp_auth(mcp_name, user_id);
    CREATE INDEX IF NOT EXISTS idx_mcp_auth_expires ON mcp_auth(expires_at);
  `;

  constructor(db) {
    this._db = db || null;
  }

  init() {
    if (!this._db) return;
    this._db.exec(McpAuthRepository.SCHEMA);
  }

  /** Upsert por (mcp_name, user_id). */
  upsert({ mcp_name, user_id, encrypted_token, token_type = 'bearer', expires_at = null }) {
    if (!this._db) return null;
    if (!mcp_name) throw new Error('mcp_name requerido');
    if (!user_id) throw new Error('user_id requerido');
    if (!encrypted_token) throw new Error('encrypted_token requerido');

    const now = Date.now();
    const existing = this.findByMcpUser(mcp_name, user_id);
    if (existing) {
      this._db.prepare(`
        UPDATE mcp_auth SET encrypted_token = ?, token_type = ?, expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(encrypted_token, token_type, expires_at, now, existing.id);
      return this.getById(existing.id);
    }
    this._db.prepare(`
      INSERT INTO mcp_auth (mcp_name, user_id, encrypted_token, token_type, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(mcp_name, user_id, encrypted_token, token_type, expires_at, now, now);
    const idRow = this._db.prepare('SELECT last_insert_rowid() AS id').get();
    const id = idRow && (idRow.id ?? idRow['last_insert_rowid()']);
    return id ? this.getById(id) : null;
  }

  getById(id) {
    if (!this._db) return null;
    return this._db.prepare('SELECT * FROM mcp_auth WHERE id = ?').get(Number(id)) || null;
  }

  findByMcpUser(mcp_name, user_id) {
    if (!this._db) return null;
    return this._db.prepare('SELECT * FROM mcp_auth WHERE mcp_name = ? AND user_id = ?').get(mcp_name, user_id) || null;
  }

  listByUser(user_id) {
    if (!this._db) return [];
    return this._db.prepare('SELECT * FROM mcp_auth WHERE user_id = ? ORDER BY updated_at DESC').all(user_id);
  }

  listByMcp(mcp_name) {
    if (!this._db) return [];
    return this._db.prepare('SELECT * FROM mcp_auth WHERE mcp_name = ? ORDER BY updated_at DESC').all(mcp_name);
  }

  remove(id) {
    if (!this._db) return false;
    const info = this._db.prepare('DELETE FROM mcp_auth WHERE id = ?').run(Number(id));
    return info.changes > 0;
  }

  removeByMcpUser(mcp_name, user_id) {
    if (!this._db) return false;
    const info = this._db.prepare('DELETE FROM mcp_auth WHERE mcp_name = ? AND user_id = ?').run(mcp_name, user_id);
    return info.changes > 0;
  }

  /** Retorna tokens que expiran antes de `beforeMs`. Útil para refresh batch. */
  listExpiring(beforeMs) {
    if (!this._db) return [];
    return this._db.prepare('SELECT * FROM mcp_auth WHERE expires_at IS NOT NULL AND expires_at < ? ORDER BY expires_at').all(Number(beforeMs));
  }
}

module.exports = McpAuthRepository;
