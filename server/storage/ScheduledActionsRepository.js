'use strict';

const crypto = require('crypto');

/**
 * ScheduledActionsRepository — persistencia de acciones programadas en SQLite.
 *
 * Las acciones apuntan a usuarios (user.id), no a channel-specific IDs.
 * Soporta one-shot (trigger_at) y recurrentes (cron_expr).
 */
class ScheduledActionsRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS scheduled_actions (
      id              TEXT PRIMARY KEY,
      creator_id      TEXT NOT NULL,
      agent_key       TEXT NOT NULL DEFAULT 'claude',
      provider        TEXT,
      model           TEXT,
      action_type     TEXT NOT NULL DEFAULT 'notification',
      label           TEXT NOT NULL,
      payload         TEXT,
      trigger_type    TEXT NOT NULL DEFAULT 'once',
      trigger_at      INTEGER,
      cron_expr       TEXT,
      timezone        TEXT DEFAULT 'America/Argentina/Buenos_Aires',
      target_type     TEXT NOT NULL DEFAULT 'self',
      target_user_ids TEXT,
      status          TEXT NOT NULL DEFAULT 'active',
      next_run_at     INTEGER,
      last_run_at     INTEGER,
      run_count       INTEGER DEFAULT 0,
      max_runs        INTEGER,
      error_msg       TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sa_status_next ON scheduled_actions(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_sa_creator ON scheduled_actions(creator_id);
  `;

  constructor(db) {
    this._db = db || null;
  }

  init() {
    if (!this._db) return;
    this._db.exec(ScheduledActionsRepository.SCHEMA);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  create(action) {
    if (!this._db) return null;
    const now = Date.now();
    const id = crypto.randomUUID();
    const row = {
      id,
      creator_id:      action.creator_id,
      agent_key:       action.agent_key || 'claude',
      provider:        action.provider || null,
      model:           action.model || null,
      action_type:     action.action_type || 'notification',
      label:           action.label,
      payload:         action.payload || null,
      trigger_type:    action.trigger_type || 'once',
      trigger_at:      action.trigger_at || null,
      cron_expr:       action.cron_expr || null,
      timezone:        action.timezone || 'America/Argentina/Buenos_Aires',
      target_type:     action.target_type || 'self',
      target_user_ids: action.target_user_ids || null,
      status:          'active',
      next_run_at:     action.next_run_at || action.trigger_at || null,
      last_run_at:     null,
      run_count:       0,
      max_runs:        action.max_runs ?? (action.trigger_type === 'cron' ? null : 1),
      error_msg:       null,
      created_at:      now,
      updated_at:      now,
    };

    this._db.prepare(`
      INSERT INTO scheduled_actions
        (id, creator_id, agent_key, provider, model, action_type, label, payload,
         trigger_type, trigger_at, cron_expr, timezone, target_type, target_user_ids,
         status, next_run_at, last_run_at, run_count, max_runs, error_msg, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.creator_id, row.agent_key, row.provider, row.model,
      row.action_type, row.label, row.payload,
      row.trigger_type, row.trigger_at, row.cron_expr, row.timezone,
      row.target_type, row.target_user_ids,
      row.status, row.next_run_at, row.last_run_at, row.run_count, row.max_runs,
      row.error_msg, row.created_at, row.updated_at
    );

    return row;
  }

  getById(id) {
    if (!this._db) return null;
    return this._db.prepare('SELECT * FROM scheduled_actions WHERE id = ?').get(id) || null;
  }

  update(id, fields) {
    if (!this._db) return false;
    const allowed = [
      'agent_key', 'provider', 'model', 'action_type', 'label', 'payload',
      'trigger_type', 'trigger_at', 'cron_expr', 'timezone',
      'target_type', 'target_user_ids', 'status', 'next_run_at',
      'last_run_at', 'run_count', 'max_runs', 'error_msg',
    ];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`);
        vals.push(fields[key]);
      }
    }
    if (!sets.length) return false;
    sets.push('updated_at = ?');
    vals.push(Date.now());
    vals.push(id);
    this._db.prepare(`UPDATE scheduled_actions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return true;
  }

  remove(id) {
    if (!this._db) return false;
    const result = this._db.prepare('DELETE FROM scheduled_actions WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ── Queries de scheduling ─────────────────────────────────────────────────

  /**
   * Retorna acciones activas cuyo next_run_at ya pasó.
   */
  getTriggered(nowMs) {
    if (!this._db) return [];
    return this._db.prepare(
      `SELECT * FROM scheduled_actions
       WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at`
    ).all(nowMs);
  }

  /**
   * Lista acciones de un usuario (como creador).
   */
  listByCreator(creatorId) {
    if (!this._db) return [];
    return this._db.prepare(
      `SELECT * FROM scheduled_actions
       WHERE creator_id = ? AND status IN ('active', 'paused')
       ORDER BY created_at DESC`
    ).all(creatorId);
  }

  /**
   * Lista todas las acciones activas.
   */
  listActive() {
    if (!this._db) return [];
    return this._db.prepare(
      `SELECT * FROM scheduled_actions WHERE status = 'active' ORDER BY next_run_at`
    ).all();
  }

  // ── Helpers de estado ─────────────────────────────────────────────────────

  markDone(id) {
    return this.update(id, { status: 'done', last_run_at: Date.now() });
  }

  markFailed(id, errorMsg) {
    return this.update(id, { status: 'failed', error_msg: errorMsg, last_run_at: Date.now() });
  }

  incrementRun(id) {
    if (!this._db) return;
    this._db.prepare(`
      UPDATE scheduled_actions
      SET run_count = run_count + 1, last_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), Date.now(), id);
  }

  updateNextRun(id, nextMs) {
    return this.update(id, { next_run_at: nextMs });
  }
}

module.exports = ScheduledActionsRepository;
