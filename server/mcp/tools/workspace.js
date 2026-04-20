'use strict';

/**
 * mcp/tools/workspace.js — tools admin para introspección del estado de workspaces.
 *
 * Fase 8.4 parked → cerrado. Usa el `workspaceRegistry` inyectado en ctx
 * (via ConversationService) para enumerar provider y su lifecycle interno.
 */

const { isAdmin } = require('./user-sandbox');

const WORKSPACE_STATUS = {
  name: 'workspace_status',
  description: 'Admin-only. Lista workspaces activos por provider (null/git-worktree/docker/ssh): id, path, branch/container, creado/último acceso.',
  params: {},
  adminOnly: true,
  async execute(_args = {}, ctx = {}) {
    if (!isAdmin(ctx)) {
      return 'Error: workspace_status solo está disponible para administradores.';
    }
    const reg = ctx.workspaceRegistry;
    if (!reg) return 'Error: workspaceRegistry no disponible en ctx';

    const lines = [];
    for (const [providerName, provider] of Object.entries(reg)) {
      if (!provider) {
        lines.push(`${providerName}: no habilitado`);
        continue;
      }
      if (typeof provider.list === 'function') {
        const entries = provider.list();
        if (!entries.length) {
          lines.push(`${providerName}: sin workspaces activos`);
          continue;
        }
        lines.push(`${providerName}: ${entries.length} workspace(s)`);
        for (const e of entries) {
          const created = new Date(e.createdAt || 0).toISOString();
          const lastAcc = e.lastAccessAt ? new Date(e.lastAccessAt).toISOString() : '(n/a)';
          const label = e.path || e.hostPath || e.remotePath || e.containerName || '(n/a)';
          const extra = e.branch ? ` branch=${e.branch}` : (e.containerId ? ` container=${e.containerId.slice(0, 12)}` : '');
          lines.push(`  - ${e.id}${extra} path=${label} created=${created} last=${lastAcc}`);
        }
      } else {
        lines.push(`${providerName}: provider activo (sin list())`);
      }
    }
    return lines.join('\n') || '(sin datos)';
  },
};

module.exports = [WORKSPACE_STATUS];
