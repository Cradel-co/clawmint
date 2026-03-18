'use strict';

const ShellSession = require('../ShellSession');

module.exports = {
  name: 'bash',
  description: 'Shell con estado persistente — cwd/env persisten entre llamadas. Usar session_id para aislar conversaciones.',
  params: { command: 'string', session_id: '?string' },

  async execute({ command, session_id } = {}, ctx = {}) {
    if (!command) return 'Error: parámetro command requerido';
    const shellId = session_id || ctx.shellId || 'global';
    const shell   = ShellSession.get(shellId);
    return shell.run(command);
  },
};
