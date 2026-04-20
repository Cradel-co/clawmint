'use strict';

/**
 * @clawmint/sdk — re-export del paquete publicable.
 *
 * Fase 12.1 parked → cerrado. El SDK real vive en `packages/sdk/` como paquete
 * npm independiente. Este archivo mantiene compatibilidad con imports existentes
 * del server (`require('./sdk')`).
 */

module.exports = require('../../packages/sdk/index.js');
