'use strict';

const crypto = require('crypto');
const https  = require('https');
const http   = require('http');

/**
 * OAuthService — flujo OAuth2 authorization code grant para Google y GitHub.
 *
 * Sin dependencias externas (usa http/https nativo).
 * Genera URLs de autorización, intercambia codes por tokens, y obtiene perfiles.
 */
class OAuthService {
  constructor({ logger } = {}) {
    this._logger = logger;
    this._states = new Map(); // state → { provider, createdAt }

    // Cleanup de states viejos cada 5 min
    this._cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - 10 * 60 * 1000; // 10 min TTL
      for (const [state, data] of this._states) {
        if (data.createdAt < cutoff) this._states.delete(state);
      }
    }, 5 * 60 * 1000);
    this._cleanupTimer.unref();
  }

  // ── Google ──────────────────────────────────────────────────────────────────

  get googleConfigured() {
    return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  }

  getGoogleAuthUrl(redirectUri) {
    const state = crypto.randomBytes(32).toString('hex');
    this._states.set(state, { provider: 'google', createdAt: Date.now() });

    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'offline',
      prompt: 'consent',
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async handleGoogleCallback(code, state, redirectUri) {
    this._verifyState(state, 'google');

    // Exchange code for tokens
    const tokenData = await this._post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    // Fetch user profile
    const profile = await this._get('https://www.googleapis.com/oauth2/v2/userinfo', {
      Authorization: `Bearer ${tokenData.access_token}`,
    });

    return {
      providerId: profile.id,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.picture,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      tokenExpiry: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null,
    };
  }

  // ── GitHub ──────────────────────────────────────────────────────────────────

  get githubConfigured() {
    return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  }

  getGithubAuthUrl(redirectUri) {
    const state = crypto.randomBytes(32).toString('hex');
    this._states.set(state, { provider: 'github', createdAt: Date.now() });

    const params = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'user:email',
      state,
    });

    return `https://github.com/login/oauth/authorize?${params}`;
  }

  async handleGithubCallback(code, state, redirectUri) {
    this._verifyState(state, 'github');

    // Exchange code for token
    const tokenData = await this._post('https://github.com/login/oauth/access_token', {
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }, { Accept: 'application/json' });

    if (!tokenData.access_token) {
      throw new Error(tokenData.error_description || 'Error obteniendo token de GitHub');
    }

    // Fetch user profile
    const profile = await this._get('https://api.github.com/user', {
      Authorization: `Bearer ${tokenData.access_token}`,
      'User-Agent': 'Clawmint',
    });

    // Fetch primary email (puede no estar en el perfil)
    let email = profile.email;
    if (!email) {
      try {
        const emails = await this._get('https://api.github.com/user/emails', {
          Authorization: `Bearer ${tokenData.access_token}`,
          'User-Agent': 'Clawmint',
        });
        const primary = emails.find(e => e.primary && e.verified);
        email = primary?.email || emails[0]?.email || null;
      } catch { /* email no disponible */ }
    }

    return {
      providerId: String(profile.id),
      email,
      name: profile.name || profile.login,
      avatarUrl: profile.avatar_url,
      accessToken: tokenData.access_token,
      refreshToken: null,
      tokenExpiry: null,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _verifyState(state, expectedProvider) {
    const data = this._states.get(state);
    if (!data) throw new Error('State inválido o expirado (posible CSRF)');
    if (data.provider !== expectedProvider) throw new Error('State no coincide con el provider');
    this._states.delete(state);
  }

  /**
   * HTTP POST con body URL-encoded o JSON.
   */
  _post(url, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const isJson = extraHeaders['Content-Type'] === 'application/json';
      const payload = isJson ? JSON.stringify(body) : new URLSearchParams(body).toString();
      const transport = parsed.protocol === 'https:' ? https : http;

      const req = transport.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
          ...extraHeaders,
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Respuesta no-JSON: ${data.slice(0, 200)}`)); }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(payload);
      req.end();
    });
  }

  /**
   * HTTP GET con headers.
   */
  _get(url, headers = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;

      const req = transport.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Respuesta no-JSON: ${data.slice(0, 200)}`)); }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
  }

  /**
   * Genera la página HTML de callback que pasa tokens al opener via postMessage.
   */
  static callbackHtml(tokens, error = null) {
    const payload = error
      ? JSON.stringify({ error })
      : JSON.stringify(tokens);

    return `<!DOCTYPE html>
<html><head><title>Autenticación</title></head>
<body>
<p>${error ? 'Error de autenticación' : 'Autenticación exitosa. Cerrando...'}</p>
<script>
  try {
    if (window.opener) {
      window.opener.postMessage({ type: 'oauth_callback', payload: ${payload} }, '*');
      setTimeout(() => window.close(), 500);
    } else {
      // Fallback: guardar en localStorage y redirigir
      localStorage.setItem('wc-oauth-result', JSON.stringify(${payload}));
      window.location.href = '/';
    }
  } catch(e) {
    document.body.innerHTML = '<p>Error: ' + e.message + '</p>';
  }
</script>
</body></html>`;
  }
}

module.exports = OAuthService;
