import { useState, useRef, useCallback, useEffect } from 'react';
import { WS_URL } from '../config';
import { getStoredTokens, isTokenExpired, refreshTokens as refreshAuthTokens } from '../authUtils';

/**
 * Hook para la conexión WebSocket del TelegramPanel (UI de chat).
 * Se conecta con sessionType 'telegram-ui' y recibe eventos en tiempo real
 * cuando llegan mensajes a los bots de Telegram.
 */
export default function useTelegramSocket({ onMessage, onAuthError }) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = async () => {
      let { accessToken } = getStoredTokens();
      if (accessToken && isTokenExpired(accessToken)) {
        try { ({ accessToken } = await refreshAuthTokens()); }
        catch { accessToken = null; onAuthError?.(); }
      }
      ws.send(JSON.stringify({
        type: 'init',
        sessionType: 'telegram-ui',
        ...(accessToken ? { jwt: accessToken } : {}),
      }));
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'auth_error') { onAuthError?.(); return; }
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

  return { connected, send };
}
