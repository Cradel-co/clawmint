'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * BotsRepository — persistencia de bots en bots.json.
 * Extraído de BotManager._readFile() / _saveFile().
 */
class BotsRepository {
  constructor(botsFilePath) {
    this._filePath = botsFilePath || path.join(__dirname, '..', 'bots.json');
  }

  /**
   * Lee los bots desde el archivo.
   * Si no existe, intenta crear uno desde env vars (primera ejecución).
   * @returns {object[]}
   */
  read() {
    try {
      if (fs.existsSync(this._filePath)) {
        return JSON.parse(fs.readFileSync(this._filePath, 'utf8')) || [];
      }

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
      };
      fs.writeFileSync(this._filePath, JSON.stringify([entry], null, 2), 'utf8');
      console.log(`[Telegram] bots.json creado desde variables de entorno (key: ${entry.key})`);
      return [entry];
    } catch { return []; }
  }

  /**
   * Guarda la lista de bots en el archivo.
   * @param {object[]} bots
   */
  save(bots) {
    try {
      fs.writeFileSync(this._filePath, JSON.stringify(bots, null, 2), 'utf8');
    } catch (err) {
      console.error('[Telegram] No se pudo guardar bots.json:', err.message);
    }
  }
}

module.exports = BotsRepository;
