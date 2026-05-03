'use strict';

/**
 * mcp/tools/monitor.js — tool `monitor_process` para consulta streaming de
 * shells persistentes o PTYs.
 *
 * No ejecuta comandos nuevos — solo lee output existente del `ShellSession`
 * asociado al chat (via ctx.sessionManager o un monitor registry).
 *
 * Patrón de uso:
 *   1. El modelo corre `bash("npm run build")` en un turn — el output se
 *      buffered en el ShellSession del chat.
 *   2. En turns siguientes puede llamar `monitor_process({pattern:"BUILD OK"})`
 *      para esperar un pattern sin seguir viendo el comando.
 *
 * Este MVP es **polling-based**: devuelve el output actual + un cursor. El
 * modelo decide si pollear de nuevo en la siguiente iteración. En una
 * iteración futura podría convertirse en streaming real via ResumableSession.
 */

const { truncateBashOutput } = require('../../core/outputCaps');

const MONITOR_PROCESS = {
  name: 'monitor_process',
  description: 'Consulta el output del shell persistente del chat actual (sin ejecutar comandos). Opcionalmente filtra por pattern regex. Retorna output acumulado + cursor para próxima llamada.',
  params: {
    pattern: '?string',
    cursor: '?number',     // byte offset desde donde continuar (default 0)
    maxBytes: '?number',   // cap del output retornado (default usa outputCaps)
  },
  execute(args = {}, ctx = {}) {
    if (!ctx.sessionManager) return 'Error: sessionManager no disponible en ctx';

    const shellId = ctx.shellId || String(ctx.chatId || '');
    if (!shellId) return 'Error: no se pudo resolver shellId (falta chatId o shellId en ctx)';

    // Consultar el ShellSession. El ShellSession actual no expone un cursor público;
    // este método lo sondea via propiedad _pollBuffer si existe, o retorna mensaje
    // informativo. Diseño mínimo: reutilizamos lo que hay sin romper.
    let shell;
    try {
      shell = ctx.sessionManager.getShell && ctx.sessionManager.getShell(shellId);
    } catch { shell = null; }

    if (!shell || !shell._proc) {
      return '(shell no activo — ejecutá un comando con bash antes para inicializarlo)';
    }

    // Lectura best-effort del buffer actual. El ShellSession ring buffer es privado;
    // si no hay hook público, retornamos un mensaje indicativo. Esto se mejorará
    // cuando ShellSession exponga un `snapshot()` público (iteración futura).
    const snapshot = typeof shell.snapshot === 'function' ? shell.snapshot() : null;
    if (!snapshot) {
      return '(monitor_process — ShellSession aún no expone snapshot público; usá bash para ejecutar y ver output directamente)';
    }

    const cursor = Number(args.cursor) || 0;
    const tail = snapshot.stdout.slice(cursor);
    const maxBytes = Number(args.maxBytes) || undefined;

    let out = tail;
    if (args.pattern) {
      try {
        const re = new RegExp(String(args.pattern));
        const lines = tail.split('\n').filter(l => re.test(l));
        out = lines.join('\n');
      } catch (err) {
        return `Error: pattern inválido: ${err.message}`;
      }
    }

    if (maxBytes) out = truncateBashOutput(out, { maxLength: maxBytes });
    else out = truncateBashOutput(out);

    const newCursor = cursor + tail.length;
    return `--- cursor=${newCursor} ---\n${out || '(sin output nuevo)'}`;
  },
};

module.exports = [MONITOR_PROCESS];
