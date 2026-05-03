import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../config';
import { getStoredTokens } from '../authUtils';

/**
 * Hook que sondea /api/system/stats en un intervalo.
 * Pausa automáticamente cuando la pestaña está oculta.
 *
 * @param {number} intervalMs — ms entre polls (default 5000)
 * @returns {{ stats: object|null, error: Error|null, loading: boolean }}
 */
export function useSystemStats(intervalMs = 5000) {
  const [stats, setStats]     = useState(null);
  const [error, setError]     = useState(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    const fetchStats = async () => {
      try {
        const token = getStoredTokens()?.accessToken;
        if (!token) { setLoading(false); return; }
        abortRef.current?.abort();
        abortRef.current = new AbortController();
        const res = await fetch(`${API_BASE}/api/system/stats`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortRef.current.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) { setStats(data); setError(null); setLoading(false); }
      } catch (e) {
        if (e.name === 'AbortError' || cancelled) return;
        setError(e);
        setLoading(false);
      }
    };

    const start = () => {
      fetchStats();
      timerRef.current = setInterval(fetchStats, intervalMs);
    };
    const stop = () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else if (!timerRef.current) start();
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      stop();
      abortRef.current?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);

  return { stats, error, loading };
}
