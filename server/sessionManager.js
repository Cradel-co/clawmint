'use strict';

const pty = require('node-pty');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_SHELL = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
const MAX_BUFFER = 5000;

function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;?]*[A-Za-z@]/g, '')          // CSI (incluye ?2004h, ?2004l, etc.)
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '') // OSC (título de ventana, etc.)
    .replace(/\x1B[A-Z\\]/g, '')                        // Escape sequences simples
    .replace(/[\x00-\x08\x0E-\x1F\x7F]/g, '')          // otros control chars
    .replace(/\r/g, '')
    .trim();
}

class PtySession {
  constructor({ type = 'pty', command, cols = 80, rows = 24 } = {}) {
    this.id = crypto.randomUUID();
    this.type = type;
    this.title = command || DEFAULT_SHELL;
    this.createdAt = Date.now();
    this.active = true;

    this._outputBuffer = []; // { ts, data }[]
    this._outputListeners = new Map();
    this._pty = null;

    this._spawn({ command, cols, rows });
  }

  _spawn({ command, cols, rows }) {
    const args = command ? ['-c', command] : [];

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    this._pty = pty.spawn(DEFAULT_SHELL, args, {
      name: 'xterm-color',
      cols,
      rows,
      cwd: process.env.HOME,
      env,
    });

    this._pty.onData((data) => {
      const entry = { ts: Date.now(), data };
      this._outputBuffer.push(entry);
      if (this._outputBuffer.length > MAX_BUFFER) this._outputBuffer.shift();

      for (const cb of this._outputListeners.values()) {
        try { cb(data); } catch {}
      }
    });

    this._pty.onExit(() => {
      this.active = false;
      for (const cb of this._outputListeners.values()) {
        try { cb(null, 'exit'); } catch {}
      }
    });
  }

  /** Escribe texto raw al PTY */
  input(text) {
    if (this._pty && this.active) this._pty.write(text);
  }

  /**
   * Inyecta texto directo a los listeners y al buffer SIN escribir al PTY.
   * Útil para mostrar notificaciones (ej: mensajes de Telegram) en el frontend
   * sin interferir con el proceso del PTY.
   */
  injectOutput(text) {
    const entry = { ts: Date.now(), data: text };
    this._outputBuffer.push(entry);
    if (this._outputBuffer.length > MAX_BUFFER) this._outputBuffer.shift();
    for (const cb of this._outputListeners.values()) {
      try { cb(text); } catch {}
    }
  }

  /** Redimensiona el PTY */
  resize(cols, rows) {
    if (this._pty && this.active) this._pty.resize(cols, rows);
  }

  /**
   * Envía texto + \n y espera a que la salida se estabilice.
   * Retorna { raw, response } donde response tiene los ANSI codes eliminados.
   * @param {string} text
   * @param {{ timeout?: number, stableMs?: number }} opts
   */
  sendMessage(text, { timeout = 30000, stableMs = 1500 } = {}) {
    return new Promise((resolve) => {
      const accumulated = [];
      let stableTimer = null;
      let timeoutTimer = null;
      let resolved = false;

      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(stableTimer);
        clearTimeout(timeoutTimer);
        unsub();
        const raw = accumulated.join('');
        resolve({ raw, response: stripAnsi(raw) });
      };

      const resetStable = () => {
        clearTimeout(stableTimer);
        stableTimer = setTimeout(done, stableMs);
      };

      const unsub = this.onOutput((data, event) => {
        if (event === 'exit') { done(); return; }
        accumulated.push(data);
        resetStable();
      });

      timeoutTimer = setTimeout(done, timeout);

      // Enviar el mensaje al PTY
      if (this._pty && this.active) {
        this._pty.write(text + '\n');
      }
      resetStable();
    });
  }

  /**
   * Suscribe un callback al output del PTY.
   * @param {(data: string|null, event?: string) => void} cb
   * @returns {() => void} función para desuscribir
   */
  onOutput(cb) {
    const id = crypto.randomUUID();
    this._outputListeners.set(id, cb);
    return () => this._outputListeners.delete(id);
  }

  /**
   * Retorna el output acumulado desde un timestamp dado.
   * @param {number} ts  — timestamp en ms (0 = todo el historial)
   */
  getOutputSince(ts = 0) {
    return this._outputBuffer
      .filter(e => e.ts >= ts)
      .map(e => e.data)
      .join('');
  }

  /** Mata el PTY y limpia listeners */
  destroy() {
    this.active = false;
    if (this._pty) {
      try { this._pty.kill(); } catch {}
      this._pty = null;
    }
    this._outputListeners.clear();
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      title: this.title,
      createdAt: this.createdAt,
      active: this.active,
    };
  }
}

// ─── Manager ─────────────────────────────────────────────────────────────────

const sessions = new Map();

module.exports = {
  create(opts = {}) {
    const session = new PtySession(opts);
    sessions.set(session.id, session);
    return session;
  },

  get(id) {
    return sessions.get(id);
  },

  list() {
    return [...sessions.values()];
  },

  destroy(id) {
    const session = sessions.get(id);
    if (!session) return false;
    session.destroy();
    sessions.delete(id);
    return true;
  },
};
