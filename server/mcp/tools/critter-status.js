'use strict';

const registry = require('./critter-registry');

/**
 * critter_status — disponible en todas las sesiones (sin channel).
 * Permite al AI saber si hay un critter conectado.
 */
module.exports = {
  name: 'critter_status',
  description: 'Verifica si hay un critter (escritorio remoto) conectado por P2P',
  params: {},

  execute(args, ctx) {
    const peerId = registry.getPeerIdFromShellId(ctx.shellId);
    if (!peerId) return 'No estás en una sesión P2P — critter no disponible';
    return registry.isConnected(peerId) ? 'Critter conectado y disponible' : 'Critter desconectado';
  },
};
