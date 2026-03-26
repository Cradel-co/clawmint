'use strict';

/**
 * utils/duration.js — Parseo y formateo de duraciones.
 *
 * Extraído de reminders.js para reutilización en scheduled actions, etc.
 */

/**
 * Parsea duración tipo "10m", "2h", "1d", "30s", "1h30m"
 * @param {string} str
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
 * Formatea milisegundos restantes a texto legible
 * @param {number} ms
 * @returns {string}
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

module.exports = { parseDuration, formatRemaining };
