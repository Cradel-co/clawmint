'use strict';

/**
 * mcp-client-pool.js — Pool de clientes MCP para conectar MCPs externos
 * a todos los providers (Anthropic, Gemini, OpenAI, Grok).
 *
 * Gestiona lifecycle de conexiones, cachea tool definitions,
 * y expone una API unificada para ejecutar tools externas.
 *
 * Namespacing: mcpName__toolName (doble underscore) para evitar colisiones.
 *
 * Las tool definitions persisten mientras el MCP esté enabled,
 * incluso si la conexión stdio cae — se reconecta automáticamente.
 */

const { Client } = require('@modelcontextprotocol/sdk/client');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

let mcps = null;
function _getMcps() {
  if (!mcps) try { mcps = require('./mcps'); } catch {}
  return mcps;
}

const SEP = '__';
const RECONNECT_DELAY = 3000; // ms

// Map<mcpName, { client, transport, connected: boolean, reconnecting: boolean }>
const _connections = new Map();

// Map<prefixedName, { mcpName, originalName, def }>
// Se mantiene mientras el MCP esté registrado (no se limpia al perder conexión)
const _toolRegistry = new Map();

// Set<mcpName> — MCPs registrados (tienen tool defs cacheadas)
const _registered = new Set();

// Map<mcpName, string[]> — tool names por MCP (para cleanup en unregister)
const _mcpToolNames = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function _prefixName(mcpName, toolName) {
  return `${mcpName}${SEP}${toolName}`;
}

function _createTransport(mcpConfig) {
  switch (mcpConfig.type) {
    case 'stdio':
      return new StdioClientTransport({
        command: mcpConfig.command,
        args: mcpConfig.args || [],
        env: { ...process.env, ...(mcpConfig.env || {}) },
      });
    case 'sse':
      return new SSEClientTransport(new URL(mcpConfig.url));
    case 'http': {
      try {
        const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
        return new StreamableHTTPClientTransport(new URL(mcpConfig.url));
      } catch {
        return new SSEClientTransport(new URL(mcpConfig.url));
      }
    }
    default:
      throw new Error(`Tipo de transporte no soportado: ${mcpConfig.type}`);
  }
}

