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
      cwd      TEXT,
      PRIMARY KEY (bot_key, chat_id)
    )
  `;

  static MIGRATIONS = [
    `ALTER TABLE chat_settings ADD COLUMN cwd TEXT`,
    `ALTER TABLE chat_settings ADD COLUMN claude_session_id TEXT`,
    `ALTER TABLE chat_settings ADD COLUMN message_count INTEGER DEFAULT 0`,
    `ALTER TABLE chat_settings ADD COLUMN claude_mode TEXT DEFAULT 'ask'`,
  ];

  constructor(db) {
    this._db = db || null;
  }

  /** Crea la tabla si no existe y aplica migraciones. Idempotente. */
  init() {
    if (!this._db) return;
    this._db.exec(ChatSettingsRepository.SCHEMA);
    for (const sql of ChatSettingsRepository.MIGRATIONS) {
      try { this._db.exec(sql); } catch {}
    }
  }

  /**
   * @param {string} botKey
   * @param {number|string} chatId
   * @returns {{ provider: string, model: string|null, cwd: string|null } | null}
   */
  load(botKey, chatId) {
    if (!this._db) return null;
    return this._db.prepare(
      'SELECT provider, model, cwd, claude_session_id, message_count, claude_mode FROM chat_settings WHERE bot_key = ? AND chat_id = ?'
    ).get(String(botKey), String(chatId)) || null;
  }

  /**
   * @param {string} botKey
   * @param {number|string} chatId
   * @param {{ provider: string, model?: string|null, cwd?: string|null }} settings
   */
  save(botKey, chatId, { provider, model, cwd }) {
    if (!this._db) return;
    this._db.prepare(`
      INSERT INTO chat_settings (bot_key, chat_id, provider, model, cwd)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(bot_key, chat_id) DO UPDATE SET
        provider = excluded.provider,
        model    = excluded.model,
        cwd      = excluded.cwd
    `).run(String(botKey), String(chatId), provider, model ?? null, cwd ?? null);
  }

  /**
   * Persiste solo el cwd sin tocar provider/model.
   */
  saveCwd(botKey, chatId, cwd) {
    if (!this._db) return;
    this._db.prepare(`
      INSERT INTO chat_settings (bot_key, chat_id, provider, cwd)
      VALUES (?, ?, 'claude-code', ?)
      ON CONFLICT(bot_key, chat_id) DO UPDATE SET cwd = excluded.cwd
    `).run(String(botKey), String(chatId), cwd);
  }

  /**
   * Persiste el estado de la sesión de Claude (session_id + message_count + cwd).
   */
  saveSession(botKey, chatId, { claudeSessionId, messageCount, cwd }) {
    if (!this._db) return;
    this._db.prepare(`
      INSERT INTO chat_settings (bot_key, chat_id, provider, claude_session_id, message_count, cwd)
      VALUES (?, ?, 'claude-code', ?, ?, ?)
      ON CONFLICT(bot_key, chat_id) DO UPDATE SET
        claude_session_id = excluded.claude_session_id,
        message_count     = excluded.message_count,
        cwd               = excluded.cwd
    `).run(String(botKey), String(chatId), claudeSessionId ?? null, messageCount ?? 0, cwd ?? null);
  }

  /**
   * Persiste el modo de permisos de Claude (ask/auto/plan).
   */
  saveMode(botKey, chatId, mode) {
    if (!this._db) return;
    this._db.prepare(`
      INSERT INTO chat_settings (bot_key, chat_id, provider, claude_mode)
      VALUES (?, ?, 'claude-code', ?)
      ON CONFLICT(bot_key, chat_id) DO UPDATE SET claude_mode = excluded.claude_mode
    `).run(String(botKey), String(chatId), mode);
  }

  /**
   * Limpia la sesión de Claude (al hacer /new o reset).
   */
  clearSession(botKey, chatId) {
    if (!this._db) return;
    this._db.prepare(`
      UPDATE chat_settings SET claude_session_id = NULL, message_count = 0
      WHERE bot_key = ? AND chat_id = ?
    `).run(String(botKey), String(chatId));
  }
}

module.exports = ChatSettingsRepository;
