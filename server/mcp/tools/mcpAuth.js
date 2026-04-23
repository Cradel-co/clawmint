'use strict';

/**
 * mcp/tools/mcpAuth.js — tools para manejar OAuth de MCPs externos (Fase 11.1).
 *
 * - `mcp_authenticate(server)` — dispara el flow de auth (emite evento mcp:auth_required).
 * - `mcp_complete_authentication(server, token)` — persiste el token cifrado.
 * - `mcp_list_authenticated` — lista MCPs autenticados para el usuario actual.
 */

const { resolveUserId } = require('./user-sandbox');

const AUTHENTICATE = {
  name: 'mcp_authenticate',
  description: 'Inicia el flow de OAuth para un MCP externo. Retorna la URL de auth — el usuario debe visitarla y pegar el token/code con mcp_complete_authentication.',
  params: {
    server:  'string',
    auth_url: '?string',
  },
  execute(args = {}, ctx = {}) {
    if (!ctx.mcpAuthService) return 'Error: mcpAuthService no disponible';
    if (!args.server) return 'Error: server requerido';

    const userId = resolveUserId(ctx);
    if (!userId) return 'Error: no se pudo resolver userId';

    // Si ya hay token, informar
    if (ctx.mcpAuthService.hasToken(args.server, userId)) {
      return `Ya hay un token registrado para ${args.server}. Usá mcp_complete_authentication con un nuevo token si querés re-autenticar.`;
    }

    // Si no se pasa auth_url, se emite evento para que el caller lo provea.
    // Para MCPs standard-compliant, la URL viene en el error de la conexión.
    const authUrl = args.auth_url || `(el server MCP debería proveer la URL en su error de auth)`;
    ctx.mcpAuthService.requireAuth({
      mcp_name: args.server,
      user_id: userId,
      auth_url: authUrl,
      chatId: ctx.chatId,
    });

    return [
      `Flow de autenticación iniciado para "${args.server}".`,
      `1. Visitá la URL de auth: ${authUrl}`,
      `2. Copiá el token/code del proveedor.`,
      `3. Llamá mcp_complete_authentication(server="${args.server}", token="<paste>").`,
    ].join('\n');
  },
};

const COMPLETE = {
  name: 'mcp_complete_authentication',
  description: 'Completa el flow OAuth persistiendo el token recibido del proveedor. El token se cifra antes de guardar.',
  params: {
    server: 'string',
    token:  'string',
    expires_in: '?number',     // segundos hasta expirar (opcional)
    token_type: '?string',
  },
  execute(args = {}, ctx = {}) {
    if (!ctx.mcpAuthService) return 'Error: mcpAuthService no disponible';
    if (!args.server) return 'Error: server requerido';
    if (!args.token)  return 'Error: token requerido';

    const userId = resolveUserId(ctx);
    if (!userId) return 'Error: no se pudo resolver userId';

    const expires_at = args.expires_in ? Date.now() + (Number(args.expires_in) * 1000) : null;

    try {
      ctx.mcpAuthService.saveToken({
        mcp_name:   args.server,
        user_id:    userId,
        token:      String(args.token),
        token_type: args.token_type || 'bearer',
        expires_at,
      });
      return `Token persistido para "${args.server}".${expires_at ? ' Expira: ' + new Date(expires_at).toISOString() : ''}`;
    } catch (err) {
      return `Error persistiendo token: ${err.message}`;
    }
  },
};

const LIST = {
  name: 'mcp_list_authenticated',
  description: 'Lista los MCPs externos autenticados para el usuario actual. NO devuelve los tokens — solo metadata.',
  params: {},
  execute(_args = {}, ctx = {}) {
    if (!ctx.mcpAuthService) return 'Error: mcpAuthService no disponible';
    const userId = resolveUserId(ctx);
    if (!userId) return 'Error: no se pudo resolver userId';

    const rows = ctx.mcpAuthService.listByUser(userId);
    if (!rows.length) return '(sin MCPs autenticados)';
    return rows.map(r => {
      const exp = r.expires_at ? ` (expira ${new Date(r.expires_at).toISOString()})` : '';
      return `- ${r.mcp_name} [${r.token_type}]${exp}`;
    }).join('\n');
  },
};

module.exports = [AUTHENTICATE, COMPLETE, LIST];
