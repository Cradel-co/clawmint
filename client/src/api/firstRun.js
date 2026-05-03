// firstRun.js — helpers HTTP que consume el WelcomeWizard.
//
// Cada paso del wizard hace un POST/PUT a un endpoint existente del server.
// Reusamos las rutas actuales (/auth/register, /providers/:name, /telegram/bots),
// sólo agregando el flag `firstAdmin: true` en register.

import { API_BASE } from '../config';

async function _request(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || text || `${method} ${path} → ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Paso 1: crear admin (primera cuenta de la instalación). */
export async function registerFirstAdmin({ email, password, name }) {
  return _request('POST', '/api/auth/register', { email, password, name, firstAdmin: true });
}

/** Paso 2: validar + guardar API key de un provider. */
export async function validateProviderKey({ provider, apiKey, token }) {
  // El server valida contra el provider real; delega si soporta /test endpoint.
  // Fallback: confía en el key y guarda.
  return _request('POST', `/api/providers/${encodeURIComponent(provider)}/test`, { apiKey }, token);
}

export async function saveProviderKey({ provider, apiKey, token }) {
  return _request('PUT', `/api/providers/${encodeURIComponent(provider)}`, { apiKey }, token);
}

/** Paso 3: validar bot de Telegram + guardarlo. */
export async function validateTelegramBot({ botToken, token }) {
  return _request('POST', '/api/telegram/validate-bot', { botToken }, token);
}

export async function addTelegramBot({ botToken, key, defaultAgent, whitelist, token }) {
  return _request('POST', '/api/telegram/bots', {
    token: botToken,
    key: key || 'default',
    defaultAgent: defaultAgent || 'claude',
    whitelist: whitelist || [],
  }, token);
}

/** Helper: detecta IPs de LAN del host para mostrar en el paso 4. */
export async function getLanAddresses({ token } = {}) {
  try {
    return await _request('GET', '/api/system/lan-addresses', null, token);
  } catch {
    return { addresses: [] };
  }
}
