'use strict';

const fs   = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { LOG_FILES } = require('../paths');

/**
 * Logger con configuración hot-reload desde logs.json.
 * Extraído de index.js para reutilización.
 *
 * Extiende EventEmitter: emite `line` por cada log escrito, para que el WS
 * `/ws/logs` (admin) pueda streamear en vivo.
 */
class Logger extends EventEmitter {
  constructor({ logFile, configFile } = {}) {
    super();
    this.setMaxListeners(50);
    this._logFile    = logFile    || LOG_FILES.serverLog;
    this._configFile = configFile || LOG_FILES.logsJson;
    if (!fs.existsSync(this._configFile)) this._saveConfig({ enabled: true });
    this._logConfig = this._loadConfig();
    this._logCount = 0;
  }

  _loadConfig() {
    try {
      if (fs.existsSync(this._configFile))
        return JSON.parse(fs.readFileSync(this._configFile, 'utf8'));
    } catch {}
    return { enabled: true };
  }

  _saveConfig(cfg) {
    try { fs.writeFileSync(this._configFile, JSON.stringify(cfg, null, 2), 'utf8'); } catch {}
  }

  _rotate() {
    try {
      const stat = fs.statSync(this._logFile);
      if (stat.size < 50 * 1024 * 1024) return; // < 50MB
      const rotated1 = this._logFile + '.1';
      const rotated2 = this._logFile + '.2';
      try { fs.unlinkSync(rotated2); } catch {}
      try { fs.renameSync(rotated1, rotated2); } catch {}
      fs.renameSync(this._logFile, rotated1);
    } catch {}
  }

  _log(level, ...args) {
    this._logConfig = this._loadConfig(); // hot-reload
    const isError = level.trim() === 'ERROR';
    if (!this._logConfig.enabled && !isError) return;
    const ts   = new Date().toISOString();
    const msg  = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const line = `[${ts}] [${level}] ${msg}\n`;
    process.stdout.write(line);
    try {
      if (++this._logCount % 1000 === 0) this._rotate();
      fs.appendFileSync(this._logFile, line);
    } catch {}
    // Emit event para suscriptores (WS /ws/logs, hooks, etc)
    // No-op si no hay listeners; swallow errors para no romper logging.
    try { this.emit('line', { ts, level: level.trim(), message: msg, raw: line.trimEnd() }); } catch {}
  }

  info(...a)  { this._log('INFO ', ...a); }
  warn(...a)  { this._log('WARN ', ...a); }
  error(...a) { this._log('ERROR', ...a); }

  getConfig()    { return this._loadConfig(); }
  setConfig(cfg) { this._saveConfig(cfg); this._logConfig = cfg; }

  tail(n = 100) {
    try {
      const content = fs.existsSync(this._logFile) ? fs.readFileSync(this._logFile, 'utf8') : '';
      return content.split('\n').filter(Boolean).slice(-n);
    } catch { return []; }
  }

  clear() {
    try { fs.writeFileSync(this._logFile, '', 'utf8'); } catch {}
  }
}

module.exports = Logger;
