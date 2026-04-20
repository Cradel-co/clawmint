'use strict';

/**
 * blockDangerousBash — hook handler built-in para pre_tool_use que bloquea
 * patrones destructivos conocidos en comandos bash.
 *
 * Patrones bloqueados:
 *   - `rm -rf /` y variantes
 *   - Fork bombs: `:(){ :|:& };:`
 *   - Sobrescritura de dispositivos: `> /dev/sd*`, `dd if=... of=/dev/sd*`
 *   - Formateos: `mkfs`
 *
 * Uso via JsExecutor:
 *   jsExecutor.registerHandler('block_dangerous_bash', blockDangerousBashHandler())
 *   hookRegistry.register({
 *     event: 'pre_tool_use',
 *     handlerType: 'js',
 *     handlerRef: 'block_dangerous_bash',
 *     scopeType: 'global',
 *     priority: 100,  // correr primero
 *   })
 */

const DANGEROUS_PATTERNS = [
  // rm -rf / y derivados (permite rm -rf /tmp/foo pero no raíz)
  /\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+(\/|--no-preserve-root|\$HOME|~)(?:\s|$|\/)/,
  // fork bomb clásico
  /:\(\)\s*\{.*\|\s*:.*\}\s*;\s*:/,
  // dd contra raw devices
  /\bdd\s+.*of=\/dev\/(sd|nvme|hd|vd)/i,
  // mkfs (formateo)
  /\bmkfs\b/i,
  // sobrescribir dispositivos raw
  />\s*\/dev\/(sd|nvme|hd|vd)[a-z]?[0-9]?/i,
];

function blockDangerousBashHandler() {
  return async function blockDangerousBash(payload) {
    const name = payload && payload.name;
    // Aplica a tools que ejecutan shell
    if (name !== 'bash' && name !== 'pty_exec' && name !== 'pty_write') return null;

    const args = (payload && payload.args) || {};
    const cmd = String(args.command || args.text || args.input || '');
    if (!cmd) return null;

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cmd)) {
        return { block: `comando peligroso bloqueado (pattern: ${pattern.source.slice(0, 40)}...)` };
      }
    }
    return null;
  };
}

module.exports = { blockDangerousBashHandler, DANGEROUS_PATTERNS };
