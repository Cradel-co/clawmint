import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import {
  getStoredUser, setStoredUser, getStoredTokens, setStoredTokens,
  clearStoredTokens, refreshTokens as refreshAuthTokens, linkSession,
} from '../authUtils';
import type { User } from '../authUtils';

interface AuthContextValue {
  user: User | null;
  showAuthPanel: boolean;
  setShowAuthPanel: (v: boolean) => void;
  handleAuth: (result: { user: User }, sessionId?: string | null) => Promise<void>;
  handleLogout: () => void;
  handleWsAuthMessage: (msg: any) => void;
  setWsRef: (ref: WebSocket | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => getStoredUser());
  const [showAuthPanel, setShowAuthPanel] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const setWsRef = useCallback((ref: WebSocket | null) => { wsRef.current = ref; }, []);

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

  const handleAuth = useCallback(async (result: { user: User }, sessionId?: string | null) => {
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

  const handleWsAuthMessage = useCallback((msg: any) => {
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

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
