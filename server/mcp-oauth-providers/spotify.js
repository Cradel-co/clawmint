'use strict';

/**
 * Handler OAuth2 para Spotify.
 *
 * Credenciales: systemConfigRepo (DB) con fallback a env vars
 * SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET.
 */

const https = require('https');

let _configRepo = null;

function getCreds() {
  const id     = _configRepo?.get?.('oauth:spotify:client_id')     || process.env.SPOTIFY_CLIENT_ID;
  const secret = _configRepo?.getSecret?.('oauth:spotify:client_secret') || process.env.SPOTIFY_CLIENT_SECRET;
  return { id, secret };
}

function _post(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = new URLSearchParams(body).toString();
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
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
          if (res.statusCode >= 400 || json.error) return reject(new Error(json.error_description || json.error || `HTTP ${res.statusCode}`));
          resolve(json);
        } catch { reject(new Error(`Respuesta no-JSON: ${data.slice(0, 200)}`)); }
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

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-read-private',
  'user-read-email',
  'streaming',
].join(' ');

const handler = {
  buildAuthUrl({ state, redirectUri }) {
    const { id } = getCreds();
    if (!id) throw new Error('Spotify client_id no configurado');
    const params = new URLSearchParams({
      client_id: id,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      state,
    });
    return `https://accounts.spotify.com/authorize?${params}`;
  },

  async exchange({ code, req }) {
    const host = req?.get ? req.get('host') : null;
    const proto = req?.protocol || 'http';
    const origin = host ? `${proto}://${host}` : (process.env.PUBLIC_URL || 'http://localhost:3001');
    const redirectUri = `${origin}/api/mcp-auth/callback/spotify`;

    const { id, secret } = getCreds();
    if (!id || !secret) throw new Error('Spotify client_id/secret no configurados');
    const basic = Buffer.from(`${id}:${secret}`).toString('base64');
    const tokenData = await _post('https://accounts.spotify.com/api/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }, {
      Authorization: `Basic ${basic}`,
    });

    return {
      token: tokenData.access_token,
      token_type: tokenData.token_type || 'Bearer',
      refresh_token: tokenData.refresh_token || null,
      expires_at: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null,
      mcp_name: 'spotify',
    };
  },
};

function register({ mcpAuthService, systemConfigRepo, logger }) {
  _configRepo = systemConfigRepo || null;
  mcpAuthService.registerCallbackHandler('spotify', handler);
  const configured = isConfigured();
  logger?.info?.(`[mcp-oauth] Spotify registrado (${configured ? 'credenciales OK' : 'esperando credenciales via UI o env'})`);
  return ['spotify'];
}

module.exports = { register, isConfigured };
