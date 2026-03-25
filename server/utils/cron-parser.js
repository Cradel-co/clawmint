'use strict';

/**
 * cron-parser.js — Parser de expresiones cron de 5 campos.
 *
 * Campos: minuto hora día-del-mes mes día-de-la-semana
 * Soporte: números, *, rangos (1-5), listas (1,3,5), pasos (asterisco/15)
 * Timezone vía Intl.DateTimeFormat (nativo Node 22+).
 */

// Parsea un campo cron a un Set de valores válidos.
// field: campo cron (ej: "* /15", "1-5", "1,3,5", "*")
// min/max: rango válido (0-59 para minuto, 1-12 para mes)
function _parseField(field, min, max) {
  const values = new Set();

  for (const part of field.split(',')) {
    const trimmed = part.trim();

    // */step o min-max/step
    if (trimmed.includes('/')) {
      const [range, stepStr] = trimmed.split('/');
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) continue;

      let start = min, end = max;
      if (range !== '*') {
        const [s, e] = range.split('-').map(Number);
        start = isNaN(s) ? min : s;
        end = isNaN(e) ? max : e;
      }
      for (let i = start; i <= end; i += step) values.add(i);
    }
    // rango: 1-5
    else if (trimmed.includes('-')) {
      const [s, e] = trimmed.split('-').map(Number);
      if (isNaN(s) || isNaN(e)) continue;
      for (let i = Math.max(s, min); i <= Math.min(e, max); i++) values.add(i);
    }
    // wildcard
    else if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i);
    }
    // número exacto
    else {
      const n = parseInt(trimmed, 10);
      if (!isNaN(n) && n >= min && n <= max) values.add(n);
    }
  }

  return values;
}

/**
 * Obtiene los componentes de fecha en una timezone específica.
 */
function _getDateParts(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(date)) {
    parts[type] = parseInt(value, 10);
  }
  return {
    year:   parts.year,
    month:  parts.month,
    day:    parts.day,
    hour:   parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    dow:    new Date(date).getDay(), // 0=domingo
  };
}

/**
 * Crea un Date en una timezone específica.
 */
function _makeDate(year, month, day, hour, minute, timezone) {
  // Crear fecha en UTC y ajustar por offset de la timezone
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const parts = _getDateParts(guess, timezone);

  // Calcular diferencia y ajustar
  const diffMin = (parts.hour * 60 + parts.minute) - (hour * 60 + minute);
  const diffDay = parts.day - day;

  let adjustMs = -diffMin * 60000;
  if (diffDay !== 0) {
    adjustMs -= diffDay * 86400000;
  }

  return new Date(guess.getTime() + adjustMs);
}

/**
 * Calcula la próxima ejecución para una expresión cron.
 * @param {string} cronExpr — expresión cron de 5 campos
 * @param {Date} [fromDate] — fecha de referencia (default: now)
 * @param {string} [timezone] — timezone IANA
 * @returns {Date|null} — próxima ejecución o null si no se encuentra en 2 años
 */
function getNextRun(cronExpr, fromDate = new Date(), timezone = 'America/Argentina/Buenos_Aires') {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minutes  = _parseField(fields[0], 0, 59);
  const hours    = _parseField(fields[1], 0, 23);
  const doms     = _parseField(fields[2], 1, 31);
  const months   = _parseField(fields[3], 1, 12);
  const dows     = _parseField(fields[4], 0, 6);

  // Si algún campo está vacío, la expresión es inválida
  if (!minutes.size || !hours.size || !doms.size || !months.size || !dows.size) return null;

  const domIsWild = fields[2] === '*';
  const dowIsWild = fields[4] === '*';

  // Empezar desde el minuto siguiente
  let current = new Date(fromDate.getTime() + 60000);
  current.setSeconds(0, 0);

  const maxIterations = 366 * 24 * 60; // ~2 años en minutos (safety limit)

  for (let i = 0; i < maxIterations; i++) {
    const p = _getDateParts(current, timezone);

    // Saltar meses que no aplican
    if (!months.has(p.month)) {
      // Avanzar al primer día del siguiente mes
      current = _makeDate(p.year, p.month + 1, 1, 0, 0, timezone);
      continue;
    }

    // Verificar día: si ambos dom y dow están restringidos, basta con que uno matchee (comportamiento cron estándar)
    const domMatch = doms.has(p.day);
    const dowMatch = dows.has(p.dow);

    let dayOk;
    if (domIsWild && dowIsWild) dayOk = true;
    else if (domIsWild) dayOk = dowMatch;
    else if (dowIsWild) dayOk = domMatch;
    else dayOk = domMatch || dowMatch; // OR: comportamiento cron estándar

    if (!dayOk) {
      // Avanzar al siguiente día
      current = _makeDate(p.year, p.month, p.day + 1, 0, 0, timezone);
      continue;
    }

    if (!hours.has(p.hour)) {
      // Avanzar a la siguiente hora
      current = new Date(current.getTime() + (60 - p.minute) * 60000);
      continue;
    }

    if (!minutes.has(p.minute)) {
      current = new Date(current.getTime() + 60000);
      continue;
    }

    // Match completo
    return current;
  }

  return null;
}

/**
 * Valida una expresión cron.
 */
function isValid(cronExpr) {
  if (!cronExpr || typeof cronExpr !== 'string') return false;
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  for (let i = 0; i < 5; i++) {
    const parsed = _parseField(fields[i], ranges[i][0], ranges[i][1]);
    if (!parsed.size) return false;
  }
  return true;
}

/**
 * Describe una expresión cron en español legible.
 */
function describe(cronExpr) {
  if (!isValid(cronExpr)) return 'expresión cron inválida';

  const fields = cronExpr.trim().split(/\s+/);
  const [min, hour, dom, month, dow] = fields;

  const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const monthNames = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  const parts = [];

  // Hora
  if (min !== '*' && hour !== '*') {
    const h = hour.padStart(2, '0');
    const m = min.padStart(2, '0');
    parts.push(`a las ${h}:${m}`);
  } else if (min.startsWith('*/')) {
    parts.push(`cada ${min.slice(2)} minutos`);
  } else if (hour.startsWith('*/')) {
    parts.push(`cada ${hour.slice(2)} horas`);
  }

  // Día de la semana
  if (dow !== '*') {
    if (dow === '1-5') {
      parts.push('de lunes a viernes');
    } else if (dow === '0,6') {
      parts.push('fines de semana');
    } else {
      const days = _parseField(dow, 0, 6);
      parts.push([...days].map(d => dayNames[d]).join(', '));
    }
  }

  // Día del mes
  if (dom !== '*') {
    parts.push(`día ${dom}`);
  }

  // Mes
  if (month !== '*') {
    const ms = _parseField(month, 1, 12);
    parts.push([...ms].map(m => monthNames[m]).join(', '));
  }

  // Default
  if (dom === '*' && dow === '*' && month === '*') {
    parts.unshift('todos los días');
  }

  return parts.join(' ') || cronExpr;
}

module.exports = { getNextRun, isValid, describe, _parseField };
