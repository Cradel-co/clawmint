/**
 * authUtils — utilidades de autenticación para WebChat.
 */
import { API_BASE } from './config';

const ACCESS_TOKEN_KEY  = 'wc-access-token';
const REFRESH_TOKEN_KEY = 'wc-refresh-token';
const USER_KEY          = 'wc-user';

export interface StoredTokens {
  accessToken: string | null;
  refreshToken: string | null;
}

export interface User {
  id: number;
  name: string;
  email: string;
  [key: string]: unknown;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export function getStoredTokens(): StoredTokens {
  return {
    accessToken:  localStorage.getItem(ACCESS_TOKEN_KEY),
    refreshToken: localStorage.getItem(REFRESH_TOKEN_KEY),
  };
}

export function setStoredTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearStoredTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function setStoredUser(user: User): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/**
 * Decodifica el payload de un JWT (sin verificar firma).
 */
export function parseJwt(token: string | null): Record<string, unknown> | null {
  try {
    const base64 = token!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64));
  } catch { return null; }
}

export function isTokenExpired(token: string | null): boolean {
  const payload = parseJwt(token);
  if (!payload || !payload.exp) return true;
  return (payload.exp as number) * 1000 < Date.now();
}

/**
 * Registra un nuevo usuario.
 */
export async function register(email: string, password: string, name: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error al registrar');
  setStoredTokens(data.accessToken, data.refreshToken);
  setStoredUser(data.user);
  return data;
}

/**
 * Login con email y contraseña.
 */
export async function login(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error al iniciar sesión');
  setStoredTokens(data.accessToken, data.refreshToken);
  setStoredUser(data.user);
  return data;
}

/**
 * Renueva tokens usando el refresh token.
 */
export async function refreshTokens(): Promise<AuthResponse> {
  const { refreshToken } = getStoredTokens();
  if (!refreshToken) throw new Error('No hay refresh token');
  const res = await fetch(`${API_BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  const data = await res.json();
  if (!res.ok) {
    clearStoredTokens();
    throw new Error(data.error || 'Error renovando tokens');
  }
  setStoredTokens(data.accessToken, data.refreshToken);
  return data;
}

/**
 * Obtiene el perfil del usuario actual.
 */
export async function fetchMe(): Promise<User | null> {
  const { accessToken } = getStoredTokens();
  if (!accessToken) return null;
  const res = await fetch(`${API_BASE}/api/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * fetch autenticado: agrega Authorization: Bearer <token> automáticamente.
 * Usar en todos los paneles en lugar del fetch() nativo.
 */
export function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const { accessToken } = getStoredTokens();
  const authHeader: Record<string, string> = accessToken
    ? { Authorization: `Bearer ${accessToken}` }
    : {};
  return fetch(url, {
    ...options,
    headers: { ...authHeader, ...(options.headers as Record<string, string> || {}) },
  });
}

/**
 * Vincula una sesión anónima al usuario autenticado.
 */
export async function linkSession(sessionId: string): Promise<boolean> {
  const { accessToken } = getStoredTokens();
  if (!accessToken || !sessionId) return false;
  const res = await fetch(`${API_BASE}/api/auth/link-session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ sessionId }),
  });
  return res.ok;
}
