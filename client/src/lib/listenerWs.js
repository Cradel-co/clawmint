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

  return () => {
    manager?.disconnect();
    manager = null;
  };
}
