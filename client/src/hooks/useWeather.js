import { useEffect, useState, useRef } from 'react';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';

/**
 * useWeather — obtiene clima actual + forecast 3 días desde Open-Meteo (sin API key).
 *
 * Resolución de coords (prioridad):
 *   1. User preference (`/api/user-preferences/location`) — guardado por el user
 *      en ProfilePanel o por el agente via MCP tool user_location_save.
 *   2. Server location (`/api/system/location` resolved) — manual override admin
 *      o IP pública del server.
 *   3. localStorage `weather:coords` — cache de geo previo del browser.
 *   4. `navigator.geolocation` — pide permiso al browser (4s timeout).
 *   5. Fallback Madrid.
 *
 * Refresh cada 15min.
 */
const DEFAULT = { latitude: 40.4168, longitude: -3.7038, name: 'Madrid' }; // fallback
const STORAGE_KEY = 'weather:coords';

const WEATHER_CODES = {
  0:  { label: 'Despejado',            icon: '☀️'  },
  1:  { label: 'Casi despejado',       icon: '🌤' },
  2:  { label: 'Parcial nublado',      icon: '⛅'  },
  3:  { label: 'Nublado',              icon: '☁️' },
  45: { label: 'Neblina',              icon: '🌫' },
  48: { label: 'Neblina con escarcha', icon: '🌫' },
  51: { label: 'Llovizna ligera',      icon: '🌦' },
  53: { label: 'Llovizna',             icon: '🌦' },
  55: { label: 'Llovizna densa',       icon: '🌧' },
  61: { label: 'Lluvia ligera',        icon: '🌦' },
  63: { label: 'Lluvia',               icon: '🌧' },
  65: { label: 'Lluvia fuerte',        icon: '🌧' },
  71: { label: 'Nieve ligera',         icon: '🌨' },
  73: { label: 'Nieve',                icon: '🌨' },
  75: { label: 'Nieve fuerte',         icon: '❄️' },
  80: { label: 'Chubascos ligeros',    icon: '🌦' },
  81: { label: 'Chubascos',            icon: '🌧' },
  82: { label: 'Chubascos violentos',  icon: '⛈' },
  95: { label: 'Tormenta',             icon: '⛈' },
  96: { label: 'Tormenta + granizo',   icon: '⛈' },
  99: { label: 'Tormenta intensa',     icon: '⛈' },
};

export function weatherMeta(code) {
  return WEATHER_CODES[code] || { label: '—', icon: '·' };
}

async function _tryUserPreference() {
  try {
    const res = await apiFetch(`${API_BASE}/api/user-preferences/location`);
    if (!res.ok) return null;
    const { value } = await res.json();
    let parsed;
    try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
    if (parsed && parsed.latitude != null && parsed.longitude != null) {
      return {
        latitude:  Number(parsed.latitude),
        longitude: Number(parsed.longitude),
        name:      parsed.name || null,
        source:    'user-preference',
      };
    }
  } catch { /* sin auth o sin pref */ }
  return null;
}

async function _tryServerLocation() {
  try {
    const res = await apiFetch(`${API_BASE}/api/system/location?public=true`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.resolved && data.resolved.latitude != null && data.resolved.longitude != null) {
      return {
        latitude:  data.resolved.latitude,
        longitude: data.resolved.longitude,
        name:      data.resolved.name || null,
        source:    `server-${data.resolved.preferred || 'auto'}`,
      };
    }
  } catch { /* server abajo o sin auth */ }
  return null;
}

async function fetchCoords() {
  // Prioridad: user preference → server location → cache localStorage → browser geo → Madrid.
  const userPref = await _tryUserPreference();
  if (userPref) return userPref;

  const server = await _tryServerLocation();
  if (server) return server;

  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      return { ...parsed, source: parsed.source || 'browser-cache' };
    }
  } catch {}

  if (navigator.geolocation) {
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, name: null, source: 'browser-geo' };
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(coords)); } catch {}
          resolve(coords);
        },
        () => resolve({ ...DEFAULT, source: 'fallback' }),
        { timeout: 4000, maximumAge: 1000 * 60 * 60 * 24 }
      );
    });
  }
  return { ...DEFAULT, source: 'fallback' };
}

export function useWeather(pollMs = 15 * 60 * 1000) {
  const [state, setState] = useState({ data: null, error: null, loading: true, coords: null });
  const timerRef = useRef(null);

  const load = async (coords) => {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}&current_weather=true&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=4`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setState({ data, error: null, loading: false, coords });
    } catch (e) {
      setState((s) => ({ ...s, error: e, loading: false }));
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const coords = await fetchCoords();
      if (cancelled) return;
      load(coords);
      timerRef.current = setInterval(() => load(coords), pollMs);
    })();
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [pollMs]);

  const setLocation = async (latitude, longitude, name) => {
    const coords = { latitude, longitude, name };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(coords)); } catch {}
    setState({ data: null, error: null, loading: true, coords });
    load(coords);
  };

  return { ...state, setLocation, weatherMeta };
}
