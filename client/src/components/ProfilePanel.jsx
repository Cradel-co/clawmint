import { useState } from 'react';
import { UserCircle, X } from 'lucide-react';
import { useProfile, useChangePassword } from '../api/profile';
import UserLocationSection from './UserLocationSection.jsx';
import UserRoutinesSection from './UserRoutinesSection.jsx';
import styles from './ProfilePanel.module.css';
import apStyles from './AgentsPanel.module.css';

export default function ProfilePanel({ onClose }) {
  const { data: profile, isLoading } = useProfile();
  const changePassword = useChangePassword();

  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [msg, setMsg] = useState('');
  const [isError, setIsError] = useState(false);

  async function handleChangePassword(e) {
    e.preventDefault();
    setMsg('');
    if (newPw !== confirmPw) { setMsg('Las contraseñas no coinciden'); setIsError(true); return; }
    if (newPw.length < 8) { setMsg('Mínimo 8 caracteres'); setIsError(true); return; }
    try {
      await changePassword.mutateAsync({ currentPassword: currentPw, newPassword: newPw });
      setMsg('Contraseña cambiada');
      setIsError(false);
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
    } catch (err) {
      setMsg('Error: ' + err.message);
      setIsError(true);
    }
  }

  if (isLoading) return <div className={apStyles.panel}><p style={{ padding: 16 }}>Cargando...</p></div>;

  return (
    <div className={apStyles.panel} role="region" aria-label="Panel de perfil">
      <div className={apStyles.header}>
        <span className={apStyles.title}><UserCircle size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />Perfil</span>
        {onClose && <button className={apStyles.close} onClick={onClose} aria-label="Cerrar"><X size={16} /></button>}
      </div>
      <div className={apStyles.body}>
        {msg && <div className={`${styles.msg} ${isError ? styles.msgError : ''}`}>{msg}</div>}

        {profile && (
          <>
            <div className={styles.infoCard}>
              <div className={styles.avatar}>{(profile.name || 'U')[0].toUpperCase()}</div>
              <div className={styles.infoRow}><span className={styles.infoLabel}>Nombre</span><span className={styles.infoValue}>{profile.name || '—'}</span></div>
              <div className={styles.infoRow}><span className={styles.infoLabel}>Email</span><span className={styles.infoValue}>{profile.email}</span></div>
              <div className={styles.infoRow}><span className={styles.infoLabel}>Creado</span><span className={styles.infoValue}>{new Date(profile.created_at).toLocaleDateString()}</span></div>
            </div>
          </>
        )}

        <UserLocationSection />
        <UserRoutinesSection />

        <div className={styles.sectionTitle} style={{ marginTop: 18 }}>Cambiar contraseña</div>
        <form onSubmit={handleChangePassword}>
          <label className={styles.fieldLabel}>Contraseña actual</label>
          <input className={styles.input} type="password" value={currentPw} onChange={e => setCurrentPw(e.target.value)} autoComplete="current-password" />
          <label className={styles.fieldLabel}>Nueva contraseña</label>
          <input className={styles.input} type="password" value={newPw} onChange={e => setNewPw(e.target.value)} autoComplete="new-password" />
          <label className={styles.fieldLabel}>Confirmar nueva</label>
          <input className={styles.input} type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} autoComplete="new-password" />
          <button className={`${apStyles.btn} ${apStyles.btnPrimary}`} type="submit" disabled={changePassword.isPending} style={{ marginTop: 10 }}>
            {changePassword.isPending ? 'Guardando…' : 'Cambiar contraseña'}
          </button>
        </form>
      </div>
    </div>
  );
}
