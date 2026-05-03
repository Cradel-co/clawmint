/**
 * WS Listener global — escucha eventos del servidor (telegram_session, etc.)
 * Reemplaza el useEffect WS de App.jsx.
 */
import { WsManager } from './wsManager';
import { WS_URL } from '../config';
import { useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';

let manager = null;

export function initListenerWs() {
  if (manager) return () => {};

  manager = new WsManager({
    url: WS_URL,
    buildInitPayload: () => ({ type: 'init', sessionType: 'listener' }),
    onStatusChange: (connected) => {
      useUIStore.getState().setWsConnected(connected);
    },
  });

  manager.subscribe('telegram_session', (msg) => {
    const { section } = useUIStore.getState();
    if (section !== 'telegram') {
      useUIStore.getState().incrementTelegramBadge();
    }
    useSessionStore.getState().addTelegramSession(msg.sessionId, msg.from);
  });

  manager.connect();

  // Forzar reconexión cuando el user vuelve a la tab o cuando vuelve la red.
  // Cubre el caso típico: la tab estaba en background, el server se reinició,
  // los retries quedaron en cooldown de 30s — al volver a foreground, reset.
  const onVisibility = () => {
    if (!document.hidden && manager && !manager.connected) {
      manager.forceReconnect();
    }
  };
  const onOnline = () => {
    if (manager && !manager.connected) manager.forceReconnect();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);

  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    manager?.disconnect();
    manager = null;
  };
}
