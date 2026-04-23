'use strict';

/**
 * mcp/tools/web.js — Tools MCP para acceso web.
 *
 * webfetch:  fetch + turndown (HTML→markdown) + SSRF guard + MIME whitelist + 100KB truncate.
 * websearch: Brave Search API con rate limit in-memory (1 req/s) + error instructivo si falta la key.
 */

const TurndownService = require('turndown');
const { sanitizeUrl } = require('../../core/security/ssrfGuard');

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONTENT_BYTES = 100_000;
const MIME_WHITELIST = [
  'text/html',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/json',
  'application/xml',
  'text/xml',
];

function _truncate(s) {
  return s.length > MAX_CONTENT_BYTES
    ? s.slice(0, MAX_CONTENT_BYTES) + '\n\n[... truncado en 100KB ...]'
    : s;
}

function _htmlToMarkdown(html) {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  // Limpiar elementos no útiles antes de convertir
  td.remove(['script', 'style', 'nav', 'footer', 'noscript', 'iframe']);
  // Preservar fences con lang desde class="language-x"
  td.addRule('fenced-code-lang', {
    filter: (node) => node.nodeName === 'PRE' && node.firstChild && node.firstChild.nodeName === 'CODE',
    replacement: (_content, node) => {
      const code = node.firstChild;
      const cls = code.getAttribute('class') || '';
      const m = cls.match(/language-(\w+)/);
      const lang = m ? m[1] : '';
      return `\n\n\`\`\`${lang}\n${code.textContent}\n\`\`\`\n\n`;
    },
  });
  return td.turndown(html);
}

const WEBFETCH = {
  name: 'webfetch',
  description: 'Trae el contenido de una URL como texto/html/markdown (default: markdown). Bloquea hosts privados. Timeout 15s. Trunca a 100KB.',
  params: {
    url: 'string',
    extract: '?string',
  },
  async execute(args = {}, _ctx = {}) {
    if (!args.url) return 'Error: url requerida';
    const sanitized = sanitizeUrl(args.url);
    if (!sanitized.ok) return `Error: ${sanitized.reason}`;
    const u = sanitized.url;

    const extract = args.extract || 'markdown';
    if (!['text', 'html', 'markdown'].includes(extract)) {
      return `Error: extract debe ser text|html|markdown`;
    }

    let res;
    try {
      res = await fetch(u.toString(), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': 'TerminalLive/1.0', 'accept': 'text/html,text/plain,application/json,*/*;q=0.8' },
        redirect: 'follow',
      });
    } catch (e) {
      if (e.name === 'TimeoutError' || /timeout/i.test(e.message)) {
        return `Error: timeout fetch (${FETCH_TIMEOUT_MS / 1000}s)`;
      }
      return `Error fetch: ${e.message}`;
    }

    if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText}`;

    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!MIME_WHITELIST.includes(contentType)) {
      return `Error: MIME no soportado: ${contentType || '(ninguno)'}`;
    }

    const text = await res.text();
    if (extract === 'html') return _truncate(text);
    if (extract === 'text') {
      if (contentType === 'text/html') {
        // Para modo text, strippear tags básicos sin turndown
        const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        return _truncate(stripped);
      }
      return _truncate(text);
    }
    // markdown
    if (contentType === 'text/html') {
      try { return _truncate(_htmlToMarkdown(text)); }
      catch (e) { return `Error convirtiendo a markdown: ${e.message}`; }
    }
    return _truncate(text);
  },
};

// ── websearch con Brave API + rate limit in-memory ───────────────────────────

const _lastSearchByUser = new Map();
const DEFAULT_SEARCH_RATE_MS = 1_000;

function _rateLimitCheck(ctx) {
  const userKey = String(ctx.userId || ctx.chatId || 'anon');
  const now = Date.now();
  // Rate configurable vía LimitsRepo si está
  let minInterval = DEFAULT_SEARCH_RATE_MS;
  if (ctx.limitsRepo && typeof ctx.limitsRepo.resolve === 'function') {
    try {
      const rule = ctx.limitsRepo.resolve('rate', { userId: ctx.userId, channel: ctx.channel, tool: 'websearch' });
      if (rule && rule.intervalMs) minInterval = Number(rule.intervalMs);
    } catch { /* no-op */ }
  }
  const last = _lastSearchByUser.get(userKey);
  if (last && (now - last) < minInterval) {
    const waitMs = minInterval - (now - last);
    return `rate limit: esperá ${waitMs}ms`;
  }
  _lastSearchByUser.set(userKey, now);
  return null;
}

const WEBSEARCH = {
  name: 'websearch',
  description: 'Busca en la web vía Brave Search API. Devuelve title, url, snippet. Rate limit 1 req/s por usuario. Requiere BRAVE_SEARCH_API_KEY.',
  params: {
    query: 'string',
    limit: '?number',
  },
  async execute(args = {}, ctx = {}) {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      return [
        'Error: websearch requiere BRAVE_SEARCH_API_KEY.',
        'Obtené una gratis en https://api.search.brave.com/app/keys',
        'y agregala a tu .env: BRAVE_SEARCH_API_KEY=BSA...',
      ].join('\n');
    }
    if (!args.query) return 'Error: query requerida';
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);

    const rateErr = _rateLimitCheck(ctx);
    if (rateErr) return `Error: ${rateErr}`;

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(args.query)}&count=${limit}`;
    let res;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'X-Subscription-Token': apiKey,
          'accept': 'application/json',
        },
      });
    } catch (e) {
      return `Error consultando Brave: ${e.message}`;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return `Error: Brave respondió ${res.status} ${res.statusText}\n${body.slice(0, 500)}`;
    }
    let data;
    try { data = await res.json(); }
    catch (e) { return `Error parseando respuesta de Brave: ${e.message}`; }

    const results = (data.web && Array.isArray(data.web.results)) ? data.web.results : [];
    if (!results.length) return '(sin resultados)';
    return results.slice(0, limit).map((r, i) =>
      `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.description || '').replace(/\s+/g, ' ').trim()}`
    ).join('\n\n');
  },
};

module.exports = [WEBFETCH, WEBSEARCH];
// Exponer internals para tests
module.exports._internal = { _lastSearchByUser };
