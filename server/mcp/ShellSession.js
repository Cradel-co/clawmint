'use strict';

/**
 * ShellSession — shell bash persistente por ID.
 * cwd, variables de entorno y estado persisten entre llamadas.
 *
 * Uso:
 *   const { get } = require('./ShellSession');
 *   const shell = get(chatId);
 *   const output = await shell.run('cd /tmp && ls');
 *   const cwd    = await shell.run('pwd');  // /tmp  ← estado persistió
 */

const { spawn } = require('child_process');

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos

class ShellSession {
  constructor() {
    this._proc = spawn('bash', ['--norc', '--noprofile'], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._queue   = Promise.resolve();
    this._cmdId   = 0;
    this._destroyed = false;
    this._idleTimer = null;
    this._resetIdleTimer();

    this._proc.on('exit', () => { this._destroyed = true; });
    this._proc.on('error', (err) => {
      console.error('[ShellSession] error de proceso:', err.message);
    });
  }

  _resetIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this.destroy(), IDLE_TIMEOUT_MS);
    this._idleTimer.unref();
  }

  /**
   * Ejecuta un comando en el shell persistente.
   * @param {string} command
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<string>} stdout + stderr combinados
   */
  run(command, timeoutMs = 30000) {
    this._resetIdleTimer();
    // Serializar comandos — nunca ejecutar en paralelo
    this._queue = this._queue.then(() => this._run(command, timeoutMs));
    return this._queue;
  }

  _run(command, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this._destroyed) {
        reject(new Error('Shell session destruida'));
        return;
      }

      const id       = ++this._cmdId;
      const SENTINEL = `__CLAWMINT_${id}__`;
      let stdoutBuf  = '';
      let stderrBuf  = '';
      let settled    = false;

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        fn(value);
      };

      const timeout = setTimeout(() => {
        settle(reject, new Error(`Timeout: comando no terminó en ${timeoutMs}ms`));
      }, timeoutMs);

      const tryResolve = () => {
        const sentinelRe = new RegExp(`${SENTINEL}:(\\d+)`);
        const match      = stdoutBuf.match(sentinelRe);
        if (!match) return;

        const sentinelIdx = stdoutBuf.indexOf(match[0]);
        const exitCode    = parseInt(match[1], 10);
        const stdout      = stdoutBuf.slice(0, sentinelIdx).trimEnd();
        const stderr      = stderrBuf.trimEnd();
        const combined    = [stdout, stderr].filter(Boolean).join('\n');

        let result = combined || '(sin output)';
        if (exitCode !== 0) result = `[exit ${exitCode}]\n${result}`;

        settle(resolve, result);
      };

      const onStdout = (chunk) => { stdoutBuf += chunk.toString(); tryResolve(); };
      const onStderr = (chunk) => { stderrBuf += chunk.toString(); };

      const cleanup = () => {
        this._proc.stdout.removeListener('data', onStdout);
        this._proc.stderr.removeListener('data', onStderr);
      };

      this._proc.stdout.on('data', onStdout);
      this._proc.stderr.on('data', onStderr);

      // Escribir comando + centinela al stdin de bash
      this._proc.stdin.write(`${command}\necho "${SENTINEL}:$?"\n`);
    });
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    try { this._proc.kill('SIGTERM'); } catch {}
  }
}

// ── Pool de sesiones ──────────────────────────────────────────────────────────

const _sessions = new Map();

/**
 * Obtiene (o crea) una ShellSession para el ID dado.
 * @param {string} id
 * @returns {ShellSession}
 */
function get(id) {
  const existing = _sessions.get(id);
  if (existing && !existing._destroyed) return existing;
  const session = new ShellSession();
  _sessions.set(id, session);
  return session;
}

function destroy(id) {
  const s = _sessions.get(id);
  if (s) { s.destroy(); _sessions.delete(id); }
}

function destroyAll() {
  for (const s of _sessions.values()) s.destroy();
  _sessions.clear();
}

module.exports = { ShellSession, get, destroy, destroyAll };
