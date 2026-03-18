'use strict';

/**
 * ChatSettingsRepository — persistencia de settings por chat en SQLite.
 * Reemplaza chat-settings.js; recibe la instancia de DB en el constructor
 * en lugar de llamar memory.getDB() internamente.
 */
class ChatSettingsRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS chat_settings (
      bot_key  TEXT NOT NULL,
      chat_id  TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude-code',
      model    TEXT,
      PRIMARY KEY (bot_key, chat_id)
    )
  `;

  constructor(db) {
    this._db = db || null;
  }

  /** Crea la tabla si no existe. Idempotente. */
  init() {
    if (!this._db) return;
    this._db.exec(ChatSettingsRepository.SCHEMA);
  }

  /**
   * @param {string} botKey
   * @param {number|string} chatId
   * @returns {{ provider: string, model: string|null } | null}
   */
  load(botKey, chatId) {
    if (!this._db) return null;
    return this._db.prepare(
      'SELECT provider, model FROM chat_settings WHERE bot_key = ? AND chat_id = ?'
    ).get(String(botKey), String(chatId)) || null;
  }

  /**
   * @param {string} botKey
   * @param {number|string} chatId
   * @param {{ provider: string, model?: string|null }} settings
   */
  save(botKey, chatId, { provider, model }) {
    if (!this._db) return;
    this._db.prepare(`
      INSERT INTO chat_settings (bot_key, chat_id, provider, model)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(bot_key, chat_id) DO UPDATE SET
        provider = excluded.provider,
        model    = excluded.model
    `).run(String(botKey), String(chatId), provider, model ?? null);
  }
}

module.exports = ChatSettingsRepository;
