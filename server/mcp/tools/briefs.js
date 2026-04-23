'use strict';

/**
 * mcp/tools/briefs.js — agendas inteligentes que combinan múltiples tools
 * existentes en una sola call. Reduce tokens y latencia vs hacer 5 tool calls.
 *
 *   - day_summary     → clima del día + sol + feriado + reminders + tasks pendientes
 *   - morning_brief   → enfoque matinal: clima, sol, plan del día
 *   - bedtime_brief   → cierre del día + qué viene mañana
 *   - week_ahead      → forecast 7 días + reminders/tasks de la semana
 *
 * Estas tools NO hacen fetches HTTP ellas mismas (delegan a air_quality_get,
 * weather_get, sun_get, etc.), pero los ejecutan en paralelo desde el server.
 */

const https = require('https');
const { resolveUserId } = require('./user-sandbox');

function _getJson(url, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Clawmint/1.0', Accept: 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Respuesta no-JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function _resolveCoords(ctx) {
  if (ctx.userPreferencesRepo) {
    try {
      const userId = resolveUserId(ctx);
      if (userId) {
        const raw = ctx.userPreferencesRepo.get(userId, 'location');
        if (raw) {
          const u = JSON.parse(raw);
          if (u.latitude != null && u.longitude != null) return { lat: u.latitude, lon: u.longitude, name: u.name, source: 'user-preference' };
        }
      }
    } catch {}
  }
  if (ctx.locationService) {
    try {
      const loc = await ctx.locationService.getLocation({ includePublic: true });
      if (loc.resolved) return { lat: loc.resolved.latitude, lon: loc.resolved.longitude, name: loc.resolved.name, source: 'server-location' };
    } catch {}
  }
  return null;
}

function _resolveCountryCode(ctx) {
  if (ctx.locationService?._publicIpCache?.data?.countryCode) {
    return String(ctx.locationService._publicIpCache.data.countryCode).toUpperCase();
  }
  return 'AR';
}

