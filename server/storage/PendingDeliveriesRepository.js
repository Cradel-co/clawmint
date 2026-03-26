'use strict';

const crypto = require('crypto');

/**
 * PendingDeliveriesRepository — cola de entrega para canales desconectados.
 *
 * Cuando un canal (WebChat, P2P) no está disponible al momento de enviar,
 * el mensaje se encola y se entrega al reconectarse.
 */
class PendingDeliveriesRepository {
  static SCHEMA = `
    CREATE TABLE IF NOT EXISTS pending_deliveries (
      id           TEXT PRIMARY KEY,
      action_id    TEXT,
      user_id      TEXT NOT NULL,
      channel      TEXT NOT NULL,
      identifier   TEXT NOT NULL,
      bot_key      TEXT,
      content      TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   INTEGER NOT NULL,
      delivered_at INTEGER,
      expires_at   INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_pd_pending ON pending_deliveries(status, channel, identifier);
  `;

  constructor(db) {
    this._db = db || null;
  }

  init() {
    if (!this._db) return;
    this._db.exec(PendingDeliveriesRepository.SCHEMA);
  }

  /**
   * Encola un mensaje para entrega posterior.
   * @param {object} delivery
   * @param {string} delivery.action_id — scheduled_action que lo generó (nullable)
   * @param {string} delivery.user_id
   * @param {string} delivery.channel — 'web' | 'p2p'
   * @param {string} delivery.identifier — sessionId o peerId
   * @param {string} [delivery.bot_key]
   * @param {object} delivery.content — { text, parse_mode?, buttons? }
   * @param {number} [delivery.expires_at] — epoch ms, default 7 días
   */
  enqueue(delivery) {
    if (!this._db) return null;
    const now = Date.now();
    const id = crypto.randomUUID();
    const contentStr = typeof delivery.content === 'string'
      ? delivery.content
      : JSON.stringify(delivery.content);
    const expiresAt = delivery.expires_at || (now + 7 * 24 * 60 * 60 * 1000); // 7 días default

    this._db.prepare(`
      INSERT INTO pending_deliveries (id, action_id, user_id, channel, identifier, bot_key, content, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, delivery.action_id || null, delivery.user_id, delivery.channel,
           String(delivery.identifier), delivery.bot_key || null, contentStr, now, expiresAt);

    return { id, ...delivery, status: 'pending', created_at: now, expires_at: expiresAt };
  }

  /**
   * Obtiene mensajes pendientes para un canal+identifier específico.
   * Filtra expirados automáticamente.
   */
  getPending(channel, identifier) {
    if (!this._db) return [];
    const now = Date.now();
    // Marcar expirados
    this._db.prepare(`
      UPDATE pending_deliveries SET status = 'expired'
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(now);

    return this._db.prepare(`
      SELECT * FROM pending_deliveries
      WHERE status = 'pending' AND channel = ? AND identifier = ?
      ORDER BY created_at
    `).all(channel, String(identifier)).map(row => {
      try { row.content = JSON.parse(row.content); } catch { /* keep string */ }
      return row;
    });
  }

  /**
   * Marca un mensaje como entregado.
   */
  markDelivered(id) {
    if (!this._db) return;
    this._db.prepare(`
      UPDATE pending_deliveries SET status = 'delivered', delivered_at = ? WHERE id = ?
    `).run(Date.now(), id);
  }

  /**
   * Marca todos los pendientes de un canal+identifier como entregados.
   */
  markAllDelivered(channel, identifier) {
    if (!this._db) return;
    this._db.prepare(`
      UPDATE pending_deliveries SET status = 'delivered', delivered_at = ?
      WHERE status = 'pending' AND channel = ? AND identifier = ?
    `).run(Date.now(), channel, String(identifier));
  }

  /**
   * Limpia entregas antiguas (entregadas o expiradas, >30 días).
   */
  cleanup() {
    if (!this._db) return;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    this._db.prepare(`
      DELETE FROM pending_deliveries
      WHERE status IN ('delivered', 'expired') AND created_at < ?
    `).run(cutoff);
  }
}

module.exports = PendingDeliveriesRepository;
