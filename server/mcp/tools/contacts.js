'use strict';

/**
 * mcp/tools/contacts.js — Tools MCP para agenda de contactos.
 *
 * Expone: contact_add, contact_list, contact_info, contact_update, contact_delete, contact_link
 * Usa ctx.usersRepo (server/storage/UsersRepository.js).
 */

function _requireUsers(ctx) {
  if (!ctx.usersRepo) throw new Error('Módulo de usuarios no disponible');
}

function _getOwnerId(ctx) {
  if (ctx.userId) return ctx.userId;
  if (ctx.usersRepo && ctx.chatId && ctx.channel) {
    const user = ctx.usersRepo.findByIdentity(ctx.channel || 'telegram', String(ctx.chatId));
    if (user) return user.id;
  }
  return null;
}

const CONTACT_ADD = {
  name: 'contact_add',
  description: 'Agregar un contacto a la agenda. Si se pasa telegram_id, se vincula automáticamente con el usuario del sistema.',
  params: {
    name:        'string — nombre o alias del contacto',
    phone:       '?string — teléfono',
    email:       '?string — email',
    notes:       '?string — notas libres',
    is_favorite: '?string — "true" para marcarlo como favorito',
    telegram_id: '?string — chatId de Telegram del contacto (para vincular)',
  },

  execute(args = {}, ctx = {}) {
    _requireUsers(ctx);
    if (!args.name) return 'Error: parámetro name requerido';

    const ownerId = _getOwnerId(ctx);
    if (!ownerId) return 'Error: no se pudo identificar al usuario.';

    // Si se pasa telegram_id, buscar si el user ya existe en el sistema
    let userId = null;
    if (args.telegram_id) {
      const existingUser = ctx.usersRepo.findByIdentity('telegram', String(args.telegram_id));
      if (existingUser) userId = existingUser.id;
    }

    const contact = ctx.usersRepo.createContact(ownerId, {
      name:       args.name,
      phone:      args.phone || null,
      email:      args.email || null,
      notes:      args.notes || null,
      isFavorite: args.is_favorite === 'true',
      userId,
    });

    if (!contact) return 'Error: no se pudo crear el contacto.';

    const linked = userId ? ` (vinculado a usuario del sistema)` : '';
    return `✅ Contacto creado: ${contact.name} (ID: ${contact.id})${linked}`;
  },
};

const CONTACT_LIST = {
  name: 'contact_list',
  description: 'Lista los contactos de la agenda del usuario actual.',
  params: {
    favorites: '?string — "true" para ver solo favoritos',
    query:     '?string — buscar por nombre',
  },

  execute(args = {}, ctx = {}) {
    _requireUsers(ctx);
    const ownerId = _getOwnerId(ctx);
    if (!ownerId) return 'Error: no se pudo identificar al usuario.';

    let contacts;
    if (args.query) {
      contacts = ctx.usersRepo.searchContacts(ownerId, args.query);
    } else {
      contacts = ctx.usersRepo.listContacts(ownerId, { favoritesOnly: args.favorites === 'true' });
    }

    if (!contacts.length) return args.favorites === 'true' ? 'No tenés contactos favoritos.' : 'No tenés contactos en la agenda.';

    const lines = contacts.map(c => {
      const fav = c.is_favorite ? ' ⭐' : '';
      const linked = c.user_id ? ' 🔗' : '';
      const details = [c.phone, c.email].filter(Boolean).join(' | ');
      return `• ${c.name}${fav}${linked}${details ? ` — ${details}` : ''}\n  ID: ${c.id}`;
    });

    return `Contactos (${contacts.length}):\n\n${lines.join('\n\n')}`;
  },
};

