'use strict';

/**
 * ssrfGuard — bloquea URLs que apunten a rangos privados, loopback, link-local.
 *
 * API pública:
 *   - `assertPublicUrl(urlString)` → throw si no es pública; retorna URL object si OK.
 *   - `isPrivateHost(host)` → boolean utilitario.
 *   - `sanitizeUrl(urlString)` → retorna `{ ok: true, url } | { ok: false, reason }`.
 *
 * Cubre:
 *   - IPv4: 127/10/192.168/169.254/172.16-31, 0.0.0.0.
 *   - IPv6: ::1, fc00::/7 (unique-local), fe80::/10 (link-local), :: (unspecified).
 *   - Hostnames: localhost, *.localhost, *.local.
 *   - Protocolos: solo http/https permitidos.
 *
 * No resuelve DNS. Por diseño: si el host es un nombre (ej. `api.github.com`),
 * asumimos público — la resolución puede cambiar post-check (TOCTOU). Protección
 * completa requiere DNS resolution en el fetch (`dns.lookup` con check) — fuera
 * de scope de esta fase; documentado como mejora futura.
 */

const PRIVATE_HOSTNAMES = new Set([
  'localhost', '0.0.0.0', 'ip6-localhost', 'ip6-loopback',
]);

/** @param {string} host */
function isPrivateHost(host) {
  if (!host || typeof host !== 'string') return true;
  const h = host.toLowerCase().replace(/^\[|\]$/g, ''); // strip brackets IPv6

  if (PRIVATE_HOSTNAMES.has(h)) return true;
  if (h.endsWith('.localhost') || h.endsWith('.local')) return true;

  // IPv4 literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split('.').map(Number);
    if (p.some(n => !Number.isFinite(n) || n < 0 || n > 255)) return true;
    if (p[0] === 0)   return true;  // 0.0.0.0/8
    if (p[0] === 127) return true;
    if (p[0] === 10)  return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    return false;
  }

  // IPv6 literal
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    // fc00::/7 (unique-local): primer nibble fc/fd
    if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true;
    // fe80::/10 (link-local): fe80..febf
    if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;
    return false;
  }

  // Hostname ordinario
  return false;
}

/** @returns {URL} */
function assertPublicUrl(urlString) {
  const r = sanitizeUrl(urlString);
  if (!r.ok) throw new Error(`SSRF: ${r.reason}`);
  return r.url;
}

/** @returns {{ ok: true, url: URL } | { ok: false, reason: string }} */
function sanitizeUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') return { ok: false, reason: 'URL inválida' };
  let u;
  try { u = new URL(urlString); }
  catch { return { ok: false, reason: 'URL inválida' }; }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `protocolo no soportado: ${u.protocol}` };
  }
  if (isPrivateHost(u.hostname)) {
    return { ok: false, reason: `host privado bloqueado: ${u.hostname}` };
  }
  return { ok: true, url: u };
}

module.exports = { assertPublicUrl, sanitizeUrl, isPrivateHost };
