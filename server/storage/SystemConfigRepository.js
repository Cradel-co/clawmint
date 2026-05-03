'use strict';

/**
 * SystemConfigRepository — tabla key/value global para config persistente sin env vars.
 *
 * Uso típico: guardar credenciales OAuth de providers (GOOGLE_CLIENT_ID, etc.)
 * que antes venían por env var. Los values son strings opacos (pueden ser JSON).
 *
 * Para secrets (client_secret) se recomienda ENcriptarlos con TokenCrypto antes
 * de guardar — pasar `tokenCrypto` opcional al constructor para setSecret/getSecret.
 *
 * Schema:
 *   system_config (key PRIMARY KEY, value, is_secret BOOLEAN, updated_at)
 */

class SystemConfigRepository {
  constructor({ db, tokenCrypto = null, logger = console } = {}) {
    if (!db) throw new Error('SystemConfigRepository: db requerido');
    this._db = db;
    this._crypto = tokenCrypto;
    this._logger = logger;
  }

  init() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS system_config (
        key         TEXT PRIMARY KEY,
        value       TEXT,
        is_secret   INTEGER DEFAULT 0,
        updated_at  INTEGER NOT NULL
      );
    `);
  }

  /** Lee un valor plano (no descifra). */
  get(key) {
    const row = this._db.prepare('SELECT value, is_secret FROM system_config WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  /** Escribe un valor plano. */
  set(key, value) {
    this._db.prepare(`
      INSERT INTO system_config (key, value, is_secret, updated_at)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = 0, updated_at = excluded.updated_at
    `).run(key, value, Date.now());
  }

  /** Escribe un secret (cifrado si hay tokenCrypto). */
  setSecret(key, plaintextValue) {
    const encrypted = this._crypto ? this._crypto.encrypt(plaintextValue) : plaintextValue;
    this._db.prepare(`
      INSERT INTO system_config (key, value, is_secret, updated_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = 1, updated_at = excluded.updated_at
    `).run(key, encrypted, Date.now());
  }

  /** Lee un secret (descifra si corresponde). */
  getSecret(key) {
    const row = this._db.prepare('SELECT value, is_secret FROM system_config WHERE key = ?').get(key);
    if (!row) return null;
    if (row.is_secret && this._crypto) {
      try { return this._crypto.decrypt(row.value); }
      catch (err) {
        this._logger.warn(`[SystemConfig] no pude descifrar "${key}": ${err.message}`);
        return null;
      }
    }
    return row.value;
  }

  remove(key) {
    this._db.prepare('DELETE FROM system_config WHERE key = ?').run(key);
  }

  /** Lista todas las keys (sin revelar secrets). */
  listKeys() {
    return this._db.prepare('SELECT key, is_secret, updated_at FROM system_config ORDER BY key').all();
  }

  /**
   * Helper: lee una agrupación de claves prefijadas. ej. listByPrefix('oauth:google:')
   * retorna { 'oauth:google:client_id': '...', ... } (secrets descifrados).
   */
  listByPrefix(prefix) {
    const rows = this._db.prepare('SELECT key, value, is_secret FROM system_config WHERE key LIKE ?').all(prefix + '%');
    const out = {};
    for (const r of rows) {
      if (r.is_secret && this._crypto) {
        try { out[r.key] = this._crypto.decrypt(r.value); }
        catch { out[r.key] = null; }
      } else {
        out[r.key] = r.value;
      }
    }
    return out;
  }
}

module.exports = SystemConfigRepository;
