'use strict';

/**
 * ResumableSessionsRepository — sesiones pausadas que se re-abren en el futuro.
 *
 * Usado por la tool `schedule_wakeup`: serializa el history del chat y
 * programa que el scheduler dispare una continuación con un prompt custom.
 *
 * Schema:
 *   resumable_sessions(
 *     id PK, chat_id, agent_key, provider, model,
 *     history_json, context_json, resume_prompt,
 *     created_at, trigger_at, status CHECK IN ('pending','fired','cancelled')
 *   )
 *
 * Fase 4 extra.
 */

class ResumableSessionsRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS resumable_sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id       TEXT NOT NULL,
      agent_key     TEXT,
      provider      TEXT,
      model         TEXT,
      channel       TEXT,
      history_json  TEXT NOT NULL DEFAULT '[]',
      context_json  TEXT NOT NULL DEFAULT '{}',
      resume_prompt TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      trigger_at    INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','fired','cancelled'))
    );
    CREATE INDEX IF NOT EXISTS idx_resumable_trigger ON resumable_sessions(trigger_at, status);
    CREATE INDEX IF NOT EXISTS idx_resumable_chat ON resumable_sessions(chat_id, status);
  `;

  constructor(db) {
    this._db = db || null;
  }

  init() {
    if (!this._db) return;
    this._db.exec(ResumableSessionsRepository.SCHEMA);
  }

  /**
   * @param {object} args
   * @param {string} args.chat_id
   * @param {string} [args.agent_key]
   * @param {string} [args.provider]
   * @param {string} [args.model]
   * @param {string} [args.channel]
   * @param {Array}  args.history
   * @param {object} [args.context]
   * @param {string} args.resume_prompt
   * @param {number} args.trigger_at  — epoch ms
   */
  create({ chat_id, agent_key, provider, model, channel, history, context, resume_prompt, trigger_at }) {
    if (!this._db) return null;
    if (!chat_id) throw new Error('chat_id requerido');
    if (!resume_prompt) throw new Error('resume_prompt requerido');
    if (!trigger_at) throw new Error('trigger_at requerido');

    const now = Date.now();
    const hist = JSON.stringify(history || []);
    const ctx  = JSON.stringify(context || {});

    this._db.prepare(`
      INSERT INTO resumable_sessions (chat_id, agent_key, provider, model, channel, history_json, context_json, resume_prompt, created_at, trigger_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(chat_id, agent_key || null, provider || null, model || null, channel || null, hist, ctx, resume_prompt, now, trigger_at);

    const row = this._db.prepare('SELECT last_insert_rowid() AS id').get();
    return this.getById(row.id);
  }

  getById(id) {
    if (!this._db) return null;
    const row = this._db.prepare('SELECT * FROM resumable_sessions WHERE id = ?').get(id);
    return row ? this._hydrate(row) : null;
  }

  /** Lista pending con trigger_at <= now. Usado por scheduler. */
  listReady(nowMs = Date.now()) {
    if (!this._db) return [];
    return this._db.prepare(`
      SELECT * FROM resumable_sessions
      WHERE status = 'pending' AND trigger_at <= ?
      ORDER BY trigger_at ASC
    `).all(nowMs).map(r => this._hydrate(r));
  }

  listByChatId(chat_id) {
    if (!this._db) return [];
    return this._db.prepare('SELECT * FROM resumable_sessions WHERE chat_id = ? ORDER BY trigger_at ASC').all(chat_id).map(r => this._hydrate(r));
  }

  markFired(id) {
    if (!this._db) return false;
    const info = this._db.prepare(`UPDATE resumable_sessions SET status='fired' WHERE id = ? AND status='pending'`).run(id);
    return info.changes > 0;
  }

  cancel(id) {
    if (!this._db) return false;
    const info = this._db.prepare(`UPDATE resumable_sessions SET status='cancelled' WHERE id = ? AND status='pending'`).run(id);
    return info.changes > 0;
  }

  remove(id) {
    if (!this._db) return false;
    const info = this._db.prepare('DELETE FROM resumable_sessions WHERE id = ?').run(id);
    return info.changes > 0;
  }

  _hydrate(row) {
    let history = [], context = {};
    try { history = JSON.parse(row.history_json); } catch {}
    try { context = JSON.parse(row.context_json); } catch {}
    return {
      id: row.id,
      chat_id: row.chat_id,
      agent_key: row.agent_key,
      provider: row.provider,
      model: row.model,
      channel: row.channel,
      history,
      context,
      resume_prompt: row.resume_prompt,
      created_at: row.created_at,
      trigger_at: row.trigger_at,
      status: row.status,
    };
  }
}

module.exports = ResumableSessionsRepository;
