import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getStoredTokens, setStoredTokens, clearStoredTokens,
  getStoredUser, setStoredUser,
  parseJwt, isTokenExpired,
} from '../authUtils';

// Mock config.js
vi.mock('../config', () => ({ API_BASE: 'http://localhost:3001' }));

describe('authUtils — token storage', () => {
  beforeEach(() => localStorage.clear());

  it('getStoredTokens returns nulls when empty', () => {
    const { accessToken, refreshToken } = getStoredTokens();
    expect(accessToken).toBeNull();
    expect(refreshToken).toBeNull();
  });

  it('setStoredTokens + getStoredTokens roundtrip', () => {
    setStoredTokens('access123', 'refresh456');
    const { accessToken, refreshToken } = getStoredTokens();
    expect(accessToken).toBe('access123');
    expect(refreshToken).toBe('refresh456');
  });

  it('clearStoredTokens removes tokens and user', () => {
    setStoredTokens('a', 'b');
    setStoredUser({ id: 1, name: 'Test' });
    clearStoredTokens();
    const { accessToken, refreshToken } = getStoredTokens();
    expect(accessToken).toBeNull();
    expect(refreshToken).toBeNull();
    expect(getStoredUser()).toBeNull();
  });
});

describe('authUtils — user storage', () => {
  beforeEach(() => localStorage.clear());

  it('getStoredUser returns null when empty', () => {
    expect(getStoredUser()).toBeNull();
  });

  it('setStoredUser + getStoredUser roundtrip', () => {
    const user = { id: 1, name: 'Marcos', email: 'marcos@test.com' };
    setStoredUser(user);
    expect(getStoredUser()).toEqual(user);
  });

  it('getStoredUser returns null on invalid JSON', () => {
    localStorage.setItem('wc-user', 'not-json');
    expect(getStoredUser()).toBeNull();
  });
});

describe('authUtils — JWT parsing', () => {
  function makeJwt(payload, exp) {
    const data = { ...payload, ...(exp !== undefined ? { exp } : {}) };
    const base64 = btoa(JSON.stringify(data))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `header.${base64}.signature`;
  }

  it('parseJwt decodes a valid JWT payload', () => {
    const token = makeJwt({ sub: '123', name: 'Test' });
    const payload = parseJwt(token);
    expect(payload.sub).toBe('123');
    expect(payload.name).toBe('Test');
  });

  it('parseJwt returns null for invalid token', () => {
    expect(parseJwt('not-a-jwt')).toBeNull();
    expect(parseJwt('')).toBeNull();
    expect(parseJwt(null)).toBeNull();
  });

  it('isTokenExpired returns true when no token', () => {
    expect(isTokenExpired(null)).toBe(true);
    expect(isTokenExpired('')).toBe(true);
  });

  it('isTokenExpired returns true for expired token', () => {
    const pastExp = Math.floor(Date.now() / 1000) - 3600;
    const token = makeJwt({}, pastExp);
    expect(isTokenExpired(token)).toBe(true);
  });

  it('isTokenExpired returns false for valid token', () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeJwt({}, futureExp);
    expect(isTokenExpired(token)).toBe(false);
  });

  it('isTokenExpired returns true when no exp claim', () => {
    const token = makeJwt({ sub: '1' });
    expect(isTokenExpired(token)).toBe(true);
  });
});

describe('authUtils — API functions', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('register stores tokens and user on success', async () => {
    const mockResponse = {
      accessToken: 'at', refreshToken: 'rt',
      user: { id: 1, name: 'New' },
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { register } = await import('../authUtils.js');
    const result = await register('test@test.com', 'pass', 'New');

    expect(result.accessToken).toBe('at');
    expect(getStoredTokens().accessToken).toBe('at');
    expect(getStoredUser()).toEqual({ id: 1, name: 'New' });
  });

  it('register throws on failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Email ya existe' }),
    });

    const { register } = await import('../authUtils.js');
    await expect(register('dup@test.com', 'pass', 'X')).rejects.toThrow('Email ya existe');
  });

  it('login stores tokens on success', async () => {
    const mockResponse = {
      accessToken: 'at2', refreshToken: 'rt2',
      user: { id: 2, name: 'Login' },
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { login } = await import('../authUtils.js');
    const result = await login('test@test.com', 'pass');

    expect(result.accessToken).toBe('at2');
    expect(getStoredTokens().refreshToken).toBe('rt2');
  });

  it('login throws on failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Credenciales inválidas' }),
    });

    const { login } = await import('../authUtils.js');
    await expect(login('bad@test.com', 'wrong')).rejects.toThrow('Credenciales inválidas');
  });

  it('refreshTokens clears storage on failure', async () => {
    setStoredTokens('old-at', 'old-rt');
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Token expirado' }),
    });

    const { refreshTokens } = await import('../authUtils.js');
    await expect(refreshTokens()).rejects.toThrow('Token expirado');
    expect(getStoredTokens().accessToken).toBeNull();
  });

  it('refreshTokens throws if no refresh token', async () => {
    const { refreshTokens } = await import('../authUtils.js');
    await expect(refreshTokens()).rejects.toThrow('No hay refresh token');
  });

  it('fetchMe returns null without token', async () => {
    const { fetchMe } = await import('../authUtils.js');
    const result = await fetchMe();
    expect(result).toBeNull();
  });

  it('fetchMe returns user data with valid token', async () => {
    setStoredTokens('valid-token', 'rt');
    const user = { id: 1, name: 'Me' };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(user),
    });

    const { fetchMe } = await import('../authUtils.js');
    const result = await fetchMe();
    expect(result).toEqual(user);
  });

  it('linkSession returns false without token', async () => {
    const { linkSession } = await import('../authUtils.js');
    expect(await linkSession('sess1')).toBe(false);
  });

  it('linkSession returns true on success', async () => {
    setStoredTokens('tok', 'rt');
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    const { linkSession } = await import('../authUtils.js');
    expect(await linkSession('sess1')).toBe(true);
  });
});
