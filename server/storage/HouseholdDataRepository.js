'use strict';

const crypto = require('crypto');

/**
 * HouseholdDataRepository — datos compartidos del hogar (Fase B).
 *
 * Tabla flexible que soporta múltiples tipos de datos familiares:
 *   - grocery_item   → mercadería pendiente
 *   - family_event   → cumpleaños, vencimientos, citas (con date_at + alert_days_before)
 *   - house_note     → recados / info estable del hogar
 *   - service        → vencimientos servicios (gas, luz, internet) con monto
 *   - inventory      → items de heladera/despensa con cantidad
 *
 * Schema:
 *   household_data(
 *     id            PK uuid
 *     kind          tipo (uno de los listados arriba)
 *     title         título legible
 *     data_json     payload JSON variable según kind
 *     date_at       timestamp ms (NULL si no aplica) — usado para events/services
 *     alert_days_before INTEGER NULL — para events/services
 *     completed_at  timestamp ms (NULL = pendiente; usado en grocery/inventory)
 *     created_by    user_id
 *     updated_by    user_id (último que tocó)
 *     created_at, updated_at INTEGER
 *   )
 *
 * Permisos: cualquier user con status='active' puede leer/escribir.
 *           validación se hace en route/tool, no en el repo.
 */
class HouseholdDataRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS household_data (
      id                  TEXT PRIMARY KEY,
      kind                TEXT NOT NULL,
      title               TEXT NOT NULL,
      data_json           TEXT,
      date_at             INTEGER,
      alert_days_before   INTEGER,
      completed_at        INTEGER,
      created_by          TEXT NOT NULL,
      updated_by          TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_household_kind ON household_data(kind);
    CREATE INDEX IF NOT EXISTS idx_household_date ON household_data(date_at);
    CREATE INDEX IF NOT EXISTS idx_household_completed ON household_data(completed_at);
  `;

  constructor(db) { this._db = db || null; }

  init() {
    if (!this._db) return;
    this._db.exec(HouseholdDataRepository.SCHEMA);
  }

  /** Crea un item del hogar. */
  create({ kind, title, data, dateAt, alertDaysBefore, createdBy }) {
    if (!this._db || !kind || !title || !createdBy) return null;
    const id = crypto.randomUUID();
    const now = Date.now();
    this._db.prepare(`
      INSERT INTO household_data (id, kind, title, data_json, date_at, alert_days_before, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, kind, title, data ? JSON.stringify(data) : null, dateAt || null, alertDaysBefore || null, createdBy, createdBy, now, now);
    return this.get(id);
  }

  get(id) {
    if (!this._db) return null;
    const row = this._db.prepare('SELECT * FROM household_data WHERE id = ?').get(id);
    return row ? this._hydrate(row) : null;
  }

  /** Update parcial. Acepta cualquier subset de campos. */
  update(id, fields, updatedBy) {
    if (!this._db) return false;
    const allowed = ['title', 'date_at', 'alert_days_before', 'completed_at'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
    }
    if (fields.data !== undefined) {
      sets.push('data_json = ?');
      vals.push(fields.data ? JSON.stringify(fields.data) : null);
    }
    if (!sets.length) return false;
    sets.push('updated_by = ?', 'updated_at = ?');
    vals.push(updatedBy || null, Date.now(), id);
    const r = this._db.prepare(`UPDATE household_data SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return r.changes > 0;
  }

  /** Marca completed_at = now (toggle). */
  complete(id, updatedBy) {
    return this.update(id, { completed_at: Date.now() }, updatedBy);
  }

  uncomplete(id, updatedBy) {
    return this.update(id, { completed_at: null }, updatedBy);
  }

  remove(id) {
    if (!this._db) return false;
    const r = this._db.prepare('DELETE FROM household_data WHERE id = ?').run(id);
    return r.changes > 0;
  }

  /**
   * Lista por kind con filtros opcionales:
   *   - includeCompleted (default false para grocery/inventory; true para event/note/service)
   *   - upcomingOnly (solo items con date_at >= now; útil para events)
   *   - limit
   */
  list(kind, opts = {}) {
    if (!this._db) return [];
    const { includeCompleted = false, upcomingOnly = false, limit = null } = opts;
    let where = 'kind = ?';
    const params = [kind];
    if (!includeCompleted) where += ' AND completed_at IS NULL';
    if (upcomingOnly) { where += ' AND (date_at IS NULL OR date_at >= ?)'; params.push(Date.now()); }
    const orderBy = 'COALESCE(date_at, created_at) ASC';
    const limitClause = limit ? ` LIMIT ${Number(limit)}` : '';
    const rows = this._db.prepare(`SELECT * FROM household_data WHERE ${where} ORDER BY ${orderBy}${limitClause}`).all(...params);
    return rows.map(this._hydrate.bind(this));
  }

  /** Próximos eventos en N días con alerta activa. Útil para scheduler. */
  upcomingAlerts(daysWindow = 7) {
    if (!this._db) return [];
    const now = Date.now();
    const horizon = now + daysWindow * 86400000;
    const rows = this._db.prepare(`
      SELECT * FROM household_data
      WHERE date_at IS NOT NULL
        AND date_at <= ?
        AND date_at >= ?
        AND completed_at IS NULL
      ORDER BY date_at ASC
    `).all(horizon, now);
    return rows.map(this._hydrate.bind(this));
  }

  /** Counts por kind para dashboard. */
  counts() {
    if (!this._db) return {};
    const rows = this._db.prepare(`
      SELECT kind, COUNT(*) AS total,
             SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS pending
      FROM household_data
      GROUP BY kind
    `).all();
    const out = {};
    for (const r of rows) out[r.kind] = { total: Number(r.total), pending: Number(r.pending) };
    return out;
  }

  _hydrate(row) {
    if (!row) return null;
    let data = null;
    if (row.data_json) try { data = JSON.parse(row.data_json); } catch { data = row.data_json; }
    return {
      id: row.id, kind: row.kind, title: row.title, data,
      date_at: row.date_at, alert_days_before: row.alert_days_before,
      completed_at: row.completed_at,
      created_by: row.created_by, updated_by: row.updated_by,
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }
}

module.exports = HouseholdDataRepository;
