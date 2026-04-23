'use strict';

/**
 * mcp/tools/location.js — tools de información del server y ubicación.
 *
 * Tools expuestas (visibles a todos los agentes):
 *   - server_info     → hostname, plataforma, uptime, versión node
 *   - server_location → IPs LAN, Tailscale, IP pública + geo, override manual
 *   - weather_get     → clima actual + forecast usando Open-Meteo (defaultea
 *                        a la ubicación del server si no se pasan coords)
 *
 * No requieren admin: información que el agente puede usar para responder
 * preguntas como "¿qué clima hace?" o "¿cuál es la IP del server?".
 *
 * Ctx requerido:
 *   - locationService — instancia de LocationService
 *
 * weather_get hace fetch directo a api.open-meteo.com (no requiere key).
 */

const https = require('https');
const os = require('os');
const { resolveUserId } = require('./user-sandbox');

// ── Helpers HTTP ────────────────────────────────────────────────────────────

function _httpGetJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) return reject(new Error(json.reason || json.error || `HTTP ${res.statusCode}`));
          resolve(json);
        } catch { reject(new Error(`Respuesta no-JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

const WEATHER_CODES = {
  0: 'despejado', 1: 'casi despejado', 2: 'parcialmente nublado', 3: 'nublado',
  45: 'neblina', 48: 'neblina con escarcha',
  51: 'llovizna ligera', 53: 'llovizna', 55: 'llovizna densa',
  61: 'lluvia ligera', 63: 'lluvia', 65: 'lluvia fuerte',
  71: 'nieve ligera', 73: 'nieve', 75: 'nieve fuerte',
  80: 'chubascos ligeros', 81: 'chubascos', 82: 'chubascos violentos',
  95: 'tormenta', 96: 'tormenta con granizo', 99: 'tormenta intensa',
};

// ── Tools ───────────────────────────────────────────────────────────────────

const SERVER_INFO = {
  name: 'server_info',
  description: 'Retorna información básica del server donde corre el agente: hostname, plataforma (windows/linux/mac), arquitectura, versión de Node, uptime del proceso, count de CPUs, memoria total. Útil para diagnósticos y para que el agente sepa "dónde está corriendo".',
  params: {},
  execute(_args, _ctx) {
    const totalMem = os.totalmem();
    const freeMem  = os.freemem();
    const usedMem  = totalMem - freeMem;
    const uptime   = Math.floor(process.uptime());
    const days     = Math.floor(uptime / 86400);
    const hours    = Math.floor((uptime % 86400) / 3600);
    const mins     = Math.floor((uptime % 3600) / 60);
    return JSON.stringify({
      hostname: os.hostname(),
      platform: process.platform,
      arch:     process.arch,
      node:     process.version,
      pid:      process.pid,
      cpus:     os.cpus().length,
      memory: {
        total_gb: (totalMem / 1e9).toFixed(2),
        used_gb:  (usedMem / 1e9).toFixed(2),
        used_pct: Math.round((usedMem / totalMem) * 100),
      },
      uptime: { seconds: uptime, formatted: `${days}d ${hours}h ${mins}m` },
    }, null, 2);
  },
};

const SERVER_LOCATION = {
  name: 'server_location',
  description: 'Retorna la ubicación de red del server: IPs LAN locales, IPs Tailscale (VPN), IP pública + ciudad/país aproximado (vía ip-api.com), y override manual de coordenadas si está configurado por admin. El agente puede usar esto para saber dónde está el server geográficamente y responder preguntas como "qué IP tengo" o usarlo de fallback para weather_get.',
  params: {
    refresh: '?boolean', // si true, ignora cache de IP pública (default: false)
  },
  async execute(args = {}, ctx = {}) {
    if (!ctx.locationService) return JSON.stringify({ error: 'LocationService no disponible en ctx' });
    try {
      const loc = await ctx.locationService.getLocation({
        includePublic: true,
        forcePublic:   args.refresh === true,
      });
      return JSON.stringify(loc, null, 2);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  },
};

const WEATHER_GET = {
  name: 'weather_get',
  description: 'Obtiene clima actual + forecast 4 días para una ubicación. Si no se pasan coordenadas, usa la del server (manual override > IP pública). Open-Meteo (free, sin key). Devuelve temperatura, weathercode, viento, lluvia probable, max/min por día.',
  params: {
    latitude:  '?number',  // si se omite, usa server location
    longitude: '?number',
    days:      '?number',  // 1-7, default 4
  },
  async execute(args = {}, ctx = {}) {
    let lat = args.latitude;
    let lon = args.longitude;
    let resolvedSource = lat != null && lon != null ? 'args' : null;

    // Prioridad para auto-resolución: user location > server location.
    if ((lat == null || lon == null) && ctx.userPreferencesRepo) {
      try {
        const userId = resolveUserId(ctx);
        if (userId) {
          const raw = ctx.userPreferencesRepo.get(userId, 'location');
          if (raw) {
            const u = JSON.parse(raw);
            if (u.latitude != null && u.longitude != null) {
              lat = u.latitude; lon = u.longitude; resolvedSource = 'user-preference';
            }
          }
        }
      } catch { /* noop */ }
    }
    if ((lat == null || lon == null) && ctx.locationService) {
      try {
        const loc = await ctx.locationService.getLocation({ includePublic: true });
        if (loc.resolved) { lat = loc.resolved.latitude; lon = loc.resolved.longitude; resolvedSource = 'server-location'; }
      } catch { /* noop */ }
    }
    if (lat == null || lon == null) {
      return JSON.stringify({ error: 'No se pudo determinar la ubicación. Pasá latitude y longitude, o configurá la ubicación del usuario con user_location_save.' });
    }

    const days = Math.max(1, Math.min(7, Number(args.days) || 4));
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current_weather=true&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=${days}`;

    try {
      const data = await _httpGetJson(url);
      const cur = data.current_weather || {};
      const daily = data.daily || {};
      const forecast = (daily.time || []).map((date, i) => ({
        date,
        weather:    WEATHER_CODES[daily.weathercode?.[i]] || `code ${daily.weathercode?.[i]}`,
        temp_max:   daily.temperature_2m_max?.[i],
        temp_min:   daily.temperature_2m_min?.[i],
        rain_prob:  daily.precipitation_probability_max?.[i],
      }));
      return JSON.stringify({
        location: { latitude: lat, longitude: lon, timezone: data.timezone, source: resolvedSource },
        current: {
          temperature: cur.temperature,
          windspeed:   cur.windspeed,
          winddir:     cur.winddirection,
          weather:     WEATHER_CODES[cur.weathercode] || `code ${cur.weathercode}`,
          time:        cur.time,
        },
        forecast,
      }, null, 2);
    } catch (err) {
      return JSON.stringify({ error: `weather fetch falló: ${err.message}` });
    }
  },
};

module.exports = [SERVER_INFO, SERVER_LOCATION, WEATHER_GET];
