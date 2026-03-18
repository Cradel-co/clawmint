'use strict';

const PTY_WRITE = {
  name: 'pty_write',
  description: 'Escribe texto a una sesión PTY activa (terminal interactiva).',
  params: { session_id: 'string', input: 'string' },

  execute({ session_id, input } = {}, ctx = {}) {
    if (!session_id) return 'Error: parámetro session_id requerido';
    if (input === undefined) return 'Error: parámetro input requerido';
    const sm = ctx.sessionManager;
    if (!sm) return 'Error: sessionManager no disponible en este contexto';
    const session = sm.get(session_id);
    if (!session) return `Error: sesión no encontrada: ${session_id}`;
    session.input(input);
    return 'ok';
  },
};

const PTY_READ = {
  name: 'pty_read',
  description: 'Lee el output buffereado de una sesión PTY desde un timestamp dado.',
  params: { session_id: 'string', since: '?string' },

  execute({ session_id, since } = {}, ctx = {}) {
    if (!session_id) return 'Error: parámetro session_id requerido';
    const sm = ctx.sessionManager;
    if (!sm) return 'Error: sessionManager no disponible en este contexto';
    const session = sm.get(session_id);
    if (!session) return `Error: sesión no encontrada: ${session_id}`;
    const ts  = since ? parseInt(since, 10) : 0;
    const raw = session.getOutputSince(ts);
    return raw || '(sin output)';
  },
};

module.exports = [PTY_WRITE, PTY_READ];
