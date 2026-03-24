'use strict';

/**
 * mcp/index.js — API pública del módulo MCP.
 *
 * Exports:
 *   createMcpRouter({ sessionManager, memory })  → Express Router en /mcp
 *   executeTool(name, args, ctx)                  → Promise<string> (en-proceso, sin protocolo)
 *   getToolDefs()                                 → array de definiciones de tools
 */

const express    = require('express');
const toolsIndex = require('./tools');

// ── Helpers de schema ─────────────────────────────────────────────────────────

function _buildProperties(params = {}) {
  const props = {};
  for (const [k] of Object.entries(params)) {
    props[k.replace('?', '')] = { type: 'string', description: k.replace('?', '') };
  }
  return props;
}

function _buildRequired(params = {}) {
  return Object.entries(params)
    .filter(([, v]) => !String(v).startsWith('?'))
    .map(([k]) => k);
}

function _toolToMcp(tool) {
  return {
    name:        tool.name,
    description: tool.description,
    inputSchema: {
      type:       'object',
      properties: _buildProperties(tool.params),
      required:   _buildRequired(tool.params),
    },
  };
}

// ── MCP JSON-RPC router ───────────────────────────────────────────────────────

/**
 * Crea un Express Router que implementa el protocolo MCP sobre HTTP (JSON-RPC 2.0).
 * Compatible con: claude mcp add-json clawmint '{"type":"http","url":"http://localhost:3001/mcp"}'
 */
function createMcpRouter({ sessionManager, memory } = {}) {
  const router = express.Router();
  router.use(express.json());

  const SERVER_INFO  = { name: 'clawmint', version: '1.0.0' };
  const CAPABILITIES = { tools: {} };
  const PROTO_VER    = '2024-11-05';

  router.post('/', async (req, res) => {
    const { jsonrpc, id, method, params } = req.body || {};

    if (jsonrpc !== '2.0') {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request' },
        id: null,
      });
    }

    try {
      let result;

      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: PROTO_VER,
            serverInfo:      SERVER_INFO,
            capabilities:    CAPABILITIES,
          };
          break;

        case 'ping':
          result = {};
          break;

        case 'notifications/initialized':
          // Notificación — sin respuesta de resultado
          return res.status(202).end();

        case 'tools/list':
          result = { tools: toolsIndex.all().map(_toolToMcp) };
          break;

        case 'tools/call': {
          const { name, arguments: args } = params || {};
          if (!name) {
            return res.json({
              jsonrpc: '2.0',
              error: { code: -32602, message: 'Parámetro name requerido' },
              id,
            });
          }
          const shellId = req.headers['x-shell-id'] || `mcp-${id || 'global'}`;
          const ctx     = { shellId, sessionManager, memory };
          const output  = await toolsIndex.execute(name, args || {}, ctx);
          result = { content: [{ type: 'text', text: output }] };
          break;
        }

        default:
          return res.json({
            jsonrpc: '2.0',
            error: { code: -32601, message: `Method not found: ${method}` },
            id,
          });
      }

      res.json({ jsonrpc: '2.0', id, result });
    } catch (err) {
      res.json({
        jsonrpc: '2.0',
        error: { code: -32603, message: err.message },
        id,
      });
    }
  });

  // GET — info básica (no es MCP estándar, ayuda a debugging)
  router.get('/', (_req, res) => {
    res.json({
      server:       SERVER_INFO,
      protocol:     PROTO_VER,
      tools:        toolsIndex.all().map(t => t.name),
      transport:    'HTTP JSON-RPC 2.0',
      usage:        'POST / con body {"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
  });

  return router;
}

// ── API en-proceso (sin overhead de protocolo) ────────────────────────────────

/**
 * Ejecuta un tool directamente en proceso.
 * Usar desde ConversationService con ctx.shellId para persistencia de shell.
 */
async function executeTool(name, args, ctx = {}) {
  return toolsIndex.execute(name, args, ctx);
}

/** Retorna las definiciones de los tools (filtradas por opts.channel si se especifica) */
function getToolDefs(opts) {
  return toolsIndex.all(opts);
}

module.exports = { createMcpRouter, executeTool, getToolDefs };