function _extractText(result) {
  if (!result || !result.content) return '';
  return result.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

// ── Conexión interna (sin limpiar registry) ──────────────────────────────────

async function _connect(name) {
  // Cerrar conexión previa si existe
  const prev = _connections.get(name);
  if (prev) {
    try { await prev.client.close(); } catch {}
    try { if (prev.transport && prev.transport.close) await prev.transport.close(); } catch {}
    _connections.delete(name);
  }

  const m = _getMcps();
  if (!m) throw new Error('Módulo mcps no disponible');

  const mcpConfig = m.get(name);
  if (!mcpConfig) throw new Error(`MCP "${name}" no encontrado`);

  const transport = _createTransport(mcpConfig);
  const client = new Client(
    { name: `clawmint-${name}`, version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);

  // Listener para reconexión automática al perder conexión
  client.onclose = () => {
    const conn = _connections.get(name);
    if (conn) conn.connected = false;
    // Solo reconectar si sigue registrado
    if (_registered.has(name)) {
      process.stderr.write(`[mcp-client-pool] "${name}" desconectado, reconectando en ${RECONNECT_DELAY}ms...\n`);
      setTimeout(() => _reconnect(name), RECONNECT_DELAY);
    }
  };

  _connections.set(name, { client, transport, connected: true, reconnecting: false });
  return client;
}

async function _reconnect(name) {
  if (!_registered.has(name)) return;
  const conn = _connections.get(name);
  if (conn && conn.connected) return; // ya reconectó
  if (conn && conn.reconnecting) return; // ya en proceso

  if (conn) conn.reconnecting = true;

  try {
    await _connect(name);
    process.stdout.write(`[mcp-client-pool] "${name}" reconectado\n`);
  } catch (err) {
    process.stderr.write(`[mcp-client-pool] Reconexión de "${name}" falló: ${err.message}\n`);
    // Reintentar con backoff
    if (_registered.has(name)) {
      setTimeout(() => _reconnect(name), RECONNECT_DELAY * 3);
    }
  }
}

/** Asegura que la conexión está activa, reconecta si no */
async function _ensureConnected(name) {
  const conn = _connections.get(name);
  if (conn && conn.connected) return conn;

  // Reconectar
  await _connect(name);
  return _connections.get(name);
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Conecta a un MCP por nombre. Cachea tool defs con prefijo.
 * Las tool defs persisten hasta que se llame a unregisterMcp().
 */
async function connectMcp(name) {
  const client = await _connect(name);

  // Listar tools y cachear (solo si es primera vez o refresh)
  const { tools } = await client.listTools();
  const toolNames = [];

  // Limpiar tools previas de este MCP
  const prevTools = _mcpToolNames.get(name) || [];
  for (const tn of prevTools) _toolRegistry.delete(tn);

  for (const tool of tools) {
    const prefixed = _prefixName(name, tool.name);
    toolNames.push(prefixed);
    _toolRegistry.set(prefixed, {
      mcpName: name,
      originalName: tool.name,
      def: {
        name: prefixed,
        description: `[${name}] ${tool.description || tool.name}`,
        inputSchema: tool.inputSchema || { type: 'object', properties: {}, required: [] },
      },
    });
  }

  _mcpToolNames.set(name, toolNames);
  _registered.add(name);

  process.stdout.write(`[mcp-client-pool] Conectado a "${name}": ${tools.length} tools\n`);
  return tools.length;
}

/**
 * Desregistra un MCP completamente: cierra conexión Y limpia tool defs.
 * Se usa cuando el usuario hace unsync/disable.
 */
async function disconnectMcp(name) {
  _registered.delete(name);

  // Limpiar tool registry
  const toolNames = _mcpToolNames.get(name) || [];
  for (const tn of toolNames) _toolRegistry.delete(tn);
  _mcpToolNames.delete(name);

  // Cerrar conexión y transport
  const conn = _connections.get(name);
  if (conn) {
    try { await conn.client.close(); } catch {}
    try { if (conn.transport && conn.transport.close) await conn.transport.close(); } catch {}
    _connections.delete(name);
  }

  process.stdout.write(`[mcp-client-pool] Desregistrado "${name}"\n`);
}

/**
 * Inicializa el pool: conecta todos los MCPs con enabled: true.
 */
async function initialize() {
  const m = _getMcps();
  if (!m) return;

  const all = m.list().filter(mcp => mcp.enabled);
  let count = 0;

  for (const mcp of all) {
    try {
      await connectMcp(mcp.name);
      count++;
    } catch (err) {
      process.stderr.write(`[mcp-client-pool] Error conectando "${mcp.name}": ${err.message}\n`);
    }
  }

  process.stdout.write(`[mcp-client-pool] Pool inicializado: ${count}/${all.length} MCPs conectados\n`);
}

/**
 * Devuelve array de tool definitions externas (con inputSchema completo).
 * Incluye tools de MCPs registrados incluso si temporalmente desconectados.
 */
function getExternalToolDefs() {
  return Array.from(_toolRegistry.values()).map(entry => entry.def);
}

/**
 * Retorna true si el nombre corresponde a una tool externa registrada.
 */
function isExternalTool(name) {
  return _toolRegistry.has(name);
}

/**
 * Ejecuta un tool en el MCP correspondiente.
 * Reconecta automáticamente si la conexión se perdió.
 */
async function callTool(prefixedName, args) {
  const entry = _toolRegistry.get(prefixedName);
  if (!entry) return `Error: tool externa desconocida: ${prefixedName}`;

  try {
    // Asegurar conexión activa (reconecta si murió)
    const conn = await _ensureConnected(entry.mcpName);
    if (!conn) return `Error: MCP "${entry.mcpName}" no conectado`;

    const result = await conn.client.callTool({
      name: entry.originalName,
      arguments: args || {},
    });

    if (result.isError) {
      return `Error [${entry.mcpName}]: ${_extractText(result)}`;
    }
    return _extractText(result) || '(sin resultado)';
  } catch (err) {
    // Si falló por conexión cerrada, reintentar una vez
    if (err.message && (err.message.includes('closed') || err.message.includes('EPIPE') || err.message.includes('not connected'))) {
      process.stderr.write(`[mcp-client-pool] "${entry.mcpName}" error en callTool, reconectando...\n`);
      try {
        await _connect(entry.mcpName);
        const conn2 = _connections.get(entry.mcpName);
        if (conn2) {
          const result = await conn2.client.callTool({ name: entry.originalName, arguments: args || {} });
          return result.isError ? `Error [${entry.mcpName}]: ${_extractText(result)}` : (_extractText(result) || '(sin resultado)');
        }
      } catch (reconnErr) {
        return `Error reconectando "${entry.mcpName}": ${reconnErr.message}`;
      }
    }
    return `Error ejecutando ${prefixedName}: ${err.message}`;
  }
}

/**
 * Devuelve lista de MCPs registrados con su estado.
 */
function status() {
  const result = [];
  for (const name of _registered) {
    const conn = _connections.get(name);
    const toolNames = _mcpToolNames.get(name) || [];
    result.push({
      name,
      connected: !!(conn && conn.connected),
      toolCount: toolNames.length,
      tools: toolNames,
    });
  }
  return result;
}

module.exports = { initialize, connectMcp, disconnectMcp, getExternalToolDefs, isExternalTool, callTool, status };
