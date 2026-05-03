// admin.js — helpers HTTP para los paneles admin-only (Fase B).
// Cada panel tiene su método en este módulo para centralizar el auth + error handling.

import { API_BASE } from '../config';

function _headers(token, extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function _request(method, path, { token, body, query } = {}) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const res = await fetch(`${API_BASE}${path}${qs}`, {
    method,
    headers: _headers(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || text || `${method} ${path} → ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ── Permissions (admin-only) ───────────────────────────────────────────────
export const permissions = {
  list:     (token) => _request('GET', '/api/permissions', { token }),
  status:   (token) => _request('GET', '/api/permissions/status', { token }),
  create:   (token, rule) => _request('POST', '/api/permissions', { token, body: rule }),
  remove:   (token, id) => _request('DELETE', `/api/permissions/${encodeURIComponent(id)}`, { token }),
};

// ── Hooks (admin-only) ─────────────────────────────────────────────────────
export const hooks = {
  list:     (token) => _request('GET', '/api/hooks', { token }),
  status:   (token) => _request('GET', '/api/hooks/status', { token }),
  create:   (token, hook) => _request('POST', '/api/hooks', { token, body: hook }),
  update:   (token, id, patch) => _request('PATCH', `/api/hooks/${encodeURIComponent(id)}`, { token, body: patch }),
  remove:   (token, id) => _request('DELETE', `/api/hooks/${encodeURIComponent(id)}`, { token }),
  reload:   (token) => _request('POST', '/api/hooks/reload', { token }),
};

// ── Metrics (admin-only) ───────────────────────────────────────────────────
export const metrics = {
  json:     (token) => _request('GET', '/api/metrics/json', { token }),
  // Prometheus raw requiere text parsing; lo dejamos por ahora.
};

// ── Users (admin-only) ─────────────────────────────────────────────────────
export const users = {
  list:         (token) => _request('GET', '/api/auth/admin/users', { token }),
  updateRole:   (token, id, role) => _request('PATCH', `/api/auth/admin/users/${encodeURIComponent(id)}`, { token, body: { role } }),
  remove:       (token, id) => _request('DELETE', `/api/auth/admin/users/${encodeURIComponent(id)}`, { token }),
  approve:      (token, id) => _request('POST',   `/api/auth/admin/users/${encodeURIComponent(id)}/approve`, { token }),
  reject:       (token, id) => _request('POST',   `/api/auth/admin/users/${encodeURIComponent(id)}/reject`, { token }),
  reactivate:   (token, id) => _request('POST',   `/api/auth/admin/users/${encodeURIComponent(id)}/reactivate`, { token }),
  pendingCount: (token) => _request('GET', '/api/auth/admin/users/pending/count', { token }),
};

// ── Workspaces (admin-only) ────────────────────────────────────────────────
export const workspaces = {
  list:      (token) => _request('GET', '/api/workspaces', { token }),
  release:   (token, id) => _request('DELETE', `/api/workspaces/${encodeURIComponent(id)}`, { token }),
};

// ── Invitations (admin-only) ───────────────────────────────────────────────
// Para onboarding familiar — admin genera invite que el invitado usa al registrar.
export const invitations = {
  list:    (token) => _request('GET', '/api/auth/admin/invitations', { token }),
  create:  (token, body) => _request('POST', '/api/auth/admin/invitations', { token, body }),
  revoke:  (token, code) => _request('DELETE', `/api/auth/admin/invitations/${encodeURIComponent(code)}`, { token }),
  // Público (sin token): chequea status de un código antes de mostrar el form.
  inspect: (code) => _request('GET', `/api/auth/invitations/${encodeURIComponent(code)}`),
};
