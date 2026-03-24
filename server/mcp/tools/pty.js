'use strict';

const PTY_CREATE = {
  name: 'pty_create',
  description: 'Crea una sesión PTY interactiva (terminal persistente). Retorna session_id para usar con pty_write y pty_read. Útil para comandos interactivos (ssh, vim, htop, etc.).',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Comando inicial (default: shell del sistema)' },
      cols:    { type: 'string', description: 'Columnas del terminal (default: 120)' },
      rows:    { type: 'string', description: 'Filas del terminal (default: 30)' },
    },
    required: [],
  },

  execute({ command, cols, rows } = {}, ctx = {}) {
    const sm = ctx.sessionManager;
    if (!sm) return 'Error: sessionManager no disponible en este contexto';
    const session = sm.create({
      type: 'pty',
      command: command || null,
      cols: parseInt(cols, 10) || 120,
      rows: parseInt(rows, 10) || 30,
    });
    return `PTY creada: session_id=${session.id}\nUsá pty_write para enviar comandos y pty_read para leer output.`;
  },
};

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

module.exports = [PTY_CREATE, PTY_WRITE, PTY_READ];
