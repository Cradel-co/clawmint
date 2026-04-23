'use strict';

/**
 * routes/mcp-admin.js — MCP de administración de Clawmint (HTTP JSON-RPC 2.0)
 *
 * Expone herramientas de gestión para que Claude Code u otras IAs controlen
 * el servidor: memoria, agentes, sistema, proveedores y usuarios.
 *
 * Uso con Claude Code:
 *   claude mcp add-json clawmint-admin \
 *     '{"type":"http","url":"http://localhost:3001/mcp-admin","headers":{"Authorization":"Bearer <token>"}}'
 *
 * Requiere: requireAuth + requireAdmin en el mount (index.js lo hace).
 */

const express = require('express');
const os      = require('os');

module.exports = function createMcpAdminRouter({ memory, agents, usersRepo, locationService, providerConfig, householdRepo } = {}) {
  const router = express.Router();
  router.use(express.json());

  const SERVER_INFO  = { name: 'clawmint-admin', version: '1.0.0' };
  const CAPABILITIES = { tools: {} };
  const PROTO_VER    = '2024-11-05';

  // ── Definición de tools ───────────────────────────────────────────────────────

  const TOOLS = [

    // ─── MEMORIA ────────────────────────────────────────────────────────────────

    {
      name:        'memory_stats',
      description: 'Estadísticas globales de la base de conocimiento: total de notas, links, distribución por agente e importancia.',
      inputSchema: { type: 'object', properties: {} },
      execute() {
        const graph  = memory.buildGraph(null);
        const byAgent = {};
        for (const n of graph.nodes) {
          byAgent[n.agentKey] = (byAgent[n.agentKey] || 0) + 1;
        }
        const byImportance = {};
        for (const n of graph.nodes) {
          byImportance[n.importance ?? 5] = (byImportance[n.importance ?? 5] || 0) + 1;
        }
        return JSON.stringify({
          totalNotes:    graph.nodes.length,
          totalLinks:    graph.links.length,
          byAgent,
          byImportance,
        }, null, 2);
      },
    },

    {
      name:        'memory_search',
      description: 'Búsqueda de texto libre en todas las notas de todos los agentes.',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string', description: 'Texto a buscar' } },
        required: ['q'],
      },
      execute({ q }) {
        const results = memory.globalSearch(q, 30);
        if (!results.length) return 'Sin resultados.';
        return results.map(r =>
          `[${r.agentKey}] ${r.title || r.filename} (imp:${r.importance}) — ${r.preview}`
        ).join('\n');
      },
    },

    {
      name:        'memory_list',
      description: 'Lista todas las notas de un agente. Sin agentKey lista todos los agentes y su conteo.',
      inputSchema: {
        type: 'object',
        properties: { agentKey: { type: 'string', description: 'Clave del agente (opcional)' } },
      },
      execute({ agentKey } = {}) {
        if (agentKey) {
          const files = memory.listFiles(agentKey);
          if (!files.length) return `Sin notas para el agente "${agentKey}".`;
          return files.map(f =>
            `${f.filename} | imp:${f.importance} | accesos:${f.accessCount} | ${f.title || '(sin título)'}`
          ).join('\n');
        }
        const graph = memory.buildGraph(null);
        const counts = {};
        for (const n of graph.nodes) counts[n.agentKey] = (counts[n.agentKey] || 0) + 1;
        return Object.entries(counts).sort((a, b) => b[1] - a[1])
          .map(([k, c]) => `${k}: ${c} notas`).join('\n') || 'Sin notas.';
      },
    },

    {
      name:        'memory_read',
      description: 'Lee el contenido completo de una nota.',
      inputSchema: {
        type: 'object',
        properties: {
          agentKey: { type: 'string', description: 'Clave del agente' },
          filename: { type: 'string', description: 'Nombre del archivo' },
        },
        required: ['agentKey', 'filename'],
      },
      execute({ agentKey, filename }) {
        const content = memory.read(agentKey, filename);
        if (content === null) return `Nota "${filename}" no encontrada en agente "${agentKey}".`;
        return content;
      },
    },

    {
      name:        'memory_write',
      description: 'Crea o reemplaza el contenido de una nota de memoria.',
      inputSchema: {
        type: 'object',
        properties: {
          agentKey: { type: 'string' },
          filename: { type: 'string', description: 'Nombre del archivo (ej: context.md)' },
          content:  { type: 'string', description: 'Contenido completo en Markdown' },
        },
        required: ['agentKey', 'filename', 'content'],
      },
      execute({ agentKey, filename, content }) {
        memory.write(agentKey, filename, content);
        return `Nota "${filename}" guardada en agente "${agentKey}".`;
      },
    },

    {
      name:        'memory_delete',
      description: 'Elimina una nota de memoria de forma permanente.',
      inputSchema: {
        type: 'object',
        properties: {
          agentKey: { type: 'string' },
          filename: { type: 'string' },
        },
        required: ['agentKey', 'filename'],
      },
      execute({ agentKey, filename }) {
        const ok = memory.remove(agentKey, filename);
        return ok ? `Nota "${filename}" eliminada.` : `Nota "${filename}" no encontrada.`;
      },
    },

    {
      name:        'memory_cleanup',
      description: 'Elimina notas huérfanas (sin links) con importancia menor a un umbral. Retorna un resumen de lo eliminado.',
      inputSchema: {
        type: 'object',
        properties: {
          maxImportance: { type: 'number', description: 'Importancia máxima para considerar eliminación (default: 4, escala 1-10)' },
          dryRun:        { type: 'boolean', description: 'Si true, solo lista candidatos sin eliminar' },
        },
      },
      execute({ maxImportance = 4, dryRun = false } = {}) {
        const graph = memory.buildGraph(null);
        const linkedIds = new Set();
        for (const l of graph.links) {
          linkedIds.add(typeof l.source === 'object' ? l.source.id : l.source);
          linkedIds.add(typeof l.target === 'object' ? l.target.id : l.target);
        }
        const candidates = graph.nodes.filter(n =>
          !linkedIds.has(n.id) && (n.importance ?? 5) <= maxImportance
        );
        if (!candidates.length) return 'No hay notas candidatas a eliminación.';
        if (dryRun) {
          return `Candidatos (${candidates.length}):\n` +
            candidates.map(n => `  [${n.agentKey}] ${n.filename} imp:${n.importance}`).join('\n');
        }
        let deleted = 0;
        for (const n of candidates) {
          try { memory.remove(n.agentKey, n.filename); deleted++; } catch {}
        }
        return `Eliminadas ${deleted} de ${candidates.length} notas huérfanas (imp ≤ ${maxImportance}).`;
      },
    },

    // ─── AGENTES ────────────────────────────────────────────────────────────────

    {
      name:        'agent_list',
      description: 'Lista todos los agentes configurados.',
      inputSchema: { type: 'object', properties: {} },
      execute() {
        const list = agents.list('__internal__');
        if (!list.length) return 'Sin agentes configurados.';
        return list.map(a =>
          `${a.key} | ${a.provider || 'default'} | ${a.description || ''}`
        ).join('\n');
      },
    },

    {
      name:        'agent_get',
      description: 'Retorna la configuración completa de un agente, incluyendo su system prompt.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Clave del agente' } },
        required: ['key'],
      },
      execute({ key }) {
        const a = agents.get(key);
        if (!a) return `Agente "${key}" no encontrado.`;
        return JSON.stringify(a, null, 2);
      },
    },

    {
      name:        'agent_update',
      description: 'Actualiza campos de un agente: description, prompt (system prompt), provider, command.',
      inputSchema: {
        type: 'object',
        properties: {
          key:         { type: 'string', description: 'Clave del agente' },
          description: { type: 'string' },
          prompt:      { type: 'string', description: 'System prompt completo' },
          provider:    { type: 'string', description: 'Proveedor IA (anthropic, openai, gemini, etc.)' },
          command:     { type: 'string' },
        },
        required: ['key'],
      },
      execute({ key, description, prompt, provider, command }) {
        const updates = {};
        if (description !== undefined) updates.description = description;
        if (prompt !== undefined)      updates.prompt      = prompt;
        if (provider !== undefined)    updates.provider    = provider;
        if (command !== undefined)     updates.command     = command;
        const updated = agents.update(key, updates, '__internal__');
        return `Agente "${key}" actualizado:\n${JSON.stringify(updated, null, 2)}`;
      },
    },

    {
      name:        'agent_create',
      description: 'Crea un nuevo agente.',
      inputSchema: {
        type: 'object',
        properties: {
          key:         { type: 'string', description: 'Identificador único (letras, números, _, -)' },
          command:     { type: 'string', description: 'Comando a ejecutar (ej: claude, null para API)' },
          description: { type: 'string' },
          prompt:      { type: 'string', description: 'System prompt' },
          provider:    { type: 'string' },
        },
        required: ['key'],
      },
      execute({ key, command = null, description = '', prompt = '', provider = '' }) {
        const a = agents.add(key, command, description, prompt, provider, '__internal__');
        return `Agente "${key}" creado:\n${JSON.stringify(a, null, 2)}`;
      },
    },

    {
      name:        'agent_delete',
      description: 'Elimina un agente (no elimina su memoria).',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
      },
      execute({ key }) {
        const ok = agents.remove(key, '__internal__');
        return ok ? `Agente "${key}" eliminado.` : `Agente "${key}" no encontrado.`;
      },
    },

    // ─── SISTEMA ─────────────────────────────────────────────────────────────────

    {
      name:        'system_health',
      description: 'Estado de salud del servidor: uptime, memoria de proceso, plataforma.',
      inputSchema: { type: 'object', properties: {} },
      execute() {
        const mem = process.memoryUsage();
        const mb  = v => Math.round(v / 1024 / 1024);
        return JSON.stringify({
          uptime:    Math.round(process.uptime()),
          platform:  process.platform,
          nodeVersion: process.version,
          pid:       process.pid,
          memory: {
            rss:       `${mb(mem.rss)} MB`,
            heapUsed:  `${mb(mem.heapUsed)} MB`,
            heapTotal: `${mb(mem.heapTotal)} MB`,
          },
          loadAvg:   os.loadavg().map(v => Math.round(v * 100) / 100),
          freeMem:   `${mb(os.freemem())} MB`,
          totalMem:  `${mb(os.totalmem())} MB`,
        }, null, 2);
      },
    },

    {
      name:        'system_location_get',
      description: 'Retorna la ubicación configurada del servidor (LAN, Tailscale, pública, manual).',
      inputSchema: { type: 'object', properties: {} },
      execute() {
        if (!locationService) return 'LocationService no disponible.';
        try {
          const loc = locationService.getLocation?.() || locationService.resolved || {};
          return JSON.stringify(loc, null, 2);
        } catch (e) {
          return `Error: ${e.message}`;
        }
      },
    },

    {
      name:        'system_location_set',
      description: 'Establece manualmente la ubicación del servidor (latitud, longitud, nombre).',
      inputSchema: {
        type: 'object',
        properties: {
          latitude:  { type: 'number' },
          longitude: { type: 'number' },
          name:      { type: 'string', description: 'Nombre legible (ej: Buenos Aires, Argentina)' },
        },
        required: ['latitude', 'longitude'],
      },
      execute({ latitude, longitude, name = 'Manual' }) {
        if (!locationService) return 'LocationService no disponible.';
        try {
          locationService.setManual?.({ latitude, longitude, name });
          return `Ubicación establecida: ${name} (${latitude}, ${longitude})`;
        } catch (e) {
          return `Error: ${e.message}`;
        }
      },
    },

    // ─── PROVEEDORES IA ───────────────────────────────────────────────────────────

    {
      name:        'provider_list',
      description: 'Lista los proveedores IA configurados con su estado (API key seteada o no).',
      inputSchema: { type: 'object', properties: {} },
      execute() {
        if (!providerConfig) return 'providerConfig no disponible.';
        try {
          const cfg  = providerConfig.getAll?.() || {};
          const lines = Object.entries(cfg).map(([k, v]) => {
            const hasKey = !!(v.apiKey || v.api_key || v.key);
            return `${k}: ${hasKey ? '✓ configurado' : '✗ sin API key'} | modelo: ${v.model || v.defaultModel || '(default)'}`;
          });
          return lines.join('\n') || 'Sin proveedores configurados.';
        } catch (e) {
          return `Error: ${e.message}`;
        }
      },
    },

    // ─── USUARIOS ─────────────────────────────────────────────────────────────────

    {
      name:        'user_list',
      description: 'Lista todos los usuarios del sistema con su estado (active/pending/disabled).',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', description: 'Filtrar por status: active, pending, disabled' } },
      },
      execute({ status } = {}) {
        if (!usersRepo) return 'usersRepo no disponible.';
        let users;
        if (status === 'pending') {
          users = usersRepo.getPendingUsers?.() || [];
        } else {
          users = usersRepo.getAllUsers?.() || usersRepo.getAll?.() || [];
          if (status) users = users.filter(u => u.status === status);
        }
        if (!users.length) return `Sin usuarios${status ? ` con status "${status}"` : ''}.`;
        return users.map(u =>
          `${u.id} | ${u.email} | ${u.name || ''} | ${u.role} | ${u.status}`
        ).join('\n');
      },
    },

    {
      name:        'user_approve',
      description: 'Aprueba un usuario pendiente para que pueda acceder al sistema.',
      inputSchema: {
        type: 'object',
        properties: { userId: { type: 'string', description: 'ID del usuario' } },
        required: ['userId'],
      },
      execute({ userId }) {
        if (!usersRepo) return 'usersRepo no disponible.';
        usersRepo.setStatus(Number(userId), 'active');
        return `Usuario ${userId} aprobado.`;
      },
    },

    {
      name:        'user_reject',
      description: 'Rechaza/deshabilita un usuario.',
      inputSchema: {
        type: 'object',
        properties: { userId: { type: 'string' } },
        required: ['userId'],
      },
      execute({ userId }) {
        if (!usersRepo) return 'usersRepo no disponible.';
        usersRepo.setStatus(Number(userId), 'disabled');
        return `Usuario ${userId} deshabilitado.`;
      },
    },

    // ─── HOUSEHOLD ────────────────────────────────────────────────────────────────

    {
      name:        'household_summary',
      description: 'Resumen del hogar: conteo de elementos por categoría y eventos próximos.',
      inputSchema: { type: 'object', properties: {} },
      execute() {
        if (!householdRepo) return 'householdRepo no disponible.';
        try {
          const summary = householdRepo.getSummary?.();
          return summary ? JSON.stringify(summary, null, 2) : 'Sin datos de hogar.';
        } catch (e) {
          return `Error: ${e.message}`;
        }
      },
    },

    {
      name:        'household_list',
      description: 'Lista elementos del hogar por categoría.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            description: 'Categoría: grocery_item | family_event | house_note | service | inventory',
          },
        },
        required: ['kind'],
      },
      execute({ kind }) {
        if (!householdRepo) return 'householdRepo no disponible.';
        try {
          const items = householdRepo.list(kind, {}) || [];
          if (!items.length) return `Sin elementos en "${kind}".`;
          return items.map(i => {
            const d = i.data ? JSON.parse(i.data) : {};
            return `${i.id} | ${i.title || d.name || ''} | ${i.completed_at ? '✓' : '○'} | ${i.date_at || ''}`;
          }).join('\n');
        } catch (e) {
          return `Error: ${e.message}`;
        }
      },
    },

  ];

  // ── Lookup por nombre ─────────────────────────────────────────────────────────

  const TOOL_MAP = Object.fromEntries(TOOLS.map(t => [t.name, t]));

  // ── JSON-RPC 2.0 handler ──────────────────────────────────────────────────────

  router.post('/', async (req, res) => {
    const { jsonrpc, id, method, params } = req.body || {};

    if (jsonrpc !== '2.0') {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null });
    }

    try {
      let result;

      switch (method) {
        case 'initialize':
          result = { protocolVersion: PROTO_VER, serverInfo: SERVER_INFO, capabilities: CAPABILITIES };
          break;

        case 'ping':
          result = {};
          break;

        case 'notifications/initialized':
          return res.status(202).end();

        case 'tools/list':
          result = {
            tools: TOOLS.map(t => ({
              name:        t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          };
          break;

        case 'tools/call': {
          const { name, arguments: args } = params || {};
          if (!name) {
            return res.json({ jsonrpc: '2.0', error: { code: -32602, message: 'name requerido' }, id });
          }
          const tool = TOOL_MAP[name];
          if (!tool) {
            return res.json({ jsonrpc: '2.0', error: { code: -32601, message: `Tool no encontrado: ${name}` }, id });
          }
          let output;
          try {
            output = await tool.execute(args || {});
          } catch (e) {
            output = `Error ejecutando ${name}: ${e.message}`;
          }
          result = { content: [{ type: 'text', text: String(output) }] };
          break;
        }

        default:
          return res.json({ jsonrpc: '2.0', error: { code: -32601, message: `Method not found: ${method}` }, id });
      }

      res.json({ jsonrpc: '2.0', id, result });
    } catch (err) {
      res.json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id });
    }
  });

  // GET — info + lista de tools (debugging)
  router.get('/', (_req, res) => {
    res.json({
      server:    SERVER_INFO,
      protocol:  PROTO_VER,
      transport: 'HTTP JSON-RPC 2.0',
      tools:     TOOLS.map(t => `${t.name} — ${t.description}`),
      usage:     'claude mcp add-json clawmint-admin \'{"type":"http","url":"http://localhost:3001/mcp-admin","headers":{"Authorization":"Bearer <token>"}}\'',
    });
  });

  return router;
};
