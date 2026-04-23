'use strict';

/**
 * mcp/tools/memory.js — Tools MCP para gestión de memoria del agente.
 *
 * Expone: memory_list, memory_read, memory_write, memory_append, memory_delete
 * Usa ctx.memory (server/memory.js) pasado desde el router MCP.
 * El agentKey se resuelve desde ctx.agentKey o args.agent (default: 'default').
 * Usuarios no-admin tienen namespace aislado: user:<userId>:<agentKey>
 */

const { isAdmin, resolveUserId } = require('./user-sandbox');

function _agent(args, ctx) {
  const base = args.agent || ctx.agentKey || 'default';
  // Non-admin users get a namespaced agent key for isolation
  if (!isAdmin(ctx)) {
    const userId = resolveUserId(ctx);
    if (userId) return `user:${userId}:${base}`;
  }
  return base;
}

function _requireMemory(ctx) {
  if (!ctx.memory) throw new Error('Módulo de memoria no disponible');
}

const MEMORY_LIST = {
  name: 'memory_list',
  description: 'Lista los archivos de memoria del agente actual. Retorna nombre, tamaño y fecha de cada archivo.',
  params: { agent: '?string' },

  execute(args = {}, ctx = {}) {
    _requireMemory(ctx);
    const agentKey = _agent(args, ctx);
    const files = ctx.memory.listFiles(agentKey);
    if (!files.length) return `Sin archivos de memoria para "${agentKey}".`;
    const lines = files.map(f => {
      const date = new Date(f.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
      return `${f.filename}\t${f.size}B\t${date}`;
    });
    return `Memoria de "${agentKey}" (${files.length} archivos):\n${lines.join('\n')}`;
  },
};

const MEMORY_READ = {
  name: 'memory_read',
  description: 'Lee el contenido de un archivo de memoria del agente.',
  params: { filename: 'string', agent: '?string' },

  execute(args = {}, ctx = {}) {
    _requireMemory(ctx);
    if (!args.filename) return 'Error: parámetro filename requerido';
    const agentKey = _agent(args, ctx);
    const content = ctx.memory.read(agentKey, args.filename);
    if (content === null) return `Archivo no encontrado: ${args.filename} (agente: ${agentKey})`;
    return content;
  },
};

const MEMORY_WRITE = {
  name: 'memory_write',
  description: 'Escribe (crea o sobreescribe) un archivo de memoria del agente. Usar para guardar información importante.',
  params: { filename: 'string', content: 'string', agent: '?string' },

  execute(args = {}, ctx = {}) {
    _requireMemory(ctx);
    if (!args.filename) return 'Error: parámetro filename requerido';
    if (!args.content)  return 'Error: parámetro content requerido';
    const agentKey = _agent(args, ctx);
    ctx.memory.write(agentKey, args.filename, args.content);
    return `Memoria guardada: ${args.filename} (agente: ${agentKey})`;
  },
};

const MEMORY_APPEND = {
  name: 'memory_append',
  description: 'Agrega contenido al final de un archivo de memoria existente (o lo crea si no existe).',
  params: { filename: 'string', content: 'string', agent: '?string' },

  execute(args = {}, ctx = {}) {
    _requireMemory(ctx);
    if (!args.filename) return 'Error: parámetro filename requerido';
    if (!args.content)  return 'Error: parámetro content requerido';
    const agentKey = _agent(args, ctx);
    ctx.memory.append(agentKey, args.filename, args.content);
    return `Contenido agregado a: ${args.filename} (agente: ${agentKey})`;
  },
};

const MEMORY_DELETE = {
  name: 'memory_delete',
  description: 'Elimina un archivo de memoria del agente.',
  params: { filename: 'string', agent: '?string' },

  execute(args = {}, ctx = {}) {
    _requireMemory(ctx);
    if (!args.filename) return 'Error: parámetro filename requerido';
    const agentKey = _agent(args, ctx);
    const deleted = ctx.memory.remove(agentKey, args.filename);
    return deleted
      ? `Archivo eliminado: ${args.filename} (agente: ${agentKey})`
      : `Archivo no encontrado: ${args.filename} (agente: ${agentKey})`;
  },
};

module.exports = [MEMORY_LIST, MEMORY_READ, MEMORY_WRITE, MEMORY_APPEND, MEMORY_DELETE];