async function _fetchWeatherDays(c, days = 1) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&current_weather=true&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max&timezone=auto&forecast_days=${days}`;
  return _getJson(url);
}

async function _fetchHolidays(country, year) {
  return _getJson(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
}

const WEATHER_CODES = {
  0: 'despejado', 1: 'casi despejado', 2: 'parcial nublado', 3: 'nublado',
  45: 'neblina', 48: 'neblina escarcha',
  51: 'llovizna ligera', 53: 'llovizna', 55: 'llovizna densa',
  61: 'lluvia ligera', 63: 'lluvia', 65: 'lluvia fuerte',
  71: 'nieve ligera', 73: 'nieve', 75: 'nieve fuerte',
  80: 'chubascos', 81: 'chubascos fuertes', 82: 'chubascos violentos',
  95: 'tormenta', 96: 'tormenta granizo', 99: 'tormenta intensa',
};

// Cálculo de sol nativo (idéntico al de environment.js)
function _sunTimes(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = Math.floor((date - new Date(Date.UTC(1970, 0, 1))) / 86400000) + 2440588;
  const n = d - 2451545.0009 - lon / 360;
  const J = 2451545.0009 + Math.round(n) + lon / 360;
  const M = (357.5291 + 0.98560028 * (J - 2451545)) % 360;
  const Mr = M * rad;
  const C = 1.9148 * Math.sin(Mr) + 0.02 * Math.sin(2 * Mr) + 0.0003 * Math.sin(3 * Mr);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const Jt = J + 0.0053 * Math.sin(Mr) - 0.0069 * Math.sin(2 * lambda * rad);
  const decl = Math.asin(Math.sin(lambda * rad) * Math.sin(23.45 * rad));
  const cosH = (Math.sin(-0.83 * rad) - Math.sin(lat * rad) * Math.sin(decl)) / (Math.cos(lat * rad) * Math.cos(decl));
  if (cosH > 1 || cosH < -1) return null;
  const H = Math.acos(cosH) / rad;
  const toDate = (j) => new Date((j - 2440588) * 86400000);
  return { sunrise: toDate(Jt - H / 360), sunset: toDate(Jt + H / 360) };
}

async function _gatherContext(ctx, opts = {}) {
  const { days = 1, includeReminders = true, includeTasks = true, includeHolidays = true } = opts;
  const coords = await _resolveCoords(ctx);
  const country = _resolveCountryCode(ctx);
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Paralelizar todo lo que sea I/O
  const promises = {
    weather:  coords ? _fetchWeatherDays(coords, days).catch(() => null) : Promise.resolve(null),
    holidays: includeHolidays ? _fetchHolidays(country, today.getUTCFullYear()).catch(() => []) : Promise.resolve([]),
  };
  const [weather, holidays] = await Promise.all([promises.weather, promises.holidays]);

  const sun = coords ? _sunTimes(today, coords.lat, coords.lon) : null;

  // Reminders del día (si hay reminders module disponible — lo pasamos por ctx)
  let todaysReminders = [];
  if (includeReminders && ctx.reminders && typeof ctx.reminders.listAll === 'function') {
    try {
      const all = ctx.reminders.listAll();
      const tomorrow = today.getTime() + 86400000;
      todaysReminders = all
        .filter(r => r.triggerAt && r.triggerAt < tomorrow)
        .map(r => ({ id: r.id, text: r.text, triggerAt: new Date(r.triggerAt).toISOString() }));
    } catch {}
  }

  // Tasks pendientes del user actual
  let pendingTasks = [];
  if (includeTasks && ctx.tasksRepo && typeof ctx.tasksRepo.list === 'function') {
    try {
      const userId = resolveUserId(ctx);
      const all = ctx.tasksRepo.list({ chat_id: ctx.chatId, user_id: userId });
      pendingTasks = (all || [])
        .filter(t => t.status !== 'done' && t.status !== 'cancelled')
        .slice(0, 10)
        .map(t => ({ id: t.id, title: t.title, status: t.status, due: t.due_at }));
    } catch {}
  }

  // Feriados del día
  const todaysHolidays = (holidays || []).filter(h => h.date === todayStr);

  return { coords, country, today, todayStr, weather, sun, holidays, todaysHolidays, todaysReminders, pendingTasks };
}

function _formatWeatherDay(weather, idx = 0) {
  if (!weather?.daily) return null;
  const d = weather.daily;
  return {
    date:      d.time?.[idx],
    weather:   WEATHER_CODES[d.weathercode?.[idx]] || `code ${d.weathercode?.[idx]}`,
    temp_max:  d.temperature_2m_max?.[idx],
    temp_min:  d.temperature_2m_min?.[idx],
    rain_prob: d.precipitation_probability_max?.[idx],
    uv_max:    d.uv_index_max?.[idx],
  };
}

// ── day_summary ────────────────────────────────────────────────────────────

const DAY_SUMMARY = {
  name: 'day_summary',
  description: 'Brief completo del día de hoy: ubicación, clima actual y forecast del día, amanecer/atardecer, feriados, recordatorios próximos, tareas pendientes. Una sola call para evitar 5 tool calls separados.',
  params: {},
  async execute(_args, ctx = {}) {
    const data = await _gatherContext(ctx, { days: 1 });
    const today = _formatWeatherDay(data.weather, 0);
    const cur = data.weather?.current_weather;
    return JSON.stringify({
      timestamp: data.today.toISOString(),
      location: data.coords ? { name: data.coords.name, source: data.coords.source } : null,
      country:  data.country,
      day_of_week: data.today.toLocaleDateString('es-ES', { weekday: 'long' }),
      is_holiday: data.todaysHolidays.length > 0,
      holidays_today: data.todaysHolidays.map(h => h.localName),
      weather: today ? {
        ...today,
        current_temp: cur?.temperature,
        current_wind: cur?.windspeed,
        current:      cur ? WEATHER_CODES[cur.weathercode] : null,
      } : null,
      sun: data.sun ? {
        sunrise_utc: data.sun.sunrise.toISOString(),
        sunset_utc:  data.sun.sunset.toISOString(),
        day_minutes: Math.round((data.sun.sunset - data.sun.sunrise) / 60000),
      } : null,
      reminders_today:  data.todaysReminders,
      pending_tasks:    data.pendingTasks,
    }, null, 2);
  },
};

// ── morning_brief ─────────────────────────────────────────────────────────

const MORNING_BRIEF = {
  name: 'morning_brief',
  description: 'Brief matinal en lenguaje natural — saludo, clima del día, sol, eventos, tareas. Devuelve un JSON con un texto sintético listo para leer al usuario apenas se levanta.',
  params: {},
  async execute(_args, ctx = {}) {
    const data = await _gatherContext(ctx, { days: 1 });
    const today = _formatWeatherDay(data.weather, 0);
    const cur = data.weather?.current_weather;
    const lines = [];
    const greeting = ['Buen día.', 'Buenos días.', '¡Buen día!'][Math.floor(Math.random() * 3)];
    lines.push(greeting);
    if (data.todaysHolidays.length) lines.push(`Hoy es ${data.todaysHolidays.map(h => h.localName).join(', ')} — feriado.`);
    if (today && cur) {
      lines.push(`Ahora hay ${Math.round(cur.temperature)}° y está ${WEATHER_CODES[cur.weathercode] || 'mixto'}.`);
      lines.push(`Hoy esperá entre ${Math.round(today.temp_min)}° y ${Math.round(today.temp_max)}°, con ${today.rain_prob}% de probabilidad de lluvia.`);
      if (today.uv_max >= 6) lines.push(`UV ${today.uv_max} (alto) — usá protector.`);
    }
    if (data.sun) {
      const sunset = data.sun.sunset.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
      lines.push(`El sol se va a las ${sunset} UTC.`);
    }
    if (data.todaysReminders.length) lines.push(`Tenés ${data.todaysReminders.length} recordatorio(s) hoy.`);
    if (data.pendingTasks.length) lines.push(`${data.pendingTasks.length} tarea(s) pendiente(s).`);
    return JSON.stringify({
      brief_text: lines.join(' '),
      data: {
        weather: today, current: cur, sun: data.sun,
        holidays: data.todaysHolidays.map(h => h.localName),
        reminders: data.todaysReminders, tasks: data.pendingTasks,
      },
    }, null, 2);
  },
};

// ── bedtime_brief ─────────────────────────────────────────────────────────

const BEDTIME_BRIEF = {
  name: 'bedtime_brief',
  description: 'Brief de cierre del día: cómo viene mañana (clima, eventos, primer reminder), si hay luna llena, recap rápido. Lenguaje natural.',
  params: {},
  async execute(_args, ctx = {}) {
    const data = await _gatherContext(ctx, { days: 2 });
    const tomorrow = _formatWeatherDay(data.weather, 1);
    const tomorrowDate = new Date(data.today.getTime() + 86400000);
    const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);
    const tomorrowHolidays = (data.holidays || []).filter(h => h.date === tomorrowStr);

    const lines = ['Buenas noches.'];
    if (tomorrow) {
      lines.push(`Mañana ${tomorrowDate.toLocaleDateString('es-ES', { weekday: 'long' })}: ${tomorrow.weather}, ${Math.round(tomorrow.temp_min)}°–${Math.round(tomorrow.temp_max)}°.`);
      if (tomorrow.rain_prob >= 50) lines.push(`Probabilidad de lluvia ${tomorrow.rain_prob}% — llevá paraguas.`);
    }
    if (tomorrowHolidays.length) lines.push(`Mañana es ${tomorrowHolidays.map(h => h.localName).join(', ')} — feriado.`);
    if (data.todaysReminders.length === 0 && data.pendingTasks.length === 0) {
      lines.push('Tu agenda está limpia.');
    } else if (data.pendingTasks.length) {
      lines.push(`Te quedan ${data.pendingTasks.length} tarea(s) pendiente(s).`);
    }
    lines.push('Que descanses.');
    return JSON.stringify({
      brief_text: lines.join(' '),
      data: { tomorrow, tomorrow_holidays: tomorrowHolidays.map(h => h.localName), pending_tasks: data.pendingTasks },
    }, null, 2);
  },
};

// ── week_ahead ────────────────────────────────────────────────────────────

const WEEK_AHEAD = {
  name: 'week_ahead',
  description: 'Forecast 7 días: clima diario + feriados de la semana + reminders/tasks que vencen en los próximos 7 días.',
  params: {},
  async execute(_args, ctx = {}) {
    const data = await _gatherContext(ctx, { days: 7 });
    const days = [];
    if (data.weather?.daily) {
      for (let i = 0; i < (data.weather.daily.time?.length || 0); i++) {
        days.push(_formatWeatherDay(data.weather, i));
      }
    }
    // Feriados próximos 7 días
    const nowMs = Date.now();
    const inWeek = nowMs + 7 * 86400000;
    const upcomingHolidays = (data.holidays || []).filter(h => {
      const t = new Date(h.date).getTime();
      return t >= nowMs && t < inWeek;
    }).map(h => ({ date: h.date, name: h.localName }));

    // Reminders próximos 7 días
    let weeklyReminders = [];
    if (ctx.reminders?.listAll) {
      try {
        weeklyReminders = ctx.reminders.listAll()
          .filter(r => r.triggerAt && r.triggerAt < inWeek && r.triggerAt >= nowMs)
          .map(r => ({ id: r.id, text: r.text, triggerAt: new Date(r.triggerAt).toISOString() }));
      } catch {}
    }
    return JSON.stringify({
      days,
      upcoming_holidays: upcomingHolidays,
      weekly_reminders:  weeklyReminders,
      pending_tasks:     data.pendingTasks,
      location:          data.coords ? { name: data.coords.name } : null,
    }, null, 2);
  },
};

module.exports = [DAY_SUMMARY, MORNING_BRIEF, BEDTIME_BRIEF, WEEK_AHEAD];
