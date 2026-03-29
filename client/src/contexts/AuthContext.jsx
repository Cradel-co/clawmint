import { createContext, useContext, useState, useCallback, useEffect, useRef,  } from 'react';
import {
  getStoredUser, setStoredUser, getStoredTokens, setStoredTokens,
  clearStoredTokens, refreshTokens, linkSession,
} from '../authUtils';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => getStoredUser());
  const [showAuthPanel, setShowAuthPanel] = useState(false);
  const wsRef = useRef(null);

  const setWsRef = useCallback((ref) => { wsRef.current = ref; }, []);

  // Refresh proactivo del JWT antes de que expire
  useEffect(() => {
    const { accessToken } = getStoredTokens();
    if (!accessToken) return;

    const payload = (() => {
      try {
        const b = accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(atob(b));
      } catch { return null; }
    })();
    if (!payload?.exp) return;

    const expiresIn = payload.exp * 1000 - Date.now();
    const refreshIn = Math.max(expiresIn - 2 * 60 * 1000, 5000);

    const timer = setTimeout(async () => {
      try {
        const refreshed = await refreshAuthTokens();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'auth:refresh', refreshToken: refreshed.refreshToken }));
        }
      } catch {
        clearStoredTokens();
        setUser(null);
      }
    }, refreshIn);

    return () => clearTimeout(timer);
  }, [user]);

  const handleAuth = useCallback(async (result, sessionId = null) => {
    setUser(result.user);
    setShowAuthPanel(false);

    if (sessionId && sessionId !== String(result.user.id)) {
      try { await linkSession(sessionId); } catch {}
    }
  }, []);

  const handleLogout = useCallback(() => {
    clearStoredTokens();
    setUser(null);
  }, []);

  const handleWsAuthMessage = useCallback((msg) => {
    switch (msg.type) {
      case 'session_id':
        if (msg.user) {
          setUser(msg.user);
          setStoredUser(msg.user);
        }
        break;
      case 'auth:tokens':
        if (msg.accessToken) {
          setStoredTokens(msg.accessToken, msg.refreshToken);
        }
        break;
      case 'auth_error':
        if (msg.code === 'TOKEN_EXPIRED' || msg.code === 'REFRESH_FAILED') {
          clearStoredTokens();
          setUser(null);
          setShowAuthPanel(true);
        }
        break;
      case 'session_taken':
        break;
    }
  }, []);

  return (
    <AuthContext.Provider value={{
      user, showAuthPanel, setShowAuthPanel,
      handleAuth, handleLogout, handleWsAuthMessage, setWsRef,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
