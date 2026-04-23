// Clawmint client config — URL del server y helpers de status.
//
// En dev sin override: apunta a `<host-del-client>:3001` (same host, puerto del server).
// En packaged (Tauri): el webview carga `http://localhost:3001` directo, y este
// archivo también resuelve a localhost:3001 porque window.location.hostname === 'localhost'.
// Override: VITE_SERVER_URL=host:port en .env.local.

const SERVER_HOST = import.meta.env.VITE_SERVER_URL || `${window.location.hostname}:3001`;
export const API_BASE = `http://${SERVER_HOST}`;
export const WS_URL = `ws://${SERVER_HOST}`;

/**
 * Fetch público (sin auth) a /api/auth/status — detecta si la DB del server
 * está vacía (first run). Retorna { firstRun, version } o lanza si el server
 * todavía no responde (el caller decide: retry o error UI).
 */
export async function fetchServerStatus() {
  const res = await fetch(`${API_BASE}/api/auth/status`, { credentials: 'omit' });
  if (!res.ok) throw new Error(`status endpoint returned ${res.status}`);
  return res.json();
}
