'use strict';

const ShellSession = require('../ShellSession');

const ACTIONS = {
  status:   { cmd: (a) => 'git status',                                   desc: 'Estado del repo' },
  diff:     { cmd: (a) => `git diff ${a.file || ''}`.trim(),              desc: 'Ver cambios' },
  log:      { cmd: (a) => `git log --oneline -${a.count || 10}`,          desc: 'Historial de commits' },
  branch:   { cmd: (a) => a.name ? `git checkout -b ${a.name}` : 'git branch -a', desc: 'Listar o crear branch' },
  checkout: { cmd: (a) => `git checkout ${a.ref || ''}`.trim(),           desc: 'Cambiar de branch' },
  add:      { cmd: (a) => `git add ${a.files || '.'}`,                    desc: 'Agregar archivos al staging' },
  commit:   { cmd: (a) => a.message ? `git commit -m "${a.message.replace(/"/g, '\\"')}"` : null, desc: 'Crear commit' },
  push:     { cmd: (a) => `git push origin ${a.branch || 'HEAD'}`,        desc: 'Subir cambios al remoto' },
  pull:     { cmd: (a) => `git pull origin ${a.branch || ''}`.trim(),     desc: 'Bajar cambios del remoto' },
  stash:    { cmd: (a) => a.pop === 'true' ? 'git stash pop' : 'git stash', desc: 'Guardar/restaurar cambios temporales' },
  blame:    { cmd: (a) => a.file ? `git blame ${a.file}` : null,          desc: 'Ver autoría línea por línea' },
  show:     { cmd: (a) => `git show ${a.ref || 'HEAD'}`,                  desc: 'Ver detalle de un commit' },
};

module.exports = {
  name: 'git',
  description: `Herramienta git con acciones: ${Object.keys(ACTIONS).join(', ')}. Más seguro y cómodo que bash para operaciones git.`,
  inputSchema: {
    type: 'object',
    properties: {
      action:  { type: 'string', description: `Acción: ${Object.keys(ACTIONS).join(', ')}` },
      message: { type: 'string', description: 'Mensaje de commit (para action=commit)' },
      files:   { type: 'string', description: 'Archivos (para action=add, espacio-separados)' },
      file:    { type: 'string', description: 'Archivo (para action=diff, blame)' },
      branch:  { type: 'string', description: 'Branch (para action=push, pull, checkout)' },
      ref:     { type: 'string', description: 'Ref/commit (para action=checkout, show)' },
      name:    { type: 'string', description: 'Nombre de nuevo branch (para action=branch)' },
      count:   { type: 'string', description: 'Cantidad de commits (para action=log, default 10)' },
      pop:     { type: 'string', description: '"true" para stash pop (para action=stash)' },
    },
    required: ['action'],
  },

  async execute({ action, ...args } = {}, ctx = {}) {
    if (!action) return 'Error: parámetro action requerido';

    const def = ACTIONS[action];
    if (!def) return `Error: acción desconocida "${action}". Acciones: ${Object.keys(ACTIONS).join(', ')}`;

    const cmd = def.cmd(args);
    if (!cmd) return `Error: parámetros insuficientes para "${action}"`;

    const shellId = ctx.shellId || 'global';
    const shell = ShellSession.get(shellId);

    try {
      return await shell.run(cmd);
    } catch (err) {
      return `Error git ${action}: ${err.message}`;
    }
  },
};
