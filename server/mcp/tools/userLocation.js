'use strict';

/**
 * mcp/tools/userLocation.js — tools para que el agente guarde y recupere la
 * ubicación del USUARIO actual (no del server).
 *
 * Uso típico: el user le dice al agente "estoy en Buenos Aires" → el agente
 * llama `user_location_save({ name: 'Buenos Aires' })`. El agente puede después
 * usar `weather_get({})` que en versión próxima leerá esta preferencia.
 *
 * Storage: `userPreferencesRepo` con key `location`. Value es JSON con
 *   { name, latitude, longitude, timezone, country, savedAt, source }
 *
 * Geocoding opcional: si pasan `name` sin lat/lon, intenta resolver via
 * Nominatim (OSM, free, sin key). Falla silencioso → guarda solo el name.
 */

const https = require('https');
const { resolveUserId } = require('./user-sandbox');

const PREFERENCE_KEY = 'location';

function _httpsGetJson(url, headers = {}, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Clawmint/1.0', ...headers } }, (res) => {
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

/** Geocoding via Nominatim (OSM). Free, sin key, ~1 req/sec recomendado. */
async function _geocode(name) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&limit=1&addressdetails=1`;
  try {
    const results = await _httpsGetJson(url);
    if (!Array.isArray(results) || results.length === 0) return null;
    const r = results[0];
    return {
      latitude:  Number(r.lat),
      longitude: Number(r.lon),
      display:   r.display_name,
      country:   r.address?.country || null,
      city:      r.address?.city || r.address?.town || r.address?.village || null,
    };
  } catch { return null; }
}

const USER_LOCATION_SAVE = {
  name: 'user_location_save',
  description: 'Guarda la ubicación del USUARIO actual (la persona con la que estás chateando). Usalo cuando el user te diga dónde está, vive o trabaja, o cualquier ubicación que quiere recordar como "su" ubicación. Si pasás solo `name` (ej. "Buenos Aires"), intenta resolver lat/lon automáticamente via OpenStreetMap. Persiste en preferences del user para uso futuro (clima, contexto, agenda).',
  params: {
    name:      '?string',  // ciudad/dirección legible
    latitude:  '?number',
    longitude: '?number',
    timezone:  '?string',
    notes:     '?string',  // ej. "casa", "oficina", "domicilio principal"
  },
  async execute(args = {}, ctx = {}) {
    const userId = resolveUserId(ctx);
    if (!userId) return JSON.stringify({ error: 'No se pudo resolver userId del contexto' });
    if (!ctx.userPreferencesRepo) return JSON.stringify({ error: 'userPreferencesRepo no disponible en ctx' });

    const { name, latitude, longitude, timezone, notes } = args;
    if (!name && (latitude == null || longitude == null)) {
      return JSON.stringify({ error: 'Pasá al menos `name` o (`latitude` + `longitude`).' });
    }

    let payload = {
      name:      name || null,
      latitude:  latitude != null ? Number(latitude) : null,
      longitude: longitude != null ? Number(longitude) : null,
      timezone:  timezone || null,
      notes:     notes || null,
      country:   null,
      savedAt:   Date.now(),
      source:    'agent',
    };

    // Si no pasaron coords pero sí name, geocode automático.
    if (payload.latitude == null && name) {
      const geo = await _geocode(name);
      if (geo) {
        payload.latitude  = geo.latitude;
        payload.longitude = geo.longitude;
        payload.country   = geo.country;
        if (!name && geo.display) payload.name = geo.display;
        payload.source = 'agent+nominatim';
      }
    }

    try {
      ctx.userPreferencesRepo.set(userId, PREFERENCE_KEY, JSON.stringify(payload));
      return JSON.stringify({ ok: true, saved: payload });
    } catch (err) {
      return JSON.stringify({ error: `No pude guardar: ${err.message}` });
    }
  },
};

const USER_LOCATION_GET = {
  name: 'user_location_get',
  description: 'Recupera la ubicación guardada del USUARIO actual. Útil para responder preguntas como "¿dónde dije que vivía?", o para anclar weather_get/calendar a la zona del user. Retorna null si nunca se guardó.',
  params: {},
  execute(_args, ctx = {}) {
    const userId = resolveUserId(ctx);
    if (!userId) return JSON.stringify({ error: 'No se pudo resolver userId del contexto' });
    if (!ctx.userPreferencesRepo) return JSON.stringify({ error: 'userPreferencesRepo no disponible en ctx' });
    try {
      const raw = ctx.userPreferencesRepo.get(userId, PREFERENCE_KEY);
      if (raw == null) return JSON.stringify({ location: null, message: 'El user no tiene ubicación guardada todavía. Podés preguntarle dónde está y guardarla con user_location_save.' });
      try { return JSON.stringify({ location: JSON.parse(raw) }); }
      catch { return JSON.stringify({ location: { name: String(raw) } }); }
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  },
};

const USER_LOCATION_FORGET = {
  name: 'user_location_forget',
  description: 'Borra la ubicación guardada del usuario actual. Útil si el user se mudó o quiere limpiar la información.',
  params: {},
  execute(_args, ctx = {}) {
    const userId = resolveUserId(ctx);
    if (!userId) return JSON.stringify({ error: 'No se pudo resolver userId del contexto' });
    if (!ctx.userPreferencesRepo) return JSON.stringify({ error: 'userPreferencesRepo no disponible en ctx' });
    const ok = ctx.userPreferencesRepo.remove(userId, PREFERENCE_KEY);
    return JSON.stringify({ ok, message: ok ? 'Ubicación borrada.' : 'No había ubicación guardada.' });
  },
};

module.exports = [USER_LOCATION_SAVE, USER_LOCATION_GET, USER_LOCATION_FORGET];