const CONTACT_INFO = {
  name: 'contact_info',
  description: 'Detalle de un contacto por ID o nombre.',
  params: {
    id:   '?string — UUID del contacto',
    name: '?string — buscar por nombre',
  },

  execute(args = {}, ctx = {}) {
    _requireUsers(ctx);
    const ownerId = _getOwnerId(ctx);
    if (!ownerId) return 'Error: no se pudo identificar al usuario.';

    let contact = null;
    if (args.id) {
      contact = ctx.usersRepo.getContact(args.id);
    } else if (args.name) {
      const results = ctx.usersRepo.searchContacts(ownerId, args.name);
      contact = results[0] || null;
    }

    if (!contact) return 'Contacto no encontrado.';
    if (contact.owner_id !== ownerId) return 'Contacto no encontrado.';

    const lines = [
      `Nombre: ${contact.name}${contact.is_favorite ? ' ⭐' : ''}`,
      `ID: ${contact.id}`,
    ];
    if (contact.phone) lines.push(`Teléfono: ${contact.phone}`);
    if (contact.email) lines.push(`Email: ${contact.email}`);
    if (contact.notes) lines.push(`Notas: ${contact.notes}`);

    if (contact.user_id) {
      const user = ctx.usersRepo.getById(contact.user_id);
      if (user) {
        const channels = (user.identities || []).map(i => `${i.channel}:${i.identifier}`).join(', ');
        lines.push(`🔗 Usuario vinculado: ${user.name} (${channels})`);
      }
    } else {
      lines.push('No vinculado a usuario del sistema');
    }

    const created = new Date(contact.created_at).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`Creado: ${created}`);

    return lines.join('\n');
  },
};

const CONTACT_UPDATE = {
  name: 'contact_update',
  description: 'Modificar datos de un contacto existente.',
  params: {
    id:          'string — UUID del contacto',
    name:        '?string',
    phone:       '?string',
    email:       '?string',
    notes:       '?string',
    is_favorite: '?string — "true" o "false"',
  },

  execute(args = {}, ctx = {}) {
    _requireUsers(ctx);
    if (!args.id) return 'Error: parámetro id requerido';

    const fields = {};
    if (args.name)        fields.name = args.name;
    if (args.phone)       fields.phone = args.phone;
    if (args.email)       fields.email = args.email;
    if (args.notes)       fields.notes = args.notes;
    if (args.is_favorite !== undefined) fields.is_favorite = args.is_favorite === 'true';

    const ok = ctx.usersRepo.updateContact(args.id, fields);
    return ok ? `✅ Contacto actualizado: ${args.id}` : 'Error: contacto no encontrado.';
  },
};

const CONTACT_DELETE = {
  name: 'contact_delete',
  description: 'Eliminar un contacto de la agenda.',
  params: {
    id: 'string — UUID del contacto',
  },

  execute(args = {}, ctx = {}) {
    _requireUsers(ctx);
    if (!args.id) return 'Error: parámetro id requerido';
    const ok = ctx.usersRepo.removeContact(args.id);
    return ok ? `✅ Contacto eliminado: ${args.id}` : 'Error: contacto no encontrado.';
  },
};

const CONTACT_LINK = {
  name: 'contact_link',
  description: 'Vincular un contacto con un usuario del sistema. Permite que el contacto reciba mensajes programados.',
  params: {
    id:          'string — UUID del contacto',
    telegram_id: '?string — chatId de Telegram del usuario a vincular',
    user_id:     '?string — UUID del usuario del sistema',
    user_name:   '?string — nombre del usuario a buscar',
  },

  execute(args = {}, ctx = {}) {
    _requireUsers(ctx);
    if (!args.id) return 'Error: parámetro id requerido';

    const contact = ctx.usersRepo.getContact(args.id);
    if (!contact) return 'Error: contacto no encontrado.';

    let userId = args.user_id || null;

    if (!userId && args.telegram_id) {
      const user = ctx.usersRepo.findByIdentity('telegram', String(args.telegram_id));
      if (user) userId = user.id;
      else return `No se encontró usuario con Telegram ID ${args.telegram_id}. El usuario debe escribir al bot primero (y estar en la whitelist).`;
    }

    if (!userId && args.user_name) {
      const results = ctx.usersRepo.searchByName(args.user_name);
      if (results.length === 1) userId = results[0].id;
      else if (results.length > 1) return `Múltiples usuarios encontrados para "${args.user_name}". Usá user_id para especificar.`;
      else return `No se encontró usuario con nombre "${args.user_name}".`;
    }

    if (!userId) return 'Error: proporcioná telegram_id, user_id o user_name para vincular.';

    ctx.usersRepo.updateContact(args.id, { user_id: userId });
    const user = ctx.usersRepo.getById(userId);
    return `✅ Contacto "${contact.name}" vinculado a usuario "${user?.name || userId}"`;
  },
};

module.exports = [CONTACT_ADD, CONTACT_LIST, CONTACT_INFO, CONTACT_UPDATE, CONTACT_DELETE, CONTACT_LINK];
