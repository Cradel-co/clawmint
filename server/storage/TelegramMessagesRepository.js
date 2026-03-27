'use strict';

const MAX_MESSAGES_PER_CHAT = 100;

class TelegramMessagesRepository {
  constructor(db) {
    this._db = db || null;
  }

  /** Crea la tabla e índice. Idempotente. */
  init() {
    if (!this._db) return;
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_messages (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_key   TEXT NOT NULL,
        chat_id   TEXT NOT NULL,
        role      TEXT NOT NULL CHECK(role IN ('user','bot')),
        text      TEXT NOT NULL DEFAULT '',
        ts        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
        tg_msg_id INTEGER
      )
    `);
    try {
      this._db.exec(
        `CREATE INDEX IF NOT EXISTS idx_tgm_chat ON telegram_messages (bot_key, chat_id, id)`
      );
    } catch {}
  }

  /**
   * Inserta un mensaje y aplica FIFO si se excede el límite.
   * @param {string} botKey
   * @param {string} chatId
   * @param {'user'|'bot'} role
   * @param {string} text
   * @param {number|null} tgMsgId
   */
  push(botKey, chatId, role, text, tgMsgId = null) {
    if (!this._db) return;
    this._db.prepare(
      `INSERT INTO telegram_messages (bot_key, chat_id, role, text, tg_msg_id)
       VALUES (?, ?, ?, ?, ?)`
    ).run(String(botKey), String(chatId), role, text || '', tgMsgId ?? null);
    this._trim(botKey, chatId);
  }

  /**
   * Carga los últimos N mensajes del chat, ordenados ASC (más viejos primero).
   * @param {string} botKey
   * @param {string} chatId
   * @param {number} [limit=100]
   * @returns {Array<{ id: number, role: string, text: string, ts: number, tgMsgId: number|null }>}
   */
  load(botKey, chatId, limit = MAX_MESSAGES_PER_CHAT) {
    if (!this._db) return [];
    return this._db.prepare(
      `SELECT id, role, text, ts, tg_msg_id AS tgMsgId
       FROM telegram_messages
       WHERE bot_key = ? AND chat_id = ?
       ORDER BY id DESC LIMIT ?`
    ).all(String(botKey), String(chatId), limit).reverse();
  }

  /**
   * Borra todos los mensajes del chat.
   * @param {string} botKey
   * @param {string} chatId
   */
  clear(botKey, chatId) {
    if (!this._db) return;
    this._db.prepare(
      `DELETE FROM telegram_messages WHERE bot_key = ? AND chat_id = ?`
    ).run(String(botKey), String(chatId));
  }

  /** Recorta mensajes viejos si el chat excede el límite. */
  _trim(botKey, chatId) {
    if (!this._db) return;
    const row = this._db.prepare(
      `SELECT COUNT(*) AS n FROM telegram_messages WHERE bot_key = ? AND chat_id = ?`
    ).get(String(botKey), String(chatId));
    if (row && row.n > MAX_MESSAGES_PER_CHAT) {
      const excess = row.n - MAX_MESSAGES_PER_CHAT;
      this._db.prepare(
        `DELETE FROM telegram_messages WHERE id IN (
           SELECT id FROM telegram_messages
           WHERE bot_key = ? AND chat_id = ?
           ORDER BY id ASC LIMIT ?
         )`
      ).run(String(botKey), String(chatId), excess);
    }
  }
}

module.exports = TelegramMessagesRepository;
