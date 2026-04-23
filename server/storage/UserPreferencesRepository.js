'use strict';

/**
 * UserPreferencesRepository — key-value per-user para keybindings, statusline,
 * y cualquier preference que un cliente (WebChat, SDK) quiera persistir.
 *
 * Schema: user_preferences(user_id, key, value_json, updated_at) con PK compuesta.
 *
 * El repo es agnóstico al contenido de `value` — lo serializa como JSON. El caller
 * decide el shape (keybindings, statusline config, layout, etc.).
 */

class UserPreferencesRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id    TEXT NOT NULL,
      key        TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    );
  `;

  constructor(db) {
    this._db = db || null;
  }

  init() {
    if (!this._db) return;
    this._db.exec(UserPreferencesRepository.SCHEMA);
  }

  /** Get un preference. Retorna el valor deserializado o null. */
  get(user_id, key) {
    if (!this._db || !user_id || !key) return null;
    const row = this._db.prepare('SELECT * FROM user_preferences WHERE user_id = ? AND key = ?').get(user_id, key);
    if (!row) return null;
    try { return JSON.parse(row.value_json); }
    catch { return null; }
  }

  /** Upsert un preference. Value puede ser cualquier JSON-serializable. */
  set(user_id, key, value) {
    if (!this._db) return null;
    if (!user_id) throw new Error('user_id requerido');
    if (!key) throw new Error('key requerido');

    const serialized = JSON.stringify(value);
    const now = Date.now();
    this._db.prepare(`
      INSERT INTO user_preferences (user_id, key, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(user_id, key, serialized, now);
    return value;
  }

  /** Remove un preference específico. */
  remove(user_id, key) {
    if (!this._db) return false;
    const info = this._db.prepare('DELETE FROM user_preferences WHERE user_id = ? AND key = ?').run(user_id, key);
    return info.changes > 0;
  }

  /** Lista todos los preferences de un usuario. */
  listByUser(user_id) {
    if (!this._db) return [];
    return this._db.prepare('SELECT * FROM user_preferences WHERE user_id = ? ORDER BY key').all(user_id)
      .map(r => {
        let value;
        try { value = JSON.parse(r.value_json); } catch { value = null; }
        return { key: r.key, value, updated_at: r.updated_at };
      });
  }
}

module.exports = UserPreferencesRepository;
