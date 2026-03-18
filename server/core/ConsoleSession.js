'use strict';

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const HOME   = process.env.HOME || process.env.USERPROFILE || '';

function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;?]*[A-Za-z@]/g, '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[A-Z\\]/g, '')
    .replace(/[\x00-\x08\x0E-\x1F\x7F]/g, '')
    .replace(/\r/g, '')
    .trim();
}

/**
 * ConsoleSession — sesión de consola pura, sin dependencias de canal.
 *
 * Mantiene el cwd y permite ejecutar comandos, navegar con cd,
 * y obtener botones de UI según el SO. Reutilizable desde cualquier
 * canal (Telegram, WebSocket, HTTP, Discord, etc.).
 */
class ConsoleSession {
  constructor(initialCwd = HOME) {
    this.cwd = initialCwd || HOME;
  }

  get isWindows() { return IS_WIN; }

  /**
   * Obtiene el cwd abreviado (~ en lugar de HOME).
   */
  getCwdShort() {
    return HOME ? this.cwd.replace(HOME, '~') : this.cwd;
  }

  /**
   * Cambia de directorio.
   * @param {string} target - ruta relativa, absoluta, o '~'
   * @returns {{ ok: boolean, cwd: string, error?: string }}
   */
  changeDirectory(target) {
    const dest = (target || '').trim() || HOME;
    const resolved = dest === '~' ? HOME
      : path.isAbsolute(dest) ? dest
      : path.resolve(this.cwd, dest);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) return { ok: false, cwd: this.cwd, error: 'no es un directorio' };
      this.cwd = resolved;
      return { ok: true, cwd: this.cwd };
    } catch (err) {
      return { ok: false, cwd: this.cwd, error: err.message };
    }
  }

  /**
   * Ejecuta un comando en el shell del SO.
   * @param {string} command
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
   */
  executeCommand(command, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const shell = IS_WIN ? 'cmd.exe' : 'bash';
      const args  = IS_WIN ? ['/c', command] : ['-c', command];
      const child = spawn(shell, args, {
        cwd: this.cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        resolve({ stdout, stderr: stderr + '\n[timeout]', code: 124 });
      }, timeoutMs);
      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
      child.on('error', err  => { clearTimeout(timer); reject(err); });
    });
  }

  /**
   * Formatea el output de un comando para mostrar al usuario.
   * @param {string} command - comando ejecutado
   * @param {string} stdout
   * @param {string} stderr
   * @param {number} code - exit code
   * @param {number} [maxLen=3800]
   * @returns {string}
   */
  formatOutput(command, stdout, stderr, code, maxLen = 3800) {
    const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n').trim();
    const cleaned  = stripAnsi(combined) || '(sin salida)';
    const prefix   = code !== 0 ? `⚠️ [exit ${code}]\n` : '';
    let out = `\`$ ${command}\`\n${prefix}${cleaned}`;
    if (out.length > maxLen) out = out.slice(0, maxLen) + `\n…[+${combined.length - maxLen} chars]`;
    return out;
  }

  /**
   * Retorna los botones de consola según el SO.
   * Formato genérico: array de filas, cada fila con { text, command }.
   * El canal adapta al formato de su UI (Telegram inline_keyboard, HTML, etc.).
   * @returns {Array<Array<{ text: string, command: string }>>}
   */
  getPromptButtons() {
    if (IS_WIN) {
      return [
        [{ text: '📋 dir',      command: 'dir'         },
         { text: '📋 dir /a',   command: 'dir /a'      },
         { text: '⬆️ cd ..',    command: 'cd ..'       }],
        [{ text: '📊 disco',    command: 'wmic logicaldisk get size,freespace,caption' },
         { text: '⚙️ tasklist', command: 'tasklist /fi "STATUS eq running" | more' },
         { text: '🚪 Salir',    command: 'exit'        }],
      ];
    }
    return [
      [{ text: '📋 ls',     command: 'ls'              },
       { text: '📋 ls -la', command: 'ls -la'          },
       { text: '⬆️ cd ..',  command: 'cd ..'           }],
      [{ text: '📊 df -h',  command: 'df -h'           },
       { text: '⚙️ ps',     command: 'ps aux|head -20' },
       { text: '🚪 Salir',  command: 'exit'            }],
    ];
  }

  /**
   * Verifica si un comando es de salida.
   */
  isExitCommand(command) {
    const t = (command || '').trim().toLowerCase();
    return t === 'exit' || t === 'salir' || t === 'quit';
  }

  /**
   * Verifica si un comando es cd.
   */
  isCdCommand(command) {
    return /^cd(\s|$)/i.test((command || '').trim());
  }
}

module.exports = ConsoleSession;
