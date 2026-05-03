'use strict';

const crypto = require('crypto');

/**
 * InvitationsRepository — invitaciones de un solo uso para onboarding familiar.
 *
 * Schema:
 *   invitations(
 *     code           PK — hex random 32 chars
 *     created_by     user_id del admin que la generó
 *     created_at     timestamp ms
 *     expires_at     timestamp ms (default: created_at + 24h)
 *     used_at        timestamp ms (NULL = no usada)
 *     used_by_user_id user_id del que la usó (NULL hasta que se use)
 *     role           rol que recibe el invitado (default 'user', futuro 'admin')
 *     family_role    etiqueta familiar opcional ('mamá', 'papá', 'hijo', etc.)
 *     auto_approve   1 = bypass status='pending' al usar (default 1)
 *     revoked_at     timestamp ms (NULL = vigente; soft revoke por admin)
 *   )
 */
class InvitationsRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS invitations (
      code            TEXT PRIMARY KEY,
      created_by      TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      used_at         INTEGER,
      used_by_user_id TEXT,
      role            TEXT NOT NULL DEFAULT 'user',
      family_role     TEXT,
      auto_approve    INTEGER NOT NULL DEFAULT 1,
      revoked_at      INTEGER,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_invitations_created_by ON invitations(created_by);
    CREATE INDEX IF NOT EXISTS idx_invitations_expires_at ON invitations(expires_at);
  `;

  constructor(db) {
    this._db = db || null;
  }

  init() {
    if (!this._db) return;
    this._db.exec(InvitationsRepository.SCHEMA);
  }

  /**
   * Genera una invitación con código random.
   * @param {string} createdBy — user_id del admin
   * @param {object} [opts]
   * @param {number} [opts.ttlMs=86400000] — 24h
   * @param {string} [opts.role='user']
   * @param {string} [opts.familyRole] — 'mamá', 'papá', 'hijo', etc.
   */
  create(createdBy, opts = {}) {
    if (!this._db || !createdBy) return null;
    const code = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const expiresAt = now + (opts.ttlMs || 24 * 60 * 60 * 1000);
    const role = opts.role || 'user';
    const familyRole = opts.familyRole || null;
    this._db.prepare(`
      INSERT INTO invitations (code, created_by, created_at, expires_at, role, family_role, auto_approve)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(code, createdBy, now, expiresAt, role, familyRole);
    return this.get(code);
  }

  get(code) {
    if (!this._db || !code) return null;
    return this._db.prepare('SELECT * FROM invitations WHERE code = ?').get(code) || null;
  }

  /** Estado lógico: 'valid' | 'used' | 'expired' | 'revoked'. */
  getStatus(invitation) {
    if (!invitation) return 'unknown';
    if (invitation.revoked_at) return 'revoked';
    if (invitation.used_at) return 'used';
    if (invitation.expires_at < Date.now()) return 'expired';
    return 'valid';
  }

  /**
   * Marca una invitación como usada. Atómico: solo lo permite si está vigente.
   * @returns {boolean} true si se consumió, false si ya estaba usada/expirada/revocada.
   */
  markUsed(code, userId) {
    if (!this._db) return false;
    const inv = this.get(code);
    if (!inv) return false;
    if (this.getStatus(inv) !== 'valid') return false;
    const result = this._db.prepare(`
      UPDATE invitations SET used_at = ?, used_by_user_id = ?
      WHERE code = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    `).run(Date.now(), userId, code, Date.now());
    return result.changes > 0;
  }

  /** Revoca una invitación (soft, queda en DB para auditoría). */
  revoke(code) {
    if (!this._db) return false;
    const result = this._db.prepare(`
      UPDATE invitations SET revoked_at = ?
      WHERE code = ? AND used_at IS NULL AND revoked_at IS NULL
    `).run(Date.now(), code);
    return result.changes > 0;
  }

  /** Lista invitaciones con info derivada de status. Filtra por created_by si se pasa. */
  list({ createdBy } = {}) {
    if (!this._db) return [];
    const rows = createdBy
      ? this._db.prepare('SELECT * FROM invitations WHERE created_by = ? ORDER BY created_at DESC').all(createdBy)
      : this._db.prepare('SELECT * FROM invitations ORDER BY created_at DESC').all();
    return rows.map(r => ({ ...r, status: this.getStatus(r) }));
  }

  /** Cleanup: borra invitaciones vencidas hace más de 7 días o usadas hace más de 30. */
  cleanup() {
    if (!this._db) return 0;
    const expiredCutoff = Date.now() - 7 * 86400000;
    const usedCutoff = Date.now() - 30 * 86400000;
    const r = this._db.prepare(`
      DELETE FROM invitations
      WHERE (expires_at < ? AND used_at IS NULL)
         OR (used_at IS NOT NULL AND used_at < ?)
    `).run(expiredCutoff, usedCutoff);
    return r.changes;
  }
}

module.exports = InvitationsRepository;
