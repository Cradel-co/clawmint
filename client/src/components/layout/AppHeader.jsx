import { useState, useRef, useEffect, useCallback } from 'react';
import { Sun, Moon, LogIn, LogOut, Menu, X, Settings } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import { useUIStore } from '../../stores/uiStore';
import styles from '../../App.module.css';

export default function AppHeader() {
  const { theme, toggleTheme } = useTheme();
  const { user, setShowAuthPanel, handleLogout } = useAuth();
  const wsConnected = useUIStore((s) => s.wsConnected);
  const setSection = useUIStore((s) => s.setSection);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  // Cerrar al hacer click fuera
  useEffect(() => {
    if (!menuOpen) return;
    const onClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onClickOutside);
    return () => document.removeEventListener('pointerdown', onClickOutside);
  }, [menuOpen]);

  // Cerrar si sale de mobile
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = () => { if (!mq.matches) setMenuOpen(false); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const handleTheme = useCallback(() => { toggleTheme(); setMenuOpen(false); }, [toggleTheme]);
  const handleLogin = useCallback(() => { setShowAuthPanel(true); setMenuOpen(false); }, [setShowAuthPanel]);
  const handleConfig = useCallback(() => { setSection('config'); setMenuOpen(false); }, [setSection]);
  const onLogout = useCallback(() => { handleLogout(); setMenuOpen(false); }, [handleLogout]);

  return (
    <header className={styles.appHeader}>
      <span className={`${styles.dot} ${styles.dotRed}`}    aria-hidden="true" />
      <span className={`${styles.dot} ${styles.dotYellow}`} aria-hidden="true" />
      <span className={`${styles.dot} ${styles.dotGreen}`}  aria-hidden="true" />
      <h1 className={styles.title}><span>Claw</span><em>mint</em></h1>
      <span
        className={`${styles.wsStatusDot}${wsConnected ? '' : ` ${styles.disconnected}`}`}
        title={wsConnected ? 'Conectado' : 'Sin conexión'}
        aria-label={wsConnected ? 'Servidor conectado' : 'Sin conexión al servidor'}
      />

      {/* Desktop: opciones inline */}
      <div className={styles.headerRight}>
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
        >
          {theme === 'dark'
            ? <Sun  size={16} aria-hidden="true" />
            : <Moon size={16} aria-hidden="true" />}
        </button>
      </div>

      {/* Mobile: hamburger menu */}
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
