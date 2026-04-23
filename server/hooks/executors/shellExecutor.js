'use strict';

/**
 * shellExecutor — ejecuta un script/binario como hook handler.
 *
 * Contrato:
 *   - El script recibe el payload JSON por stdin.
 *   - El script escribe su response JSON a stdout.
 *   - Exit code 0 con JSON válido → parseado como `{block?, replace?}`.
 *   - Exit != 0 o stdout inválido → error reportado como hook error (cadena continúa).
 *
 * Seguridad:
 *   - `buildSafeEnv()` (Fase 5.75) — no hereda secretos del server.
 *   - Timeout provisto por HookRegistry; SIGKILL al vencer.
 *   - `handlerRef` debe apuntar a un path absoluto; validación contra `allowedRoot` opcional.
 */

const { spawn } = require('child_process');
const path = require('path');
const { buildSafeEnv, isCwdWithin } = require('../../core/security/shellSandbox');

class ShellExecutor {
  /**
   * @param {object} [opts]
   * @param {string} [opts.allowedRoot] — si se setea, hooks solo pueden apuntar a scripts dentro de este dir
   * @param {string} [opts.cwd]         — cwd del spawn (default: dir del script)
   */
  constructor(opts = {}) {
    this._allowedRoot = opts.allowedRoot || null;
    this._cwd = opts.cwd || null;
  }

  async execute(hook, payload, opts = {}) {
    const scriptPath = String(hook.handlerRef || '');
    if (!scriptPath) throw new Error('handlerRef (path del script) requerido');
    if (!path.isAbsolute(scriptPath)) throw new Error('handlerRef debe ser path absoluto');
    if (this._allowedRoot && !isCwdWithin(scriptPath, this._allowedRoot)) {
      throw new Error(`script fuera del root permitido: ${this._allowedRoot}`);
    }

    return await new Promise((resolve, reject) => {
      const child = spawn(scriptPath, [], {
        env: buildSafeEnv(),
        cwd: this._cwd || path.dirname(scriptPath),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c.toString(); });
      child.stderr.on('data', (c) => { stderr += c.toString(); });

      child.on('error', (err) => reject(new Error(`spawn fail: ${err.message}`)));

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`script exit ${code}: ${stderr.slice(0, 300)}`));
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) return resolve(null); // no output = sin intervención
        try {
          const parsed = JSON.parse(trimmed);
          resolve(_validateResult(parsed));
        } catch (e) {
          reject(new Error(`stdout no es JSON válido: ${e.message}`));
        }
      });

      // Escribir payload al stdin
      try {
        child.stdin.write(JSON.stringify(payload || {}));
        child.stdin.end();
      } catch (e) {
        reject(new Error(`stdin write fail: ${e.message}`));
      }
      void opts;
    });
  }
}

function _validateResult(obj) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return null;
  const out = {};
  if (obj.block) out.block = String(obj.block);
  if (obj.replace && typeof obj.replace === 'object' && 'args' in obj.replace) {
    out.replace = { args: obj.replace.args };
  }
  return out;
}

ShellExecutor._internal = { _validateResult };
module.exports = ShellExecutor;
