'use strict';

/**
 * Handler OAuth2 para providers Google (Calendar, Gmail, Drive, Tasks).
 *
 * Credenciales: Las toma en este orden:
 *   1. systemConfigRepo (DB, editable via panel admin) → claves
 *      `oauth:google:client_id` + `oauth:google:client_secret` (cifrada).
 *   2. Fallback env vars `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`.
 *
 * Así la app es instalable sin .env: el admin pega las credenciales en la UI
 * una vez y quedan persistidas cifradas en la DB.
 */

const https = require('https');

let _configRepo = null; // se inyecta al llamar register()

function getCreds() {
  const id     = _configRepo?.get?.('oauth:google:client_id')     || process.env.GOOGLE_CLIENT_ID;
  const secret = _configRepo?.getSecret?.('oauth:google:client_secret') || process.env.GOOGLE_CLIENT_SECRET;
  return { id, secret };
}

const SCOPES = {
  'google-calendar': ['https://www.googleapis.com/auth/calendar'],
  calendar:          ['https://www.googleapis.com/auth/calendar'],
  gmail:             ['https://www.googleapis.com/auth/gmail.modify'],
  'google-gmail':    ['https://www.googleapis.com/auth/gmail.modify'],
  gdrive:            ['https://www.googleapis.com/auth/drive.readonly'],
  'google-drive':    ['https://www.googleapis.com/auth/drive.readonly'],
  drive:             ['https://www.googleapis.com/auth/drive.readonly'],
  gtasks:            ['https://www.googleapis.com/auth/tasks'],
  'google-tasks':    ['https://www.googleapis.com/auth/tasks'],
  tasks:             ['https://www.googleapis.com/auth/tasks'],
  google:            [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/tasks',
  ],
};

function scopesFor(mcpName) {
  const key = String(mcpName || '').toLowerCase();
  return SCOPES[key] || SCOPES.google;
}

function _post(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = new URLSearchParams(body).toString();
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
        ...extraHeaders,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) return reject(new Error(json.error_description || json.error || `HTTP ${res.statusCode}`));
          resolve(json);
        } catch (e) { reject(new Error(`Respuesta no-JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

function isConfigured() {
  const { id, secret } = getCreds();
  return !!(id && secret);
}

function makeHandler(providerName) {
  return {
    buildAuthUrl({ state, redirectUri }) {
      const { id } = getCreds();
      if (!id) throw new Error('Google client_id no configurado');
      const params = new URLSearchParams({
        client_id: id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopesFor(providerName).join(' '),
        state,
        access_type: 'offline',
        prompt: 'consent',
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    },

    async exchange({ code, req }) {
      const redirectUri = _deriveRedirectUri(req, providerName);
      const { id, secret } = getCreds();
      if (!id || !secret) throw new Error('Google client_id/secret no configurados');
      const tokenData = await _post('https://oauth2.googleapis.com/token', {
        code,
        client_id: id,
        client_secret: secret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      return {
        token: tokenData.access_token,
        token_type: tokenData.token_type || 'Bearer',
        refresh_token: tokenData.refresh_token || null,
        expires_at: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null,
        mcp_name: providerName,
      };
    },
  };
}

function _deriveRedirectUri(req, providerName) {
  // Si el request tiene host, usamos ese. Sino fallback a env.
  const host = req?.get ? req.get('host') : null;
  const proto = req?.protocol || 'http';
  const origin = host ? `${proto}://${host}` : (process.env.PUBLIC_URL || 'http://localhost:3001');
  return `${origin}/api/mcp-auth/callback/${encodeURIComponent(providerName)}`;
}

/**
 * Registra handlers Google (Calendar, Gmail, Drive, Tasks) en el McpAuthService.
 * Siempre registra los handlers; cada invocación valida credenciales on-demand.
 * De este modo el admin puede setear creds via UI sin reiniciar.
 */
function register({ mcpAuthService, systemConfigRepo, logger }) {
  _configRepo = systemConfigRepo || null;
  const providers = ['google-calendar', 'google-gmail', 'google-drive', 'google-tasks'];
  for (const p of providers) {
    mcpAuthService.registerCallbackHandler(p, makeHandler(p));
  }
  const configured = isConfigured();
  logger?.info?.(`[mcp-oauth] Google registrado (${configured ? 'credenciales OK' : 'esperando credenciales via UI o env'}): ${providers.join(', ')}`);
  return providers;
}

module.exports = { register, isConfigured };
