'use strict';

/**
 * Registra TODOS los providers OAuth MCP disponibles en el McpAuthService.
 *
 * Cada provider exporta `register({ mcpAuthService, logger })` y decide por sí
 * mismo si sus env vars están presentes. Llamalos all in one con `registerAll`.
 *
 * Env vars conocidas:
 *   - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET     → Calendar/Gmail/Drive/Tasks
 *   - GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET     → GitHub
 *   - SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET   → Spotify
 *
 * Para registrar un provider nuevo, crear `mcp-oauth-providers/<name>.js` con
 * `register({ mcpAuthService, logger })` exportado y agregarlo al array abajo.
 */

const providers = [
  require('./google'),
  require('./github'),
  require('./spotify'),
];

function registerAll({ mcpAuthService, systemConfigRepo = null, logger }) {
  if (!mcpAuthService) throw new Error('registerAll: mcpAuthService requerido');
  const all = [];
  for (const p of providers) {
    try {
      const regs = p.register({ mcpAuthService, systemConfigRepo, logger });
      if (regs && regs.length) all.push(...regs);
    } catch (e) {
      logger?.warn?.(`[mcp-oauth] provider falló: ${e.message}`);
    }
  }
  logger?.info?.(`[mcp-oauth] ${all.length} provider(s) registrados: ${all.join(', ') || '(ninguno)'}`);
  return all;
}

module.exports = { registerAll };
