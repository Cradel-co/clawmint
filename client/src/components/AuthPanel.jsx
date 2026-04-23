import { useState, useEffect } from 'react';
import { LogIn, UserPlus, Mail, Lock, User, Eye, EyeOff, Clock, Ban, Gift } from 'lucide-react';
import { API_BASE } from '../config';
import { login, register, setStoredTokens, setStoredUser } from '../authUtils';
import { invitations as inviteApi } from '../api/admin';
import styles from './AuthPanel.module.css';

export default function AuthPanel({ onAuth, onSkip }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState(null);
  const [errorCode, setErrorCode] = useState(null); // 'pending' | 'disabled' | null
  const [pendingMsg, setPendingMsg] = useState(null); // string | null — set tras register pending
  const [loading, setLoading] = useState(false);
  const [oauthProviders, setOauthProviders] = useState({ google: false, github: false });
  const [inviteCode, setInviteCode] = useState(null);
  const [inviteInfo, setInviteInfo] = useState(null); // { valid, status, family_role, role, expires_at }

  // Detectar ?invite=XXX en URL y validar contra el server
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('invite');
    if (!code) return;
    setInviteCode(code);
    setMode('register'); // forzar tab register
    inviteApi.inspect(code).then(setInviteInfo).catch(() => setInviteInfo({ valid: false, status: 'unknown' }));
  }, []);

  // Cargar providers OAuth disponibles
  useEffect(() => {
    fetch(`${API_BASE}/api/auth/oauth/providers`)
      .then(r => r.json())
      .then(setOauthProviders)
      .catch(() => {});
  }, []);

  // Escuchar postMessage de popup OAuth
  useEffect(() => {
    const handler = (event) => {
      if (event.data?.type === 'oauth_callback') {
        const data = event.data.payload;
        if (data.error) {
          setError(data.error);
        } else if (data.accessToken) {
          setStoredTokens(data.accessToken, data.refreshToken);
          setStoredUser(data.user);
          onAuth(data);
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onAuth]);

  // Check localStorage fallback (si popup no pudo usar postMessage)
  useEffect(() => {
    const check = () => {
      const raw = localStorage.getItem('wc-oauth-result');
      if (raw) {
        localStorage.removeItem('wc-oauth-result');
        try {
          const data = JSON.parse(raw);
          if (data.accessToken) {
            setStoredTokens(data.accessToken, data.refreshToken);
            setStoredUser(data.user);
            onAuth(data);
          } else if (data.error) {
            setError(data.error);
          }
        } catch {}
      }
    };
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [onAuth]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setErrorCode(null);
    setLoading(true);

    try {
      if (mode === 'login') {
        const result = await login(email, password);
        onAuth(result);
      } else {
        const result = await register(email, password, name || undefined, { inviteCode: inviteCode || undefined });
        if (result.pending) {
          // Quedó pendiente de aprobación — mostrar pantalla informativa, no autenticar.
          setPendingMsg(result.message || 'Tu cuenta espera aprobación del administrador.');
        } else {
          // Si se usó una invitación, limpiar URL para no dejar el código visible.
          if (inviteCode && window.history?.replaceState) {
            window.history.replaceState({}, '', window.location.pathname);
          }
          onAuth(result);
        }
      }
    } catch (err) {
      setError(err.message);
      setErrorCode(err.code || null);
    } finally {
      setLoading(false);
    }
  };

  // Pantalla "esperando aprobación" — gateada por pendingMsg, anula el form.
  if (pendingMsg) {
    return (
      <div className={styles.overlay}>
        <div className={styles.brand}>
          <div className={styles.brandLogo}>Claw<span>mint</span></div>
          <div className={styles.brandTagline}>Cuenta creada</div>
          <div className={styles.brandDesc}>
            Tu cuenta fue registrada exitosamente. Ahora necesita aprobación del administrador antes de poder usar Clawmint.
          </div>
        </div>
        <div className={styles.panel}>
          <div className={styles.panelTitle}>
            <Clock size={20} style={{ marginRight: 8, verticalAlign: -4, color: 'var(--accent-orange)' }} />
            Esperando aprobación
          </div>
          <div className={styles.panelSubtitle} style={{ marginTop: 16 }}>
            {pendingMsg}
          </div>
          <div style={{ marginTop: 24, padding: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            <strong>{email}</strong>
            <br /><br />
            Cuando el admin apruebe tu cuenta vas a poder iniciar sesión normalmente. No es necesario registrarse de nuevo.
          </div>
          <button
            className={styles.submit}
            style={{ marginTop: 20 }}
            onClick={() => { setPendingMsg(null); setMode('login'); setPassword(''); setError(null); }}
          >
            Volver al login
          </button>
        </div>
      </div>
    );
  }

  const openOAuth = (provider) => {
    const url = `${API_BASE}/api/auth/oauth/${provider}`;
    const w = 500, h = 600;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top = window.screenY + (window.outerHeight - h) / 2;
    window.open(url, 'oauth', `width=${w},height=${h},left=${left},top=${top}`);
  };

  const hasOAuth = oauthProviders.google || oauthProviders.github;

  return (
    <div className={styles.overlay}>
      {/* Panel izquierdo — branding */}
      <div className={styles.brand}>
        <div className={styles.brandLogo}>Claw<span>mint</span></div>
        <div className={styles.brandTagline}>Tu asistente IA sin límites</div>
        <div className={styles.brandDesc}>
          Desplegá agentes inteligentes, conectá infinitos MCPs,
          automatizá tareas programadas y ampliá capacidades con skills.
        </div>
        <div className={styles.brandFeatures}>
          <div className={styles.brandFeature}>
            <div className={styles.brandFeatureIcon}>🤖</div>
            Agentes IA multi-proveedor con tareas programadas
          </div>
          <div className={styles.brandFeature}>
            <div className={styles.brandFeatureIcon}>🔌</div>
            Conexiones MCP y skills ilimitados
          </div>
          <div className={styles.brandFeature}>
            <div className={styles.brandFeatureIcon}>⚡</div>
            Terminal, Telegram y WebChat integrados
          </div>
        </div>
      </div>

      {/* Panel derecho — formulario */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>
          {mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}
        </div>
        <div className={styles.panelSubtitle}>
          {mode === 'login' ? 'Bienvenido de vuelta' : 'Empezá gratis, sin tarjeta'}
        </div>

        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${mode === 'login' ? styles.active : ''}`}
            onClick={() => { setMode('login'); setError(null); }}
          >
            <LogIn size={14} /> Iniciar sesión
          </button>
          <button
            className={`${styles.tab} ${mode === 'register' ? styles.active : ''}`}
            onClick={() => { setMode('register'); setError(null); }}
          >
            <UserPlus size={14} /> Crear cuenta
          </button>
        </div>

        {hasOAuth && (
          <div className={styles.oauth}>
            {oauthProviders.google && (
              <button className={`${styles.oauthBtn} ${styles.oauthGoogle}`} onClick={() => openOAuth('google')}>
                <GoogleIcon /> Google
              </button>
            )}
            {oauthProviders.github && (
              <button className={`${styles.oauthBtn} ${styles.oauthGithub}`} onClick={() => openOAuth('github')}>
                <GithubIcon /> GitHub
              </button>
            )}
            <div className={styles.divider}><span>o</span></div>
          </div>
        )}

        {inviteCode && inviteInfo && (
          <div style={{
            padding: 12, marginBottom: 12, borderRadius: 8,
            background: inviteInfo.valid ? 'rgba(16, 185, 129, 0.10)' : 'rgba(239, 68, 68, 0.10)',
            border: `1px solid ${inviteInfo.valid ? 'rgba(16, 185, 129, 0.30)' : 'rgba(239, 68, 68, 0.30)'}`,
            color: inviteInfo.valid ? 'var(--accent-green)' : 'var(--accent-red)',
            fontSize: 12.5, lineHeight: 1.5,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, marginBottom: 4 }}>
              <Gift size={14} /> {inviteInfo.valid ? 'Te invitaron a Clawmint' : 'Invitación inválida'}
            </div>
            {inviteInfo.valid ? (
              <>
                {inviteInfo.family_role && <div>Rol: <strong>{inviteInfo.family_role}</strong></div>}
                <div style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>
                  Vas a quedar activo automáticamente al registrarte (sin esperar aprobación).
                </div>
              </>
            ) : (
              <div style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>
                {inviteInfo.status === 'expired' && 'La invitación expiró.'}
                {inviteInfo.status === 'used' && 'La invitación ya fue usada.'}
                {inviteInfo.status === 'revoked' && 'La invitación fue revocada.'}
                {inviteInfo.status === 'not_found' && 'El código no existe.'}
                {' '}Pedí una nueva al administrador o registrate normal (vas a quedar pendiente de aprobación).
              </div>
            )}
          </div>
        )}

        <form className={styles.form} onSubmit={handleSubmit}>
          {mode === 'register' && (
            <div className={styles.field}>
              <User size={14} className={styles.fieldIcon} />
              <input
                type="text"
                placeholder="Nombre"
                value={name}
                onChange={e => setName(e.target.value)}
                autoComplete="name"
              />
            </div>
          )}

          <div className={styles.field}>
            <Mail size={14} className={styles.fieldIcon} />
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div className={styles.field}>
            <Lock size={14} className={styles.fieldIcon} />
            <input
              type={showPass ? 'text' : 'password'}
              placeholder="Contraseña"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
            <button
              type="button"
              className={styles.togglePass}
              onClick={() => setShowPass(!showPass)}
              tabIndex={-1}
            >
              {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>

          {error && (
            <div className={`${styles.error} ${errorCode === 'pending' ? styles.errorPending : ''} ${errorCode === 'disabled' ? styles.errorDisabled : ''}`}>
              {errorCode === 'pending' && <Clock size={14} style={{ marginRight: 6, verticalAlign: -2 }} />}
              {errorCode === 'disabled' && <Ban size={14} style={{ marginRight: 6, verticalAlign: -2 }} />}
              {error}
            </div>
          )}

          <button className={styles.submit} type="submit" disabled={loading}>
            {loading ? 'Cargando...' : mode === 'login' ? 'Entrar' : 'Crear cuenta'}
          </button>
        </form>

        {onSkip && (
          <button className={styles.skip} onClick={onSkip}>
            Continuar sin cuenta
          </button>
        )}
      </div>
    </div>
  );
}

function GithubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}
