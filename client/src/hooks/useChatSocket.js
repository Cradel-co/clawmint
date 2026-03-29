import { useState, useRef, useCallback, useEffect } from 'react';
import { WS_URL } from '../config';
import { getStoredTokens, setStoredTokens, clearStoredTokens, isTokenExpired, refreshTokens } from '../authUtils';

/**
 * Hook para la conexión WebSocket del WebChat.
 * Maneja init, reconexión, y dispatch de mensajes entrantes.
 */
export default function useChatSocket({ onMessage, onAuthError }) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const sessionIdRef = useRef(null);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = async () => {
      const savedSessionId = localStorage.getItem('wc-session-id');
      const authToken = localStorage.getItem('wc-auth-token') || undefined;
      let { accessToken } = getStoredTokens();

      if (accessToken && isTokenExpired(accessToken)) {
        try {
          const refreshed = await refreshAuthTokens();
          accessToken = refreshed.accessToken;
        } catch {
          accessToken = null;
          clearStoredTokens();
          onAuthError?.();
        }
      }

      ws.send(JSON.stringify({
        type: 'init',
        sessionType: 'webchat',
        ...(savedSessionId ? { sessionId: savedSessionId } : {}),
        ...(authToken ? { authToken } : {}),
        ...(accessToken ? { jwt: accessToken } : {}),
      }));
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'session_id') {
          sessionIdRef.current = msg.id;
          localStorage.setItem('wc-session-id', msg.id);
        }
        onMessage?.(msg);
      } catch { /* silenciar */ }
    };

    ws.onclose = () => setConnected(false);
    ws.onerror = () => {};

    return () => ws.close();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback((data) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }, []);

  const getSessionId = useCallback(() => sessionIdRef.current, []);

  const reconnect = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      try { ws.close(); } catch {}
    }
    // El useEffect se encargará de reconectar al re-mount
  }, []);

  return { connected, send, getSessionId, reconnect, wsRef };
}
