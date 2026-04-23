'use strict';

/**
 * mcp/tools/environment.js — tools de info del entorno (free, sin API key).
 *
 *   - air_quality_get    → AQI, PM2.5, PM10, ozone via Open-Meteo Air Quality
 *   - sun_get            → amanecer/atardecer/duración del día (cálculo nativo)
 *   - moon_phase         → fase actual + nombre (cálculo nativo, sin API)
 *   - uv_index_get       → índice UV actual y máximo del día
 *   - holiday_check      → ¿es feriado hoy? (date.nager.at, free)
 *   - is_weekend         → bool simple
 *
 * Todas resuelven coords automáticamente desde user_location_save → server location
 * → fallback args. Mismo patrón que weather_get.
 */

const https = require('https');
const { resolveUserId } = require('./user-sandbox');

// ── Helpers ─────────────────────────────────────────────────────────────────

function _getJson(url, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Clawmint/1.0', ...headers } }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) return reject(new Error(json.error || json.reason || `HTTP ${res.statusCode}`));
          resolve(json);
        } catch { reject(new Error(`Respuesta no-JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/** Resuelve coordenadas (args > user pref > server location). */
async function _resolveCoords(args, ctx) {
  if (args.latitude != null && args.longitude != null) {
    return { lat: Number(args.latitude), lon: Number(args.longitude), source: 'args' };
  }
  if (ctx.userPreferencesRepo) {
    try {
      const userId = resolveUserId(ctx);
      if (userId) {
        const raw = ctx.userPreferencesRepo.get(userId, 'location');
        if (raw) {
          const u = JSON.parse(raw);
          if (u.latitude != null && u.longitude != null) {
            return { lat: u.latitude, lon: u.longitude, source: 'user-preference' };
          }
        }
      }
    } catch {}
  }
  if (ctx.locationService) {
    try {
      const loc = await ctx.locationService.getLocation({ includePublic: true });
      if (loc.resolved) return { lat: loc.resolved.latitude, lon: loc.resolved.longitude, source: 'server-location' };
    } catch {}
  }
  return null;
}

function _resolveCountryCode(args, ctx) {
  if (args.country) return String(args.country).toUpperCase();
  // Intentar derivar del server.public.countryCode
  if (ctx.locationService?._publicIpCache?.data?.countryCode) {
    return String(ctx.locationService._publicIpCache.data.countryCode).toUpperCase();
  }
  return 'AR'; // fallback
}

// ── air_quality_get ────────────────────────────────────────────────────────

const AIR_QUALITY_GET = {
  name: 'air_quality_get',
  description: 'Calidad del aire (índice AQI europeo + PM2.5, PM10, ozono, NO2, SO2, CO) para una ubicación. Si no pasás coords usa la del usuario o del server. Open-Meteo Air Quality, free sin key.',
  params: { latitude: '?number', longitude: '?number' },
  async execute(args = {}, ctx = {}) {
    const c = await _resolveCoords(args, ctx);
    if (!c) return JSON.stringify({ error: 'No se pudo determinar ubicación. Pasá latitude/longitude o configurá la del usuario.' });
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${c.lat}&longitude=${c.lon}&current=european_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone&timezone=auto`;
    try {
      const data = await _getJson(url);
      const cur = data.current || {};
      const aqi = cur.european_aqi;
      let label = 'desconocido';
      if (aqi != null) {
        if (aqi <= 20) label = 'muy buena';
        else if (aqi <= 40) label = 'buena';
        else if (aqi <= 60) label = 'moderada';
        else if (aqi <= 80) label = 'pobre';
        else if (aqi <= 100) label = 'muy pobre';
        else label = 'extremadamente pobre';
      }
      return JSON.stringify({
        location:  { latitude: c.lat, longitude: c.lon, source: c.source },
        aqi:       { value: aqi, label, scale: 'European AQI (0=excelente, 100+=peligroso)' },
        pollutants: {
          pm2_5_ugm3: cur.pm2_5,
          pm10_ugm3:  cur.pm10,
          o3_ugm3:    cur.ozone,
          no2_ugm3:   cur.nitrogen_dioxide,
          so2_ugm3:   cur.sulphur_dioxide,
          co_ugm3:    cur.carbon_monoxide,
        },
        time: cur.time,
      }, null, 2);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  },
};

// ── sun_get (cálculo nativo, sin API) ──────────────────────────────────────

function _sunTimes(date, lat, lon) {
  // Fórmula NOAA simplificada — precisión ±1 min, suficiente para asistente.
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
  if (cosH > 1)  return { sunrise: null, sunset: null, polar: 'night' };
  if (cosH < -1) return { sunrise: null, sunset: null, polar: 'day' };
  const H = Math.acos(cosH) / rad;
  const Jset  = Jt + H / 360;
  const Jrise = Jt - H / 360;
  const toDate = (j) => new Date((j - 2440588) * 86400000);
  return { sunrise: toDate(Jrise), sunset: toDate(Jset) };
}

const SUN_GET = {
  name: 'sun_get',
  description: 'Horarios de amanecer y atardecer + duración del día para una ubicación y fecha. Cálculo nativo sin API. Default: hoy + ubicación del user/server.',
  params: { latitude: '?number', longitude: '?number', date: '?string' /* YYYY-MM-DD */ },
  async execute(args = {}, ctx = {}) {
    const c = await _resolveCoords(args, ctx);
    if (!c) return JSON.stringify({ error: 'No se pudo determinar ubicación.' });
    const date = args.date ? new Date(args.date + 'T12:00:00Z') : new Date();
    const t = _sunTimes(date, c.lat, c.lon);
    if (!t.sunrise || !t.sunset) {
      return JSON.stringify({ location: c, date: date.toISOString().slice(0, 10), polar: t.polar, message: t.polar === 'day' ? 'Sol todo el día (latitud polar)' : 'Noche todo el día (latitud polar)' });
    }
    const duration = (t.sunset - t.sunrise) / 60000;
    const fmt = (d) => d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
    return JSON.stringify({
      location: c,
      date:     date.toISOString().slice(0, 10),
      sunrise_utc: t.sunrise.toISOString(),
      sunset_utc:  t.sunset.toISOString(),
      sunrise_local_hint: fmt(t.sunrise),
      sunset_local_hint:  fmt(t.sunset),
      day_length_minutes: Math.round(duration),
      day_length_hours:   (duration / 60).toFixed(2),
    }, null, 2);
  },
};

// ── moon_phase (cálculo nativo) ────────────────────────────────────────────

function _moonPhase(date) {
  // Days since known new moon (Jan 6, 2000 18:14 UTC)
  const synodic = 29.530588853;
  const ref = Date.UTC(2000, 0, 6, 18, 14, 0);
  const days = (date.getTime() - ref) / 86400000;
  const phase = ((days % synodic) + synodic) % synodic;
  const fraction = phase / synodic;
  const illumination = Math.round((1 - Math.cos(fraction * 2 * Math.PI)) / 2 * 100);
  let name;
  if (fraction < 0.03 || fraction > 0.97) name = 'luna nueva';
  else if (fraction < 0.22)               name = 'creciente iluminante';
  else if (fraction < 0.28)               name = 'cuarto creciente';
  else if (fraction < 0.47)               name = 'gibosa creciente';
  else if (fraction < 0.53)               name = 'luna llena';
  else if (fraction < 0.72)               name = 'gibosa menguante';
  else if (fraction < 0.78)               name = 'cuarto menguante';
  else                                    name = 'menguante';
  return { name, illumination_pct: illumination, age_days: phase.toFixed(1) };
}

const MOON_PHASE = {
  name: 'moon_phase',
  description: 'Fase lunar para una fecha. Sin API key, cálculo astronómico simplificado. Devuelve nombre (luna nueva/llena/gibosa/etc.) + porcentaje de iluminación + días de edad.',
  params: { date: '?string' /* YYYY-MM-DD */ },
  execute(args = {}) {
    const date = args.date ? new Date(args.date + 'T12:00:00Z') : new Date();
    return JSON.stringify({ date: date.toISOString().slice(0, 10), ..._moonPhase(date) }, null, 2);
  },
};

// ── uv_index_get ───────────────────────────────────────────────────────────

const UV_INDEX_GET = {
  name: 'uv_index_get',
  description: 'Índice UV actual y máximo del día. Útil para recomendar protector solar. Open-Meteo, free sin key.',
  params: { latitude: '?number', longitude: '?number' },
  async execute(args = {}, ctx = {}) {
    const c = await _resolveCoords(args, ctx);
    if (!c) return JSON.stringify({ error: 'No se pudo determinar ubicación.' });
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&current=uv_index&daily=uv_index_max&timezone=auto&forecast_days=1`;
    try {
      const data = await _getJson(url);
      const cur = data.current?.uv_index;
      const max = data.daily?.uv_index_max?.[0];
      let label = (v) => {
        if (v == null) return null;
        if (v < 3)  return 'bajo';
        if (v < 6)  return 'moderado';
        if (v < 8)  return 'alto';
        if (v < 11) return 'muy alto';
        return 'extremo';
      };
      return JSON.stringify({
        location: c,
        current_uv:  cur,
        current_label: label(cur),
        max_today:   max,
        max_label:   label(max),
        recommendation: max >= 6 ? 'Usar protector solar SPF 30+, gorra, anteojos.' : 'Riesgo bajo, exposición moderada OK.',
      }, null, 2);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  },
};

// ── holiday_check ──────────────────────────────────────────────────────────

const HOLIDAY_CHECK = {
  name: 'holiday_check',
  description: 'Verifica si una fecha es feriado nacional. Default: hoy + país del user (derivado de la IP pública del server). Pasá `country` con código ISO-3166 alpha-2 (AR, ES, US, etc.) para forzar.',
  params: { country: '?string', date: '?string' /* YYYY-MM-DD */ },
  async execute(args = {}, ctx = {}) {
    const cc = _resolveCountryCode(args, ctx);
    const date = args.date ? new Date(args.date) : new Date();
    const year = date.getUTCFullYear();
    const dateStr = date.toISOString().slice(0, 10);
    try {
      const data = await _getJson(`https://date.nager.at/api/v3/PublicHolidays/${year}/${cc}`);
      const hits = (data || []).filter(h => h.date === dateStr);
      return JSON.stringify({
        country: cc,
        date: dateStr,
        is_holiday: hits.length > 0,
        holidays: hits.map(h => ({ name: h.localName, name_en: h.name, type: h.types?.join(',') })),
        all_year_count: data.length,
      }, null, 2);
    } catch (err) {
      return JSON.stringify({ error: err.message, country: cc });
    }
  },
};

// ── is_weekend ─────────────────────────────────────────────────────────────

const IS_WEEKEND = {
  name: 'is_weekend',
  description: 'Devuelve si una fecha es fin de semana (sábado o domingo). Default: hoy.',
  params: { date: '?string' /* YYYY-MM-DD */ },
  execute(args = {}) {
    const date = args.date ? new Date(args.date) : new Date();
    const day = date.getUTCDay();
    const names = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    return JSON.stringify({
      date: date.toISOString().slice(0, 10),
      day_name: names[day],
      is_weekend: day === 0 || day === 6,
    });
  },
};

module.exports = [AIR_QUALITY_GET, SUN_GET, MOON_PHASE, UV_INDEX_GET, HOLIDAY_CHECK, IS_WEEKEND];
module.exports._internal = { _resolveCoords, _moonPhase, _sunTimes };
