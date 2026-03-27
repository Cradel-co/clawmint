'use strict';
const express = require('express');

module.exports = function createContactsRouter({ usersRepo }) {
  const router = express.Router();

  function getOwnerId(req) {
    return req.user?.internal ? null : req.user?.id;
  }

  // GET /contacts — listar (query: ?q=búsqueda&favorites=true)
  router.get('/', (req, res) => {
    const ownerId = getOwnerId(req);
    if (!ownerId) return res.status(401).json({ error: 'No autenticado' });

    let contacts;
    if (req.query.q) {
      contacts = usersRepo.searchContacts(ownerId, req.query.q);
    } else {
      contacts = usersRepo.listContacts(ownerId, { favoritesOnly: req.query.favorites === 'true' });
    }
    res.json(contacts);
  });

  // POST /contacts — crear
  router.post('/', (req, res) => {
    const ownerId = getOwnerId(req);
    if (!ownerId) return res.status(401).json({ error: 'No autenticado' });

    const { name, phone, email, notes, is_favorite, telegram_id, username } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name requerido' });

    let userId = null;
    if (telegram_id) {
      const u = usersRepo.findByIdentity('telegram', String(telegram_id));
      if (u) userId = u.id;
    }
    if (!userId && username) {
      const u = usersRepo.findByTelegramUsername(username);
      if (u) userId = u.id;
    }

    const contact = usersRepo.createContact(ownerId, {
      name,
      phone: phone || null,
      email: email || null,
      notes: notes || null,
      isFavorite: is_favorite === true || is_favorite === 'true',
      userId,
    });

    if (!contact) return res.status(500).json({ error: 'No se pudo crear el contacto' });
    res.status(201).json(contact);
  });

  // GET /contacts/:id — detalle
  router.get('/:id', (req, res) => {
    const ownerId = getOwnerId(req);
    if (!ownerId) return res.status(401).json({ error: 'No autenticado' });

    const contact = usersRepo.getContact(req.params.id);
    if (!contact || contact.owner_id !== ownerId) return res.status(404).json({ error: 'No encontrado' });

    // Enriquecer con info del usuario vinculado
    let linkedUser = null;
    if (contact.user_id) {
      const u = usersRepo.getById(contact.user_id);
      if (u) linkedUser = { id: u.id, name: u.name, identities: u.identities || [] };
    }

    res.json({ ...contact, linkedUser });
  });

  // PATCH /contacts/:id — actualizar
  router.patch('/:id', (req, res) => {
    const ownerId = getOwnerId(req);
    if (!ownerId) return res.status(401).json({ error: 'No autenticado' });

    const contact = usersRepo.getContact(req.params.id);
    if (!contact || String(contact.owner_id) !== String(ownerId)) return res.status(404).json({ error: 'No encontrado' });

    const fields = {};
    const { name, phone, email, notes, is_favorite } = req.body || {};
    if (name  !== undefined) fields.name        = name;
    if (phone !== undefined) fields.phone       = phone;
    if (email !== undefined) fields.email       = email;
    if (notes !== undefined) fields.notes       = notes;
    if (is_favorite !== undefined) fields.is_favorite = is_favorite === true || is_favorite === 'true';

    try {
      usersRepo.updateContact(req.params.id, fields);
      res.json(usersRepo.getContact(req.params.id));
    } catch (err) {
      res.status(500).json({ error: err.message || 'Error al actualizar contacto' });
    }
  });

  // DELETE /contacts/:id — eliminar
  router.delete('/:id', (req, res) => {
    const ownerId = getOwnerId(req);
    if (!ownerId) return res.status(401).json({ error: 'No autenticado' });

    const contact = usersRepo.getContact(req.params.id);
    if (!contact || contact.owner_id !== ownerId) return res.status(404).json({ error: 'No encontrado' });

    usersRepo.removeContact(req.params.id);
    res.json({ ok: true });
  });

  // POST /contacts/:id/link — vincular con usuario del sistema
  router.post('/:id/link', (req, res) => {
    const ownerId = getOwnerId(req);
    if (!ownerId) return res.status(401).json({ error: 'No autenticado' });

    const contact = usersRepo.getContact(req.params.id);
    if (!contact || contact.owner_id !== ownerId) return res.status(404).json({ error: 'No encontrado' });

    const { telegram_id, user_id, username } = req.body || {};
    let userId = user_id || null;

    if (!userId && telegram_id) {
      const u = usersRepo.findByIdentity('telegram', String(telegram_id));
      if (!u) return res.status(404).json({ error: `No hay usuario con Telegram ID ${telegram_id}` });
      userId = u.id;
    }

    if (!userId && username) {
      const u = usersRepo.findByTelegramUsername(username);
      if (!u) return res.status(404).json({ error: `No hay usuario con username ${username}` });
      userId = u.id;
    }

    if (!userId) return res.status(400).json({ error: 'Se requiere telegram_id, username o user_id' });

    usersRepo.updateContact(req.params.id, { user_id: userId });
    res.json(usersRepo.getContact(req.params.id));
  });

  return router;
};
