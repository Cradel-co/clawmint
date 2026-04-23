// features.js — helpers HTTP para los paneles de Fase C (features activos).

import { API_BASE } from '../config';

function _headers(token, extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function _request(method, path, { token, body, query } = {}) {
  const qs = query ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''))).toString() : '';
  const res = await fetch(`${API_BASE}${path}${qs}`, {
    method,
    headers: _headers(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || text || `${method} ${path} → ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ── Tasks (C.1) ────────────────────────────────────────────────────────────
export const tasks = {
  list:    (token, query) => _request('GET', '/api/tasks', { token, query }),
  get:     (token, id, chat_id) => _request('GET', `/api/tasks/${id}`, { token, query: { chat_id } }),
  create:  (token, body) => _request('POST', '/api/tasks', { token, body }),
  update:  (token, id, body) => _request('PATCH', `/api/tasks/${id}`, { token, body }),
  remove:  (token, id, chat_id) => _request('DELETE', `/api/tasks/${id}`, { token, query: { chat_id } }),
};

// ── Typed Memory (C.3) ─────────────────────────────────────────────────────
export const typedMemory = {
  list:    (token, query) => _request('GET', '/api/typed-memory', { token, query }),
  get:     (token, id) => _request('GET', `/api/typed-memory/${id}`, { token }),
  create:  (token, body) => _request('POST', '/api/typed-memory', { token, body }),
  update:  (token, id, body) => _request('PATCH', `/api/typed-memory/${id}`, { token, body }),
  remove:  (token, id) => _request('DELETE', `/api/typed-memory/${id}`, { token }),
};

// ── Sessions + sharing (C.4) ───────────────────────────────────────────────
export const sessions = {
  list:        (token) => _request('GET', '/api/sessions', { token }),
  share:       (token, id, body) => _request('POST', `/api/sessions/${id}/share`, { token, body }),
  listShares:  (token) => _request('GET', '/api/session-share', { token }),
  getShare:    (token, tokenId) => _request('GET', `/api/session-share/${tokenId}`, { token }),
  revokeShare: (token, tokenId) => _request('DELETE', `/api/session-share/${tokenId}`, { token }),
};

// ── Skills (C.5) ───────────────────────────────────────────────────────────
export const skills = {
  list:    (token) => _request('GET', '/api/skills', { token }),
  search:  (token, q) => _request('GET', '/api/skills/search', { token, query: { q } }),
  install: (token, body) => _request('POST', '/api/skills/install', { token, body }),
  remove:  (token, slug) => _request('DELETE', `/api/skills/${encodeURIComponent(slug)}`, { token }),
};

// ── MCP OAuth (C.6) ────────────────────────────────────────────────────────
export const mcpAuth = {
  providers: (token) => _request('GET', '/api/mcp-auth/providers', { token }),
  start:     (token, provider, body) => _request('POST', `/api/mcp-auth/start/${encodeURIComponent(provider)}`, { token, body }),
  status:    (token, state) => _request('GET', `/api/mcp-auth/status/${encodeURIComponent(state)}`, { token }),
};

// ── Scheduler (C.2) ────────────────────────────────────────────────────────
// El server no tiene /api/scheduled dedicated; las cron jobs viven en
// scheduled_actions (vía tools) y en tasks normales. Documentar una ruta que
// el server pueda exponer en el futuro; por ahora el panel muestra reminders +
// resumable_sessions (que sí tiene datos visibles).
export const scheduler = {
  // Placeholder para cuando exista /api/scheduled-actions. Por ahora el
  // panel se apoya en /api/reminders existente y stubs.
  reminders: (token) => _request('GET', '/api/reminders', { token }),
};
