'use strict';

const { assertPublicUrl, sanitizeUrl, isPrivateHost } = require('../core/security/ssrfGuard');

describe('isPrivateHost — IPv4', () => {
  test('bloquea loopback 127.x', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('127.1.2.3')).toBe(true);
  });

  test('bloquea rango 10.x', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('10.255.255.254')).toBe(true);
  });

  test('bloquea 192.168.x', () => {
    expect(isPrivateHost('192.168.1.1')).toBe(true);
  });

  test('bloquea 169.254.x link-local', () => {
    expect(isPrivateHost('169.254.169.254')).toBe(true);
  });

  test('bloquea 172.16-31 (RFC1918)', () => {
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
  });

  test('permite 172.32 (fuera del rango privado)', () => {
    expect(isPrivateHost('172.32.0.1')).toBe(false);
  });

  test('permite IPv4 pública', () => {
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('1.1.1.1')).toBe(false);
  });

  test('bloquea 0.0.0.0', () => {
    expect(isPrivateHost('0.0.0.0')).toBe(true);
  });

  test('IPv4 malformado (>255) → bloqueado por seguridad', () => {
    expect(isPrivateHost('999.999.999.999')).toBe(true);
  });
});

describe('isPrivateHost — IPv6', () => {
  test('bloquea ::1 loopback', () => {
    expect(isPrivateHost('::1')).toBe(true);
  });

  test('bloquea :: unspecified', () => {
    expect(isPrivateHost('::')).toBe(true);
  });

  test('bloquea brackets alrededor de ::1', () => {
    expect(isPrivateHost('[::1]')).toBe(true);
  });

  test('bloquea unique-local fc00::/7', () => {
    expect(isPrivateHost('fc00::1')).toBe(true);
    expect(isPrivateHost('fd12:3456:789a::1')).toBe(true);
  });

  test('bloquea link-local fe80::/10', () => {
    expect(isPrivateHost('fe80::1')).toBe(true);
  });

  test('permite IPv6 global', () => {
    expect(isPrivateHost('2001:4860:4860::8888')).toBe(false);
  });
});

describe('isPrivateHost — hostnames', () => {
  test('bloquea localhost', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('LOCALHOST')).toBe(true);
  });

  test('bloquea foo.localhost / foo.local', () => {
    expect(isPrivateHost('foo.localhost')).toBe(true);
    expect(isPrivateHost('printer.local')).toBe(true);
  });

  test('permite hostname público', () => {
    expect(isPrivateHost('api.github.com')).toBe(false);
    expect(isPrivateHost('example.com')).toBe(false);
  });

  test('empty/null bloqueados por default', () => {
    expect(isPrivateHost('')).toBe(true);
    expect(isPrivateHost(null)).toBe(true);
  });
});

describe('sanitizeUrl', () => {
  test('URL pública OK', () => {
    const r = sanitizeUrl('https://api.github.com/repos');
    expect(r.ok).toBe(true);
    expect(r.url.hostname).toBe('api.github.com');
  });

  test('URL privada bloqueada', () => {
    const r = sanitizeUrl('http://localhost:3000/admin');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/localhost/);
  });

  test('protocolo ftp bloqueado', () => {
    const r = sanitizeUrl('ftp://example.com');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/protocolo/);
  });

  test('protocolo file:// bloqueado', () => {
    const r = sanitizeUrl('file:///etc/passwd');
    expect(r.ok).toBe(false);
  });

  test('URL inválida retorna error, no throw', () => {
    const r = sanitizeUrl('not a url');
    expect(r.ok).toBe(false);
  });

  test('null/undefined retorna error', () => {
    expect(sanitizeUrl(null).ok).toBe(false);
    expect(sanitizeUrl(undefined).ok).toBe(false);
    expect(sanitizeUrl('').ok).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  test('retorna URL object para URL pública', () => {
    const u = assertPublicUrl('https://example.com/foo');
    expect(u.hostname).toBe('example.com');
  });

  test('throw para URL privada', () => {
    expect(() => assertPublicUrl('http://127.0.0.1/')).toThrow(/SSRF/);
  });

  test('throw con prefix "SSRF:"', () => {
    try { assertPublicUrl('http://localhost'); }
    catch (e) { expect(e.message).toMatch(/^SSRF:/); }
  });
});
