'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY  = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 30;

/**
 * AuthService — autenticación con usuario/contraseña + OAuth + JWT.
 *
 * Gestiona registro, login, tokens JWT (access + refresh con rotación),
 * cuentas OAuth y vinculación de sesiones anónimas.
 */
class AuthService {

  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS oauth_accounts (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      provider      TEXT NOT NULL,
      provider_id   TEXT NOT NULL,
      email         TEXT,
      name          TEXT,
      avatar_url    TEXT,
      access_token  TEXT,
      refresh_token TEXT,
      token_expiry  INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(provider, provider_id)
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_accounts(user_id);

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      device     TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked    INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_rt_hash ON refresh_tokens(token_hash);
  `;

  static USERS_MIGRATIONS = [
    `ALTER TABLE users ADD COLUMN email TEXT`,
    `ALTER TABLE users ADD COLUMN password_hash TEXT`,
    `ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN avatar_url TEXT`,
  ];

  constructor({ db, usersRepo, logger }) {
    this._db        = db;
    this._usersRepo = usersRepo;
    this._logger    = logger;
    this._jwtSecret = process.env.JWT_SECRET || null;
  }

  init() {
    if (!this._db) return;

    // Generar secret aleatorio si no hay env var (warn)
    if (!this._jwtSecret) {
      this._jwtSecret = crypto.randomBytes(64).toString('hex');
      this._logger.warn('[AuthService] JWT_SECRET no configurado — usando secret aleatorio (no persistente entre reinicios)');
    }

    // Migrar columnas nuevas en users
    for (const sql of AuthService.USERS_MIGRATIONS) {
      try { this._db.exec(sql); } catch { /* columna ya existe */ }
    }

    // Crear tablas de auth
    this._db.exec(AuthService.SCHEMA);

    // Actualizar UsersRepository.update para aceptar campos nuevos
    this._patchUsersRepo();

    this._logger.info('[AuthService] inicializado OK');
  }

  /**
   * Extiende UsersRepository.update para aceptar email, password_hash, avatar_url, email_verified.
   */
  _patchUsersRepo() {
    const original = this._usersRepo.update.bind(this._usersRepo);
    this._usersRepo.update = (id, fields) => {
      if (!this._usersRepo._db) return false;
      const allowed = ['name', 'role', 'email', 'password_hash', 'email_verified', 'avatar_url'];
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
      this._usersRepo._db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return true;
    };
  }

  // ── Registro ──────────────────────────────────────────────────────────────────

  /**
   * Registra un usuario con email y contraseña.
   * @returns {{ user, accessToken, refreshToken }} o lanza error.
   */
  async register(email, password, name) {
    if (!email || !password) throw new Error('Email y contraseña son requeridos');
    email = email.toLowerCase().trim();

    if (password.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres');
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      throw new Error('La contraseña debe contener al menos una letra y un número');
    }

    // Verificar que el email no esté en uso
    const existing = this._findByEmail(email);
    if (existing) throw new Error('El email ya está registrado');

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = this._usersRepo.create(name || email.split('@')[0], 'user');
    this._usersRepo.update(user.id, { email, password_hash: passwordHash });

    user.email = email;
    const tokens = this._issueTokens(user.id);
    return { user, ...tokens };
  }

  // ── Login ─────────────────────────────────────────────────────────────────────

  /**
   * Login con email y contraseña.
   * @returns {{ user, accessToken, refreshToken }} o lanza error.
   */
  async login(email, password) {
    if (!email || !password) throw new Error('Email y contraseña son requeridos');
    email = email.toLowerCase().trim();

    const user = this._findByEmail(email);
    if (!user) throw new Error('Credenciales inválidas');
    if (!user.password_hash) throw new Error('Esta cuenta no tiene contraseña (usa OAuth)');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new Error('Credenciales inválidas');

    const tokens = this._issueTokens(user.id);
    return { user: this._sanitizeUser(user), ...tokens };
  }

  // ── JWT ───────────────────────────────────────────────────────────────────────

  /**
   * Genera access token + refresh token.
   */
  _issueTokens(userId) {
    const accessToken = jwt.sign(
      { sub: userId },
      this._jwtSecret,
      { expiresIn: ACCESS_TOKEN_EXPIRY }
    );

    const refreshTokenRaw = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(refreshTokenRaw).digest('hex');
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

    this._db.prepare(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, userId, tokenHash, now, expiresAt);

    // Codificar id + raw token juntos para que el cliente solo maneje un string
    const refreshToken = Buffer.from(JSON.stringify({ id, token: refreshTokenRaw })).toString('base64url');

    return { accessToken, refreshToken };
  }

  /**
   * Verifica un access token JWT.
   * @returns {{ sub: string }} payload o null si inválido/expirado.
   */
  verifyAccessToken(token) {
    try {
      return jwt.verify(token, this._jwtSecret);
    } catch {
      return null;
    }
  }

  /**
   * Rota refresh token: revoca el viejo, emite par nuevo.
   * @returns {{ accessToken, refreshToken }} o lanza error.
   */
  refreshTokens(refreshTokenB64) {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(refreshTokenB64, 'base64url').toString());
    } catch {
      throw new Error('Refresh token inválido');
    }

    const { id, token } = parsed;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const row = this._db.prepare(
      'SELECT * FROM refresh_tokens WHERE id = ? AND token_hash = ? AND revoked = 0'
    ).get(id, tokenHash);

    if (!row) throw new Error('Refresh token inválido o revocado');
    if (row.expires_at < Date.now()) {
      this._revokeToken(id);
      throw new Error('Refresh token expirado');
    }

    // Revocar el token usado
    this._revokeToken(id);

    // Emitir nuevo par
    return this._issueTokens(row.user_id);
  }

  _revokeToken(id) {
    this._db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?').run(id);
  }

  /**
   * Revoca todos los refresh tokens de un usuario (logout everywhere).
   */
  revokeAllTokens(userId) {
    this._db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(userId);
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────────

  /**
   * Busca o crea un usuario por cuenta OAuth.
   * @returns {{ user, accessToken, refreshToken, isNew: boolean }}
   */
  findOrCreateByOAuth(provider, profile) {
    const { providerId, email, name, avatarUrl, accessToken: oauthAccessToken, refreshToken: oauthRefreshToken, tokenExpiry } = profile;

    // Buscar cuenta OAuth existente
    const existing = this._db.prepare(
      'SELECT * FROM oauth_accounts WHERE provider = ? AND provider_id = ?'
    ).get(provider, String(providerId));

    if (existing) {
      // Actualizar tokens OAuth
      this._db.prepare(`
        UPDATE oauth_accounts SET access_token = ?, refresh_token = ?, token_expiry = ?, updated_at = ?
        WHERE id = ?
      `).run(oauthAccessToken || null, oauthRefreshToken || null, tokenExpiry || null, Date.now(), existing.id);

      const user = this._usersRepo.getById(existing.user_id);
      const tokens = this._issueTokens(existing.user_id);
      return { user: this._sanitizeUser(user), ...tokens, isNew: false };
    }

    // Buscar usuario por email (para vincular cuentas)
    let user = email ? this._findByEmail(email) : null;
    let isNew = false;

    if (!user) {
      user = this._usersRepo.create(name || email?.split('@')[0] || provider, 'user');
      if (email) this._usersRepo.update(user.id, { email, email_verified: 1 });
      if (avatarUrl) this._usersRepo.update(user.id, { avatar_url: avatarUrl });
      isNew = true;
    }

    // Crear cuenta OAuth
    const oauthId = crypto.randomUUID();
    const now = Date.now();
    this._db.prepare(`
      INSERT INTO oauth_accounts (id, user_id, provider, provider_id, email, name, avatar_url, access_token, refresh_token, token_expiry, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(oauthId, user.id, provider, String(providerId), email || null, name || null,
           avatarUrl || null, oauthAccessToken || null, oauthRefreshToken || null,
           tokenExpiry || null, now, now);

    const tokens = this._issueTokens(user.id);
    return { user: this._sanitizeUser(user), ...tokens, isNew };
  }

  /**
   * Lista las cuentas OAuth de un usuario.
   */
  getOAuthAccounts(userId) {
    return this._db.prepare(
      'SELECT id, provider, provider_id, email, name, avatar_url, created_at FROM oauth_accounts WHERE user_id = ?'
    ).all(userId);
  }

  /**
   * Desvincula una cuenta OAuth.
   */
  unlinkOAuth(userId, provider) {
    const result = this._db.prepare(
      'DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?'
    ).run(userId, provider);
    return result.changes > 0;
  }

  // ── Session linking ───────────────────────────────────────────────────────────

  /**
   * Vincula una sesión anónima (por sessionId) a un usuario autenticado.
   * Transfiere mensajes y configuración.
   */
  linkAnonymousSession(userId, sessionId) {
    if (!userId || !sessionId) return false;

    // Transferir mensajes de webchat
    try {
      this._db.prepare(
        'UPDATE webchat_messages SET session_id = ? WHERE session_id = ?'
      ).run(userId, sessionId);
    } catch { /* tabla puede no existir o no tener mensajes */ }

    // Transferir chat_settings
    try {
      this._db.prepare(
        `UPDATE chat_settings SET chat_id = ? WHERE bot_key = 'web' AND chat_id = ?`
      ).run(userId, sessionId);
    } catch { /* puede no existir */ }

    // Vincular identidad web al usuario autenticado
    this._usersRepo.linkIdentity(userId, 'web', sessionId, 'web');

    // Eliminar usuario anónimo huérfano
    const anonUser = this._usersRepo.findByIdentity('web', sessionId);
    if (anonUser && anonUser.id !== userId) {
      const identities = this._usersRepo.getIdentities(anonUser.id);
      if (identities.length === 0) {
        this._usersRepo.remove(anonUser.id);
      }
    }

    return true;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  _findByEmail(email) {
    if (!this._db) return null;
    return this._db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim()) || null;
  }

  /**
   * Obtiene un usuario por ID (con campos auth incluidos).
   */
  getUserById(id) {
    const user = this._usersRepo.getById(id);
    if (!user) return null;
    // Agregar campos auth
    const authFields = this._db.prepare('SELECT email, email_verified, avatar_url FROM users WHERE id = ?').get(id);
    return { ...user, ...authFields };
  }

  _sanitizeUser(user) {
    if (!user) return null;
    const { password_hash, ...safe } = user;
    return safe;
  }

  /**
   * Cambia la contraseña de un usuario.
   */
  async changePassword(userId, currentPassword, newPassword) {
    const user = this._db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('Usuario no encontrado');

    if (user.password_hash) {
      if (!currentPassword) throw new Error('Contraseña actual requerida');
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) throw new Error('Contraseña actual incorrecta');
    }

    if (newPassword.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres');
    if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      throw new Error('La contraseña debe contener al menos una letra y un número');
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    this._usersRepo.update(userId, { password_hash: hash });

    // Revocar todos los refresh tokens (forzar re-login)
    this.revokeAllTokens(userId);

    return true;
  }

  /**
   * Limpia refresh tokens expirados o revocados (mantenimiento).
   */
  cleanupExpiredTokens() {
    const cutoff = Date.now();
    const result = this._db.prepare(
      'DELETE FROM refresh_tokens WHERE revoked = 1 OR expires_at < ?'
    ).run(cutoff);
    return result.changes;
  }
}

module.exports = AuthService;
