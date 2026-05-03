'use strict';

/**
 * Handler OAuth2 para GitHub.
 *
 * Credenciales: systemConfigRepo (DB) con fallback a env vars
 * GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET.
 */

const https = require('https');

let _configRepo = null;

function getCreds() {
  const id     = _configRepo?.get?.('oauth:github:client_id')     || process.env.GITHUB_CLIENT_ID;
  const secret = _configRepo?.getSecret?.('oauth:github:client_secret') || process.env.GITHUB_CLIENT_SECRET;
  return { id, secret };
}

function _post(url, body, headers = {}) {
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
        Accept: 'application/json',
        ...headers,
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

const handler = {
  buildAuthUrl({ state, redirectUri }) {
    const { id } = getCreds();
    if (!id) throw new Error('GitHub client_id no configurado');
    const params = new URLSearchParams({
      client_id: id,
      redirect_uri: redirectUri,
      scope: 'repo read:user user:email',
      state,
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  },

  async exchange({ code, req }) {
    const host = req?.get ? req.get('host') : null;
    const proto = req?.protocol || 'http';
    const origin = host ? `${proto}://${host}` : (process.env.PUBLIC_URL || 'http://localhost:3001');
    const redirectUri = `${origin}/api/mcp-auth/callback/github`;

    const { id, secret } = getCreds();
    if (!id || !secret) throw new Error('GitHub client_id/secret no configurados');
    const tokenData = await _post('https://github.com/login/oauth/access_token', {
      client_id: id,
      client_secret: secret,
      code,
      redirect_uri: redirectUri,
    });
    if (!tokenData.access_token) throw new Error(tokenData.error_description || 'No access_token en respuesta GitHub');
    return {
      token: tokenData.access_token,
      token_type: tokenData.token_type || 'Bearer',
      mcp_name: 'github',
    };
  },
};

function register({ mcpAuthService, systemConfigRepo, logger }) {
  _configRepo = systemConfigRepo || null;
  mcpAuthService.registerCallbackHandler('github', handler);
  const configured = isConfigured();
  logger?.info?.(`[mcp-oauth] GitHub registrado (${configured ? 'credenciales OK' : 'esperando credenciales via UI o env'})`);
  return ['github'];
}

module.exports = { register, isConfigured };
