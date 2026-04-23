'use strict';

/**
 * NullWorkspace — default, no-op. Retorna el cwd del server sin crear aislamiento.
 *
 * Se usa cuando:
 *   - el subagente no necesita aislamiento (tipos `explore`, `plan`, `researcher`)
 *   - `WORKSPACE_ADAPTORS_ENABLED=false` (default Fase 8)
 *   - rollback rápido de GitWorktreeWorkspace ante problemas
 *
 * El `release()` es no-op — no hay que limpiar nada.
 */

const WorkspaceProvider = require('./WorkspaceProvider');

class NullWorkspace extends WorkspaceProvider {
  constructor(opts = {}) {
    super();
    this._cwd = opts.cwd || process.cwd();
  }

  async acquire(_ctx) {
    return {
      id: 'null',
      cwd: this._cwd,
      release: async () => { /* no-op */ },
      meta: { provider: 'null' },
    };
  }
}

module.exports = NullWorkspace;
