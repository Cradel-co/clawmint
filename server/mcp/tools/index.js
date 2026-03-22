'use strict';

const bash     = require('./bash');
const files    = require('./files');    // array
const pty      = require('./pty');      // array
const telegram = require('./telegram'); // array
const memory   = require('./memory');   // array

const ALL_TOOLS = [bash, ...files, ...pty, ...telegram, ...memory];

const _byName = new Map(ALL_TOOLS.map(t => [t.name, t]));

/** @returns {Array} todos los tools */
function all() { return ALL_TOOLS; }

/**
 * Ejecuta un tool por nombre.
 * @param {string}  name
 * @param {object}  args
 * @param {object}  [ctx]  - { shellId, sessionManager, memory }
 * @returns {Promise<string>}
 */
async function execute(name, args, ctx = {}) {
  const tool = _byName.get(name);
  if (!tool) return `Error: herramienta desconocida: ${name}`;
  try {
    return String(await tool.execute(args, ctx));
  } catch (err) {
    return `Error ejecutando ${name}: ${err.message}`;
  }
}

module.exports = { all, execute };
