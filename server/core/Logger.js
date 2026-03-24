'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Logger con configuración hot-reload desde logs.json.
 * Extraído de index.js para reutilización.
 */
class Logger {
  constructor({ logFile, configFile } = {}) {
    this._logFile    = logFile    || path.join(__dirname, '..', 'server.log');
    this._configFile = configFile || path.join(__dirname, '..', 'logs.json');
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
    const line = `[${ts}] [${level}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
    process.stdout.write(line);
    try {
      if (++this._logCount % 1000 === 0) this._rotate();
      fs.appendFileSync(this._logFile, line);
    } catch {}
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
