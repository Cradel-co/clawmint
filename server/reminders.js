'use strict';

const fs = require('fs');
const path = require('path');

const REMINDERS_FILE = path.join(__dirname, 'reminders.json');

/** @type {Array<{id: string, chatId: number, botKey: string, text: string, createdAt: number, triggerAt: number}>} */
let reminders = [];

function _load() {
  try {
    if (fs.existsSync(REMINDERS_FILE)) {
      reminders = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8')) || [];
    }
  } catch { reminders = []; }
}

function _save() {
  try {
    fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2), 'utf8');
  } catch (err) {
    console.error('[Reminders] No se pudo guardar:', err.message);
  }
}

// parseDuration y formatRemaining extraídos a utils/duration.js
const { parseDuration, formatRemaining: _formatRemaining } = require('./utils/duration');

/**
 * Agrega un recordatorio
 * @returns {object} el recordatorio creado
 */
function add(chatId, botKey, text, durationMs) {
  const now = Date.now();
  const reminder = {
    id: now.toString(36) + Math.random().toString(36).slice(2, 6),
    chatId,
    botKey,
    text,
    createdAt: now,
    triggerAt: now + durationMs,
  };
  reminders.push(reminder);
  _save();
  return reminder;
}

/**
 * Devuelve recordatorios pendientes de un chat
 */
function listForChat(chatId) {
  return reminders.filter(r => r.chatId === chatId && r.triggerAt > Date.now());
}

/**
 * Elimina un recordatorio por id
 */
function remove(id) {
  const idx = reminders.findIndex(r => r.id === id);
  if (idx === -1) return false;
  reminders.splice(idx, 1);
  _save();
  return true;
}

/**
 * Devuelve y elimina recordatorios vencidos
 */
function popTriggered() {
  const now = Date.now();
  const triggered = reminders.filter(r => r.triggerAt <= now);
  if (triggered.length > 0) {
    reminders = reminders.filter(r => r.triggerAt > now);
    _save();
  }
  return triggered;
}

const formatRemaining = _formatRemaining;

// Cargar al importar
_load();

function listAll() {
  return reminders.filter(r => r.triggerAt > Date.now());
}

module.exports = { add, remove, listForChat, listAll, popTriggered, parseDuration, formatRemaining };
