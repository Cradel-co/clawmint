// advanced.js — helpers HTTP para los paneles de Fase E (config avanzada).

import { API_BASE } from '../config';

function _headers(token, extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function _request(method, path, { token, body, query } = {}) {
  const qs = query
    ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([, v]) => v != null && v !== ''))).toString()
    : '';
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

// ── Config (E.1 + E.2) ─────────────────────────────────────────────────────
export const config = {
  compaction: {
    get: (token) => _request('GET', '/api/config/compaction', { token }),
    set: (token, body) => _request('PUT', '/api/config/compaction', { token, body }),
  },
  modelTiers: {
    get: (token) => _request('GET', '/api/config/model-tiers', { token }),
    set: (token, body) => _request('PUT', '/api/config/model-tiers', { token, body }),
  },
  features: (token) => _request('GET', '/api/config/features', { token }),
};

// ── Tools admin (E.3) ──────────────────────────────────────────────────────
export const toolsAdmin = {
  list:   (token) => _request('GET', '/api/tools/all', { token }),
  toggle: (token, name, disabled) => _request('POST', '/api/tools/toggle', { token, body: { name, disabled } }),
};

// ── LSP (E.4) ──────────────────────────────────────────────────────────────
export const lsp = {
  status:  (token) => _request('GET', '/api/lsp/status', { token }),
  detect:  (token) => _request('POST', '/api/lsp/detect', { token }),
  shutdown: (token) => _request('POST', '/api/lsp/shutdown', { token }),
};

// ── Orchestration (E.5) ────────────────────────────────────────────────────
export const orchestration = {
  workflows:    (token) => _request('GET', '/api/orchestration/workflows', { token }),
  cancel:       (token, id) => _request('POST', `/api/orchestration/workflows/${encodeURIComponent(id)}/cancel`, { token }),
};
