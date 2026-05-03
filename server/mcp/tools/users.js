'use strict';

/**
 * mcp/tools/users.js — Tools MCP para gestión de usuarios.
 *
 * Expone: user_list, user_info, user_link
 * Usa ctx.usersRepo (server/storage/UsersRepository.js).
 * Non-admins solo pueden ver su propia info.
 */

const { isAdmin, resolveUserId } = require('./user-sandbox');

function _requireUsers(ctx) {
  if (!ctx.usersRepo) throw new Error('Módulo de usuarios no disponible');
}

const USER_LIST = {
  name: 'user_list',
  description: 'Lista todos los usuarios registrados con sus canales vinculados (Telegram, WebChat, P2P). Útil para saber a quién enviar mensajes o programar acciones.',
  params: {
    query: '?string — filtrar por nombre (búsqueda parcial)',
  },

  execute(args = {}, ctx = {}) {
    _requireUsers(ctx);

    // Non-admins solo ven su propia info
    if (!isAdmin(ctx)) {
      const userId = resolveUserId(ctx);
      if (!userId) return 'Error: no se pudo identificar al usuario.';
      const user = ctx.usersRepo.getById(userId);
      if (!user) return 'Usuario no encontrado.';
      const channels = (user.identities || []).map(i => {
        const meta = i.metadata && typeof i.metadata === 'object' ? i.metadata : {};
        const label = meta.username ? `@${meta.username}` : i.identifier;
        return `${i.channel}:${label}`;
      }).join(', ');
      return `Tu usuario:\n• ${user.name} [${user.role}] — id:${user.id}\n  Canales: ${channels || 'ninguno'}`;
    }

    const users = args.query
      ? ctx.usersRepo.searchByName(args.query)
      : ctx.usersRepo.listAll();

    if (!users.length) return 'No hay usuarios registrados.';

    const lines = users.map(u => {
      const channels = (u.identities || []).map(i => {
        const meta = i.metadata && typeof i.metadata === 'object' ? i.metadata : {};
        const label = meta.username ? `@${meta.username}` : i.identifier;
        return `${i.channel}:${label}${i.bot_key ? ` (bot:${i.bot_key})` : ''}`;
      }).join(', ');
      return `• ${u.name} [${u.role}] — id:${u.id}\n  Canales: ${channels || 'ninguno'}`;
    });

    return `Usuarios (${users.length}):\n\n${lines.join('\n\n')}`;
  },
};

const USER_INFO = {
  name: 'user_info',
  description: 'Obtiene información detallada de un usuario por ID o nombre.',
  params: {
    id:   '?string — UUID del usuario',
    name: '?string — nombre del usuario (búsqueda parcial)',
  },

  execute(args = {}, ctx = {}) {
    _requireUsers(ctx);

    // Non-admins solo pueden ver su propia info
    if (!isAdmin(ctx)) {
      const userId = resolveUserId(ctx);
      if (!userId) return 'Error: no se pudo identificar al usuario.';
      args.id = userId; // Forzar a su propio ID
    }

    let user = null;
    if (args.id) {
      user = ctx.usersRepo.getById(args.id);
    } else if (args.name) {
      const results = ctx.usersRepo.searchByName(args.name);
      user = results[0] || null;
    }

    if (!user) return 'Usuario no encontrado.';

    const identities = (user.identities || []).map(i => {
      const meta = i.metadata && typeof i.metadata === 'object' ? i.metadata : {};
      return `  - ${i.channel}: ${i.identifier}${i.bot_key ? ` (bot:${i.bot_key})` : ''}${meta.username ? ` @${meta.username}` : ''}`;
    }).join('\n');

    const created = new Date(user.created_at).toISOString().slice(0, 16).replace('T', ' ');

    return [
      `Usuario: ${user.name}`,
      `ID: ${user.id}`,
      `Rol: ${user.role}`,
      `Creado: ${created}`,
      `Identidades:\n${identities || '  (ninguna)'}`,
    ].join('\n');
  },
};

const USER_LINK = {
  name: 'user_link',
  description: 'Vincula una identidad de canal a un usuario existente. Por ejemplo, vincular un chatId de Telegram a un usuario que ya existe por WebChat.',
  params: {
    user_id:    'string — UUID del usuario',
    channel:    'string — canal: telegram, web, p2p',
    identifier: 'string — chatId, sessionId o peerId',
    bot_key:    '?string — key del bot (para telegram)',
  },

  execute(args = {}, ctx = {}) {
    _requireUsers(ctx);
    if (!isAdmin(ctx)) return 'Error: solo administradores pueden vincular identidades.';
    if (!args.user_id) return 'Error: parámetro user_id requerido';
    if (!args.channel) return 'Error: parámetro channel requerido';
    if (!args.identifier) return 'Error: parámetro identifier requerido';

    const user = ctx.usersRepo.getById(args.user_id);
    if (!user) return `Usuario no encontrado: ${args.user_id}`;

    const ok = ctx.usersRepo.linkIdentity(args.user_id, args.channel, args.identifier, args.bot_key || null);
    if (!ok) return 'Error al vincular identidad.';

    return `Identidad vinculada: ${args.channel}:${args.identifier} → ${user.name} (${user.id})`;
  },
};

module.exports = [USER_LIST, USER_INFO, USER_LINK];
