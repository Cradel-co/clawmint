// household.js — helpers HTTP para datos compartidos del hogar.
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';

async function _request(method, path, body) {
  const res = await apiFetch(`${API_BASE}/api/household${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || text || `${method} ${path} → ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const household = {
  summary:    () => _request('GET', '/summary'),
  upcoming:   (days = 7) => _request('GET', `/upcoming?days=${days}`),
  list:       (kind, query = {}) => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([, v]) => v != null && v !== ''))).toString();
    return _request('GET', `/${kind}${qs ? '?' + qs : ''}`);
  },
  create:     (kind, body) => _request('POST',   `/${kind}`, body),
  update:     (kind, id, body) => _request('PATCH',  `/${kind}/${encodeURIComponent(id)}`, body),
  remove:     (kind, id) => _request('DELETE', `/${kind}/${encodeURIComponent(id)}`),
  complete:   (kind, id) => _request('POST',   `/${kind}/${encodeURIComponent(id)}/complete`),
  uncomplete: (kind, id) => _request('POST',   `/${kind}/${encodeURIComponent(id)}/uncomplete`),
};
