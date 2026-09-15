'use strict';

// web.js — Tool web_fetch: descarga una URL pública (GET) y devuelve su contenido.
// Caso de uso principal: páginas de precios (ej. https://opencode.ai/es/go) para que la IA
// compare costos. Sin dependencias: usa el fetch global de Node 22.

const UA          = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const MAX_BYTES   = 200 * 1024; // 200 KB
const TIMEOUT_MS  = 15000;

/** HTML → texto legible: saca scripts/styles/comentarios y tags, preservando saltos. */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const WEB_FETCH = {
  name: 'web_fetch',
  description:
    'Descarga una URL pública (GET) y devuelve su contenido. Con format "text" (default) ' +
    'extrae el texto legible del HTML (útil para páginas de precios, ej. opencode.ai/es/go); ' +
    'con "html" devuelve el HTML crudo. Límite ~200 KB, timeout 15s.',
  params: { url: 'string', format: '?string' },

  async execute({ url, format } = {}) {
    if (!url || !/^https?:\/\//i.test(url)) return 'Error: parámetro url requerido (http/https)';
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'es' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      return `Error descargando ${url}: ${err.message}`;
    }
    if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText} — ${url}`;

    let body;
    try {
      body = await res.text();
    } catch (err) {
      return `Error leyendo el cuerpo de ${url}: ${err.message}`;
    }
    if (body.length > MAX_BYTES) body = `${body.slice(0, MAX_BYTES)}\n\n(truncado a ${MAX_BYTES} bytes)`;

    if ((format || 'text').toLowerCase() === 'html') return body;
    return htmlToText(body);
  },
};

module.exports = [WEB_FETCH];
