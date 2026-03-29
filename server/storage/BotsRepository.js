'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * BotsRepository — persistencia de bots de Telegram en SQLite.
 *
 * Tabla: bots (key PK, owner_id, token, config, offset).
 * Ownership: cada bot pertenece a un usuario; las queries filtran por owner_id.
 * En init() migra automáticamente desde bots.json si existe.
 */
class BotsRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS bots (
      key              TEXT PRIMARY KEY,
      owner_id         TEXT,
      token            TEXT NOT NULL,
      default_agent    TEXT DEFAULT 'claude',
      whitelist        TEXT DEFAULT '[]',
      group_whitelist  TEXT DEFAULT '[]',
      rate_limit       INTEGER DEFAULT 30,
      rate_limit_keyword TEXT DEFAULT '',
      start_greeting   INTEGER DEFAULT 0,
      last_greeting_at INTEGER DEFAULT 0,
      "offset"         INTEGER DEFAULT 0
    )
  `;

  static MIGRATIONS = [
    'ALTER TABLE bots ADD COLUMN owner_id TEXT',
  ];

  constructor(db, jsonPath) {
    this._db = db;
    this._jsonPath = jsonPath || path.join(__dirname, '..', 'bots.json');
  }

  init() {
    if (!this._db) return;
    this._db.exec(BotsRepository.SCHEMA);
    for (const sql of BotsRepository.MIGRATIONS) {
      try { this._db.exec(sql); } catch {}
    }
    this._migrateFromJson();
  }

  // ── Migración desde bots.json ─────────────────────────────────────────────

  _migrateFromJson() {
    if (!fs.existsSync(this._jsonPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this._jsonPath, 'utf8')) || [];
      if (!data.length) return;

      const existing = this._db.prepare('SELECT COUNT(*) as c FROM bots').get();
      if (existing.c > 0) {
        const backupPath = this._jsonPath + '.migrated';
        fs.renameSync(this._jsonPath, backupPath);
        console.log(`[BotsRepo] bots.json renombrado a bots.json.migrated (SQLite ya tiene ${existing.c} bots)`);
        return;
      }

      const stmt = this._db.prepare(`
        INSERT OR IGNORE INTO bots (key, owner_id, token, default_agent, whitelist, group_whitelist,
          rate_limit, rate_limit_keyword, start_greeting, last_greeting_at, "offset")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const bot of data) {
        stmt.run(
          bot.key,
          bot.ownerId || null,
          bot.token,
          bot.defaultAgent || 'claude',
          JSON.stringify(bot.whitelist || []),
          JSON.stringify(bot.groupWhitelist || []),
          bot.rateLimit || 30,
          bot.rateLimitKeyword || '',
          bot.startGreeting ? 1 : 0,
          bot.lastGreetingAt || 0,
          bot.offset || 0,
        );
      }

      const backupPath = this._jsonPath + '.migrated';
      fs.renameSync(this._jsonPath, backupPath);
      console.log(`[BotsRepo] Migrados ${data.length} bots de bots.json → SQLite (backup: bots.json.migrated)`);
    } catch (err) {
      console.error('[BotsRepo] Error migrando bots.json:', err.message);
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Lee todos los bots (sin filtrar por owner — usado en loadAndStart).
   * Si no hay datos y hay BOT_TOKEN en env, crea el bot inicial.
   * @returns {object[]}
   */
  read() {
    if (!this._db) return [];
    const rows = this._db.prepare('SELECT * FROM bots').all();

    if (rows.length === 0) {
      const token = process.env.BOT_TOKEN;
      if (!token) return [];

      const whitelist = (process.env.BOT_WHITELIST || '')
        .split(',').map(s => s.trim()).filter(Boolean).map(Number);
      const groupWhitelist = (process.env.BOT_GROUP_WHITELIST || '')
        .split(',').map(s => s.trim()).filter(Boolean).map(Number);

      const entry = {
        key:              process.env.BOT_KEY               || 'dev',
        token,
        defaultAgent:     process.env.BOT_DEFAULT_AGENT      || 'claude',
        whitelist,
        groupWhitelist,
        rateLimit:        parseInt(process.env.BOT_RATE_LIMIT) || 30,
        rateLimitKeyword: process.env.BOT_RATE_LIMIT_KEYWORD  || '',
        offset:           0,
        ownerId:          null,
      };
      this._upsertBot(entry);
      console.log(`[BotsRepo] Bot creado desde variables de entorno (key: ${entry.key})`);
      return [entry];
    }

    return rows.map(r => this._rowToBot(r));
  }

  /**
   * Lee bots de un usuario específico.
   * @param {string} ownerId
   * @returns {object[]}
   */
  readByOwner(ownerId) {
    if (!this._db) return [];
    const rows = this._db.prepare('SELECT * FROM bots WHERE owner_id = ?').all(ownerId);
    return rows.map(r => this._rowToBot(r));
  }

  /**
   * Guarda la lista completa de bots (sync con memoria).
   * Upsert cada bot y elimina los que ya no existen.
   * @param {object[]} bots
   */
  save(bots) {
    if (!this._db) return;
    for (const bot of bots) {
      this._upsertBot(bot);
    }
  }

  /**
   * Inserta o actualiza un bot individual.
   * Preserva owner_id existente si el nuevo dato no lo trae.
   * @param {object} bot
   */
  _upsertBot(bot) {
    const ownerId = bot.ownerId || null;
    // Si no viene ownerId, preservar el existente en la DB
    const existing = this._db.prepare('SELECT owner_id FROM bots WHERE key = ?').get(bot.key);
    const finalOwnerId = ownerId || existing?.owner_id || null;

    this._db.prepare(`
      INSERT OR REPLACE INTO bots (key, owner_id, token, default_agent, whitelist, group_whitelist,
        rate_limit, rate_limit_keyword, start_greeting, last_greeting_at, "offset")
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bot.key,
      finalOwnerId,
      bot.token,
      bot.defaultAgent || 'claude',
      JSON.stringify(bot.whitelist || []),
      JSON.stringify(bot.groupWhitelist || []),
      bot.rateLimit || 30,
      bot.rateLimitKeyword || '',
      bot.startGreeting ? 1 : 0,
      bot.lastGreetingAt || 0,
      bot.offset || 0,
    );
  }

  /**
   * Obtiene un bot por key.
   * @param {string} key
   * @returns {object|null}
   */
  getByKey(key) {
    if (!this._db) return null;
    const row = this._db.prepare('SELECT * FROM bots WHERE key = ?').get(key);
    return row ? this._rowToBot(row) : null;
  }

  /**
   * Obtiene un bot por key verificando ownership.
   * @param {string} key
   * @param {string} ownerId
   * @returns {object|null}
   */
  getByKeyAndOwner(key, ownerId) {
    if (!this._db) return null;
    const row = this._db.prepare('SELECT * FROM bots WHERE key = ? AND owner_id = ?').get(key, ownerId);
    return row ? this._rowToBot(row) : null;
  }

  /**
   * Actualiza el offset de un bot (llamada frecuente desde polling).
   * @param {string} key
   * @param {number} offset
   */
  updateOffset(key, offset) {
    if (!this._db) return;
    this._db.prepare('UPDATE bots SET "offset" = ? WHERE key = ?').run(offset, key);
  }

  /**
   * Elimina un bot por key.
   * @param {string} key
   * @returns {boolean}
   */
  remove(key) {
    if (!this._db) return false;
    const result = this._db.prepare('DELETE FROM bots WHERE key = ?').run(key);
    return result.changes > 0;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _rowToBot(r) {
    return {
      key:              r.key,
      ownerId:          r.owner_id || null,
      token:            r.token,
      defaultAgent:     r.default_agent,
      whitelist:        JSON.parse(r.whitelist || '[]'),
      groupWhitelist:   JSON.parse(r.group_whitelist || '[]'),
      rateLimit:        r.rate_limit,
      rateLimitKeyword: r.rate_limit_keyword || '',
      startGreeting:    !!r.start_greeting,
      lastGreetingAt:   r.last_greeting_at || 0,
      offset:           r.offset || 0,
    };
  }
}

module.exports = BotsRepository;
