'use strict';

const registry = require('./critter-registry');

/**
 * Critter tools — control remoto del PC del usuario vía P2P.
 * Cada tool tiene `channel: 'p2p'` para que solo aparezcan en sesiones P2P.
 */

function _execute(remoteTool, timeoutMs) {
  return async function execute(args, ctx) {
    const peerId = registry.getPeerIdFromShellId(ctx.shellId);
    if (!peerId) return 'Error: esta sesión no es P2P — critter tools no disponibles';
    if (!registry.isConnected(peerId)) return 'Error: critter desconectado';
    try {
      const result = await registry.sendAction(peerId, remoteTool, args, timeoutMs);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      return `Error: ${err.message}`;
    }
  };
}

module.exports = [
  {
    name: 'critter_bash',
    description: 'Ejecutar un comando en el PC del critter (PowerShell/bash)',
    params: { command: 'string', '?cwd': '?string', '?timeout_ms': '?number' },
    channel: 'p2p',
    execute: async function (args, ctx) {
      const timeout = args.timeout_ms ? Number(args.timeout_ms) : 30000;
      return _execute('bash', timeout)(args, ctx);
    },
  },
  {
    name: 'critter_read_file',
    description: 'Leer un archivo del PC del critter',
    params: { path: 'string', '?offset': '?string', '?limit': '?string' },
    channel: 'p2p',
    execute: _execute('file_read'),
  },
  {
    name: 'critter_write_file',
    description: 'Escribir un archivo en el PC del critter',
    params: { path: 'string', content: 'string' },
    channel: 'p2p',
    execute: _execute('file_write'),
  },
  {
    name: 'critter_edit_file',
    description: 'Editar un archivo en el PC del critter (reemplazo exacto de texto)',
    params: { path: 'string', old_string: 'string', new_string: 'string' },
    channel: 'p2p',
    execute: _execute('file_edit'),
  },
  {
    name: 'critter_list_files',
    description: 'Listar el contenido de un directorio en el PC del critter',
    params: { path: 'string', '?pattern': '?string' },
    channel: 'p2p',
    execute: _execute('file_list'),
  },
  {
    name: 'critter_grep',
    description: 'Buscar por patrón en archivos del PC del critter',
    params: { pattern: 'string', '?path': '?string', '?glob': '?string', '?max_results': '?string' },
    channel: 'p2p',
    execute: _execute('grep'),
  },
  {
    name: 'critter_screenshot',
    description: 'Capturar la pantalla del PC del critter (retorna base64 PNG)',
    params: { '?x': '?string', '?y': '?string', '?w': '?string', '?h': '?string' },
    channel: 'p2p',
    execute: _execute('screenshot'),
  },
  {
    name: 'critter_clipboard_read',
    description: 'Leer el portapapeles del PC del critter',
    params: {},
    channel: 'p2p',
    execute: _execute('clipboard_read'),
  },
  {
    name: 'critter_clipboard_write',
    description: 'Escribir texto al portapapeles del PC del critter',
    params: { text: 'string' },
    channel: 'p2p',
    execute: _execute('clipboard_write'),
  },
  {
    name: 'critter_screen_info',
    description: 'Obtener información del monitor del PC del critter (resolución, escala)',
    params: {},
    channel: 'p2p',
    execute: _execute('screen_info'),
  },
];
