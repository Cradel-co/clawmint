import { useState, useRef, useEffect, useCallback } from 'react';
import { Sun, Moon, LogIn, LogOut, Menu, X, Settings, Search, Bell, Power } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import { useUIStore } from '../../stores/uiStore';
import { users as adminUsersApi } from '../../api/admin';
import { getStoredTokens } from '../../authUtils';
import styles from '../../App.module.css';

export default function AppHeader() {
  const { theme, toggleTheme } = useTheme();
  const { user, setShowAuthPanel, handleLogout } = useAuth();
  const wsConnected = useUIStore((s) => s.wsConnected);
  const setSection = useUIStore((s) => s.setSection);
  const setConfigTab = useUIStore((s) => s.setConfigTab);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const menuRef = useRef(null);

  // Polling de pending users count solo si el user es admin.
  // Polling cada 30s, pausa cuando la pestaña está oculta.
  useEffect(() => {
    if (user?.role !== 'admin') return;
    const token = getStoredTokens()?.accessToken;
    if (!token) return;
    let cancelled = false;
    let timer = null;
    const fetchCount = async () => {
      try {
        const data = await adminUsersApi.pendingCount(token);
        if (!cancelled) setPendingCount(Number(data?.count) || 0);
      } catch { /* noop — no rompemos el header */ }
    };
    const start = () => { fetchCount(); timer = setInterval(fetchCount, 30000); };
    const stop  = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVis = () => { if (document.hidden) stop(); else if (!timer) start(); };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [user]);

  const goPending = useCallback(() => {
    if (user?.role !== 'admin' || pendingCount === 0) return;
    setSection('config', { configTab: 'users' });
  }, [user, pendingCount, setSection]);

  useEffect(() => {
    if (!menuOpen) return;
    const onClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onClickOutside);
    return () => document.removeEventListener('pointerdown', onClickOutside);
  }, [menuOpen]);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = () => { if (!mq.matches) setMenuOpen(false); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const handleTheme  = useCallback(() => { toggleTheme(); setMenuOpen(false); }, [toggleTheme]);
  const handleLogin  = useCallback(() => { setShowAuthPanel(true); setMenuOpen(false); }, [setShowAuthPanel]);
  const handleConfig = useCallback(() => { setSection('config'); setMenuOpen(false); }, [setSection]);
  const onLogout     = useCallback(() => { handleLogout(); setMenuOpen(false); }, [handleLogout]);
  const goDashboard  = useCallback(() => setSection('dashboard'), [setSection]);

  return (
    <header className={styles.appHeader}>
      <button className={styles.brand} onClick={goDashboard} aria-label="Ir al dashboard">
        <span className={styles.brandMark} aria-hidden="true" />
        <span className={styles.brandName}>Claw<em>mint</em></span>
        <span className={styles.brandVersion}>v1.0</span>
      </button>

      <div className={styles.headerSearch} role="search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          placeholder="Buscar agentes, sesiones, comandos…"
          className={styles.headerSearchInput}
          aria-label="Buscar"
        />
        <kbd className={styles.headerSearchKbd}>⌘K</kbd>
      </div>

      <div className={styles.headerRight}>
        <div
          className={`${styles.healthPill} ${wsConnected ? styles.healthOk : styles.healthDown}`}
          title={wsConnected ? 'Servidor conectado' : 'Sin conexión'}
          aria-label={wsConnected ? 'Health OK' : 'Health DOWN'}
        >
          <span className={styles.healthDot} />
          <span>Health</span>
          <strong>{wsConnected ? 'OK' : 'DOWN'}</strong>
        </div>

        <button
          className={styles.headerIconBtn}
          onClick={goPending}
          aria-label={pendingCount > 0 ? `${pendingCount} usuarios pendientes de aprobación` : 'Notificaciones'}
          title={pendingCount > 0 ? `${pendingCount} pendiente(s) de aprobación` : 'Notificaciones'}
          style={{ position: 'relative' }}
        >
          <Bell size={15} aria-hidden="true" />
          {pendingCount > 0 && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute', top: 2, right: 2,
                minWidth: 14, height: 14, padding: '0 4px',
                borderRadius: 999,
                background: 'var(--accent-red)',
                color: '#fff',
                fontSize: 9, fontWeight: 800,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                lineHeight: 1,
              }}
            >
              {pendingCount > 99 ? '99+' : pendingCount}
            </span>
          )}
        </button>

        {user ? (
          <div className={styles.headerUser} aria-label={`Usuario: ${user.name}`}>
            <span className={styles.headerUserAvatar}>{(user.name || 'U')[0].toUpperCase()}</span>
            <span className={styles.headerUserName}>{user.name}</span>
          </div>
        ) : (
          <button
            className={`${styles.headerIconBtn} ${styles.headerLoginBtn}`}
            onClick={() => setShowAuthPanel(true)}
            aria-label="Iniciar sesión"
          >
            <LogIn size={14} aria-hidden="true" />
            <span className={styles.headerLoginLabel}>Entrar</span>
          </button>
        )}

        <button
          className={styles.headerIconBtn}
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
          title={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}
        >
          {theme === 'dark' ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
        </button>

        {user && (
          <button
            className={`${styles.headerIconBtn} ${styles.headerPowerBtn}`}
            onClick={handleLogout}
            aria-label="Cerrar sesión"
            title="Cerrar sesión"
          >
            <Power size={15} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Mobile hamburger */}
      <div className={styles.headerMobileMenu} ref={menuRef}>
        <button
          className={styles.headerBurgerBtn}
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
          aria-expanded={menuOpen}
        >
          {menuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>

        {menuOpen && (
          <div className={styles.headerDropdown}>
            {user ? (
              <div className={styles.dropdownUser}>
                <span className={styles.headerUserAvatar}>{(user.name || 'U')[0].toUpperCase()}</span>
                <span>{user.name}</span>
              </div>
            ) : (
              <button className={styles.dropdownItem} onClick={handleLogin}>
                <LogIn size={16} aria-hidden="true" />
                <span>Iniciar sesión</span>
              </button>
            )}
            <button className={styles.dropdownItem} onClick={handleConfig}>
              <Settings size={16} aria-hidden="true" />
              <span>Configuración</span>
            </button>
            <button className={styles.dropdownItem} onClick={handleTheme}>
              {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
              <span>{theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}</span>
            </button>
            {user && (
              <button className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`} onClick={onLogout}>
                <LogOut size={16} aria-hidden="true" />
                <span>Cerrar sesión</span>
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
