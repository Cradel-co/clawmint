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
const { buildSafeEnv } = require('../core/security/shellSandbox');
const { truncateBashOutput } = require('../core/outputCaps');

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos
const IS_WIN = process.platform === 'win32';
const MAX_BUF_BYTES = 2 * 1024 * 1024;           // 2MB máximo por stdout/stderr
const RUNAWAY_BYTES_PER_SEC = 50 * 1024 * 1024;  // >50MB/s → kill SIGKILL

/**
 * Ring buffer de strings con FIFO drop: descarta desde el inicio para preservar el final.
 * El final suele ser más útil para el modelo (incluye el sentinel del comando y el output reciente).
 * `raw()` devuelve el buffer sin prefix (para búsqueda de sentinela).
 * `value()` devuelve con prefix `[truncado N bytes — últimos 2MB]` si hubo truncado.
 */
function makeRingBuf() {
  return {
    _buf: '',
    _truncatedBytes: 0,
    push(str) {
      this._buf += str;
      if (this._buf.length > MAX_BUF_BYTES) {
        const toDrop = this._buf.length - MAX_BUF_BYTES;
        this._buf = this._buf.slice(toDrop);
        this._truncatedBytes += toDrop;
      }
    },
    raw() { return this._buf; },
    value() {
      if (this._truncatedBytes > 0) {
        return `[truncado ${this._truncatedBytes} bytes — últimos ${MAX_BUF_BYTES} bytes]\n${this._buf}`;
      }
      return this._buf;
    },
  };
}

class ShellSession {
  constructor() {
    const shell = IS_WIN ? 'cmd.exe' : 'bash';
    const args  = IS_WIN ? ['/Q'] : ['--norc', '--noprofile'];
    // Hardening Fase 5.75 F3: env sanitizada (allowlist) para no exponer secretos del server.
    // Rollback legacy: SHELL_SANDBOX_STRICT=false.
    this._proc = spawn(shell, args, {
      env: buildSafeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
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
      const stdoutBuf = makeRingBuf();
      const stderrBuf = makeRingBuf();
      let settled    = false;
      let runawayBytes = 0;

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(runawayTimer);
        cleanup();
        fn(value);
      };

      const timeout = setTimeout(() => {
        settle(reject, new Error(`Timeout: comando no terminó en ${timeoutMs}ms`));
      }, timeoutMs);

      const runawayTimer = setInterval(() => {
        if (runawayBytes > RUNAWAY_BYTES_PER_SEC) {
          try { this._proc.kill('SIGKILL'); } catch {}
          // Marcar la sesión como destruida — el shell ya no existe.
          this._destroyed = true;
          settle(reject, new Error(`Proceso killed: >${RUNAWAY_BYTES_PER_SEC / 1024 / 1024}MB/s sostenido`));
        }
        runawayBytes = 0;
      }, 1000);
      runawayTimer.unref();

      const tryResolve = () => {
        const sentinelRe = new RegExp(`${SENTINEL}:(\\d+)`);
        const raw        = stdoutBuf.raw();
        const match      = raw.match(sentinelRe);
        if (!match) return;

        const sentinelIdx = raw.indexOf(match[0]);
        const exitCode    = parseInt(match[1], 10);
        const stdout      = stdoutBuf._truncatedBytes > 0
          ? `[truncado ${stdoutBuf._truncatedBytes} bytes — últimos ${MAX_BUF_BYTES} bytes]\n${raw.slice(0, sentinelIdx).trimEnd()}`
          : raw.slice(0, sentinelIdx).trimEnd();
        const stderr      = stderrBuf.value().trimEnd();
        const combined    = [stdout, stderr].filter(Boolean).join('\n');

        let result = combined || '(sin output)';
        if (exitCode !== 0) result = `[exit ${exitCode}]\n${result}`;

        // Fase 7.5.6: aplicar cap de tamaño antes de devolver (distinto del ring buffer de 2MB)
        result = truncateBashOutput(result);

        settle(resolve, result);
      };

      const onStdout = (chunk) => {
        const s = chunk.toString();
        runawayBytes += s.length;
        stdoutBuf.push(s);
        tryResolve();
      };
      const onStderr = (chunk) => {
        const s = chunk.toString();
        runawayBytes += s.length;
        stderrBuf.push(s);
      };

      const cleanup = () => {
        this._proc.stdout.removeListener('data', onStdout);
        this._proc.stderr.removeListener('data', onStderr);
      };

      this._proc.stdout.on('data', onStdout);
      this._proc.stderr.on('data', onStderr);

      // Escribir comando + centinela al stdin del shell
      if (IS_WIN) {
        this._proc.stdin.write(`${command}\r\necho ${SENTINEL}:%errorlevel%\r\n`);
      } else {
        this._proc.stdin.write(`${command}\necho "${SENTINEL}:$?"\n`);
      }
    });
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    try { this._proc.removeAllListeners(); } catch {}
    if (this._proc.stdout) try { this._proc.stdout.removeAllListeners(); } catch {}
    if (this._proc.stderr) try { this._proc.stderr.removeAllListeners(); } catch {}
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
