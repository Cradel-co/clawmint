'use strict';

const crypto = require('crypto');

/**
 * UsersRepository — sistema de usuarios unificado cross-channel.
 *
 * Dos tablas: `users` (identidad central) y `user_identities` (canales vinculados).
 * Un usuario puede tener identidades en Telegram, WebChat, P2P, mobile, etc.
 */
class UsersRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'user',
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_identities (
      user_id    TEXT NOT NULL,
      channel    TEXT NOT NULL,
      identifier TEXT NOT NULL,
      bot_key    TEXT,
      metadata   TEXT,
      linked_at  INTEGER NOT NULL,
      PRIMARY KEY (channel, identifier),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ui_user ON user_identities(user_id);
  `;

  constructor(db) {
    this._db = db || null;
  }

  init() {
    if (!this._db) return;
    this._db.exec(UsersRepository.SCHEMA);
    // Migración idempotente: agregar columna `status` a DBs existentes y marcar
    // todos los usuarios pre-existentes como 'active' (no se les pide aprobar).
    try { this._db.exec(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`); } catch { /* ya existe */ }
    try { this._db.exec(`UPDATE users SET status='active' WHERE status IS NULL OR status=''`); } catch { /* sin filas */ }
    // Una vez: si hay users pre-existentes y NINGUNO marcado como active, asumir migración
    // (todos los pre-existentes son legacy → activos).
    try {
      const total = this._db.prepare('SELECT COUNT(*) AS c FROM users').get();
      const active = this._db.prepare("SELECT COUNT(*) AS c FROM users WHERE status='active'").get();
      if (total && total.c > 0 && active && active.c === 0) {
        this._db.exec("UPDATE users SET status='active'");
      }
    } catch { /* noop */ }
    this._initContacts();
  }

  // ── CRUD usuarios ─────────────────────────────────────────────────────────

  /**
   * Crea un usuario con role + status indicados.
   * Los signatures aceptados:
   *   create(name)
   *   create(name, role)
   *   create(name, role, status)
   *   create(name, { role, status })
   */
  create(name, roleOrOpts = 'user', statusArg = 'pending') {
    if (!this._db) return null;
    const role   = typeof roleOrOpts === 'object' ? (roleOrOpts.role || 'user') : roleOrOpts;
    const status = typeof roleOrOpts === 'object' ? (roleOrOpts.status || 'pending') : statusArg;
    const now = Date.now();
    const id = crypto.randomUUID();
    this._db.prepare(`
      INSERT INTO users (id, name, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, role, status, now, now);
    return { id, name, role, status, created_at: now, updated_at: now };
  }

  getById(id) {
    if (!this._db) return null;
    const user = this._db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return null;
    user.identities = this.getIdentities(id);
    return user;
  }

  update(id, fields) {
    if (!this._db) return false;
    const allowed = ['name', 'role', 'status'];
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
    this._db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return true;
  }

  remove(id) {
    if (!this._db) return false;
    // Eliminar datos relacionados (sql.js no soporta FK CASCADE automático)
    this._db.prepare('DELETE FROM user_identities WHERE user_id = ?').run(id);
    this._db.prepare('DELETE FROM contacts WHERE owner_id = ?').run(id);
    try { this._db.prepare('DELETE FROM scheduled_actions WHERE creator_id = ?').run(id); } catch { /* tabla puede no existir */ }
    try { this._db.prepare('DELETE FROM pending_deliveries WHERE user_id = ?').run(id); } catch { /* tabla puede no existir */ }
    const result = this._db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** Cuenta total de usuarios. Usado por /api/auth/status para detectar first-run. */
  count() {
    if (!this._db) return 0;
    try {
      const row = this._db.prepare('SELECT COUNT(*) AS c FROM users').get();
      return row ? Number(row.c) : 0;
    } catch { return 0; }
  }

  /** Cuenta usuarios por status (active/pending/disabled). */
  countByStatus(status) {
    if (!this._db) return 0;
    try {
      const row = this._db.prepare('SELECT COUNT(*) AS c FROM users WHERE status = ?').get(status);
      return row ? Number(row.c) : 0;
    } catch { return 0; }
  }

  /** Cuenta usuarios por role (user/admin). Usado para evitar quedarse sin admins. */
  countByRole(role) {
    if (!this._db) return 0;
    try {
      const row = this._db.prepare('SELECT COUNT(*) AS c FROM users WHERE role = ?').get(role);
      return row ? Number(row.c) : 0;
    } catch { return 0; }
  }

  /** Cambia el status de un user. Retorna true si modificó alguna fila. */
  setStatus(id, status) {
    if (!this._db) return false;
    if (!['active', 'pending', 'disabled'].includes(status)) {
      throw new Error(`status inválido: ${status}`);
    }
    const result = this._db.prepare(
      'UPDATE users SET status = ?, updated_at = ? WHERE id = ?'
    ).run(status, Date.now(), id);
    return result.changes > 0;
  }

  /** Lista usuarios filtrados por status. */
  listByStatus(status) {
    if (!this._db) return [];
    const users = this._db.prepare('SELECT * FROM users WHERE status = ? ORDER BY name').all(status);
    for (const u of users) u.identities = this.getIdentities(u.id);
    return users;
  }

  listAll() {
    if (!this._db) return [];
    const users = this._db.prepare('SELECT * FROM users ORDER BY name').all();
    for (const u of users) {
      u.identities = this.getIdentities(u.id);
    }
    return users;
  }

  // ── Identidades ───────────────────────────────────────────────────────────

  findByIdentity(channel, identifier) {
    if (!this._db) return null;
    const row = this._db.prepare(`
      SELECT u.*, ui.channel AS id_channel, ui.identifier AS id_identifier, ui.bot_key AS id_bot_key
      FROM user_identities ui
      JOIN users u ON u.id = ui.user_id
      WHERE ui.channel = ? AND ui.identifier = ?
    `).get(channel, String(identifier));
    if (!row) return null;
    const user = { id: row.id, name: row.name, role: row.role, status: row.status, created_at: row.created_at, updated_at: row.updated_at };
    user.identities = this.getIdentities(user.id);
    return user;
  }

  /**
   * Busca un usuario de Telegram por su username (@handle).
   * El username está guardado en el campo metadata JSON de user_identities.
   */
  findByTelegramUsername(username) {
    if (!this._db || !username) return null;
    const clean = username.replace(/^@/, '').toLowerCase();
    const rows = this._db.prepare(`
      SELECT u.*, ui.metadata
      FROM user_identities ui
      JOIN users u ON u.id = ui.user_id
      WHERE ui.channel = 'telegram' AND ui.metadata IS NOT NULL
    `).all();
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.metadata);
        if (meta.username && meta.username.toLowerCase() === clean) {
          const user = { id: row.id, name: row.name, role: row.role, status: row.status, created_at: row.created_at, updated_at: row.updated_at };
          user.identities = this.getIdentities(user.id);
          return user;
        }
      } catch { /* metadata no es JSON válido */ }
    }
    return null;
  }

  /**
   * Busca un usuario por identidad; si no existe, crea usuario + identidad.
   * Idempotente: si ya existe la identidad, retorna el usuario sin modificar.
   */
  getOrCreate(channel, identifier, name, botKey = null, metadata = null) {
    if (!this._db) return null;
    const existing = this.findByIdentity(channel, String(identifier));
    if (existing) return existing;

    const user = this.create(name || `${channel}:${identifier}`);
    this.linkIdentity(user.id, channel, String(identifier), botKey, metadata);
    user.identities = this.getIdentities(user.id);
    return user;
  }

  linkIdentity(userId, channel, identifier, botKey = null, metadata = null) {
    if (!this._db) return false;
    const metaStr = metadata ? JSON.stringify(metadata) : null;
    try {
      this._db.prepare(`
        INSERT INTO user_identities (user_id, channel, identifier, bot_key, metadata, linked_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel, identifier) DO UPDATE SET
          user_id = excluded.user_id,
          bot_key = excluded.bot_key,
          metadata = excluded.metadata,
          linked_at = excluded.linked_at
      `).run(userId, channel, String(identifier), botKey, metaStr, Date.now());
      return true;
    } catch {
      return false;
    }
  }

  unlinkIdentity(userId, channel, identifier) {
    if (!this._db) return false;
    const result = this._db.prepare(
      'DELETE FROM user_identities WHERE user_id = ? AND channel = ? AND identifier = ?'
    ).run(userId, channel, String(identifier));
    return result.changes > 0;
  }

  getIdentities(userId) {
    if (!this._db) return [];
    return this._db.prepare(
      'SELECT channel, identifier, bot_key, metadata, linked_at FROM user_identities WHERE user_id = ? ORDER BY linked_at'
    ).all(userId).map(row => {
      if (row.metadata) try { row.metadata = JSON.parse(row.metadata); } catch { /* keep string */ }
      return row;
    });
  }

  /**
   * Busca usuarios por nombre (parcial, case-insensitive).
   */
  searchByName(query) {
    if (!this._db || !query) return [];
    const users = this._db.prepare(
      'SELECT * FROM users WHERE name LIKE ? ORDER BY name'
    ).all(`%${query}%`);
    for (const u of users) {
      u.identities = this.getIdentities(u.id);
    }
    return users;
  }

  // ── Contactos (agenda) ──────────────────────────────────────────────────

  static CONTACTS_SCHEMA = `
    CREATE TABLE IF NOT EXISTS contacts (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL,
      name        TEXT NOT NULL,
      phone       TEXT,
      email       TEXT,
      notes       TEXT,
      is_favorite INTEGER DEFAULT 0,
      user_id     TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
  `;

  _initContacts() {
    if (!this._db) return;
    this._db.exec(UsersRepository.CONTACTS_SCHEMA);
  }

  createContact(ownerId, { name, phone, email, notes, userId, isFavorite } = {}) {
    if (!this._db || !name) return null;
    const now = Date.now();
    const id = crypto.randomUUID();
    this._db.prepare(`
      INSERT INTO contacts (id, owner_id, name, phone, email, notes, is_favorite, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, ownerId, name, phone || null, email || null, notes || null,
           isFavorite ? 1 : 0, userId || null, now, now);
    return { id, owner_id: ownerId, name, phone, email, notes, is_favorite: isFavorite ? 1 : 0, user_id: userId || null, created_at: now, updated_at: now };
  }

  getContact(id) {
    if (!this._db) return null;
    return this._db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) || null;
  }

  updateContact(id, fields) {
    if (!this._db) return false;
    const allowed = ['name', 'phone', 'email', 'notes', 'is_favorite', 'user_id'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`);
        vals.push(key === 'is_favorite' ? (fields[key] ? 1 : 0) : fields[key]);
      }
    }
    if (!sets.length) return false;
    sets.push('updated_at = ?');
    vals.push(Date.now());
    vals.push(id);
    this._db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return true;
  }

  removeContact(id) {
    if (!this._db) return false;
    const result = this._db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listContacts(ownerId, { favoritesOnly } = {}) {
    if (!this._db) return [];
    const sql = favoritesOnly
      ? 'SELECT * FROM contacts WHERE owner_id = ? AND is_favorite = 1 ORDER BY name'
      : 'SELECT * FROM contacts WHERE owner_id = ? ORDER BY name';
    return this._db.prepare(sql).all(ownerId);
  }

  searchContacts(ownerId, query) {
    if (!this._db || !query) return [];
    return this._db.prepare(
      'SELECT * FROM contacts WHERE owner_id = ? AND name LIKE ? ORDER BY name'
    ).all(ownerId, `%${query}%`);
  }

  findContactByUserId(ownerId, userId) {
    if (!this._db) return null;
    return this._db.prepare(
      'SELECT * FROM contacts WHERE owner_id = ? AND user_id = ?'
    ).get(ownerId, userId) || null;
  }
}

module.exports = UsersRepository;
