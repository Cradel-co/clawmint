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

/**
 * Parsea duración tipo "10m", "2h", "1d", "30s", "1h30m"
 * @returns {number|null} milisegundos o null si no se pudo parsear
 */
function parseDuration(str) {
  const regex = /(\d+)\s*(s|seg|min|m|h|hs|d|dias?)/gi;
  let total = 0;
  let match;
  while ((match = regex.exec(str)) !== null) {
    const val = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit === 's' || unit === 'seg') total += val * 1000;
    else if (unit === 'm' || unit === 'min') total += val * 60 * 1000;
    else if (unit === 'h' || unit === 'hs') total += val * 3600 * 1000;
    else if (unit.startsWith('d')) total += val * 86400 * 1000;
  }
  return total > 0 ? total : null;
}

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

/**
 * Formatea milisegundos restantes a texto legible
 */
function formatRemaining(ms) {
  if (ms < 0) return 'vencido';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

// Cargar al importar
_load();

module.exports = { add, remove, listForChat, popTriggered, parseDuration, formatRemaining };
