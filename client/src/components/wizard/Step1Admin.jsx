import { useState } from 'react';
import { registerFirstAdmin } from '../../api/firstRun';
import styles from '../WelcomeWizard.module.css';

export default function Step1Admin({ onDone }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) return setErr('La contraseña debe tener al menos 8 caracteres');
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
      return setErr('La contraseña debe contener letras y números');
    if (password !== password2) return setErr('Las contraseñas no coinciden');

    setLoading(true);
    try {
      const res = await registerFirstAdmin({ email, password, name });
      // Defensa: si el server devuelve pending (DB no estaba vacía por race),
      // no podemos tratar al usuario como admin con tokens vacíos.
      if (res.pending || !res.accessToken) {
        setErr('Esta instalación ya tiene un administrador. Volvé al inicio para loguearte normalmente.');
        return;
      }
      onDone({ accessToken: res.accessToken, user: res.user });
    } catch (e) {
      setErr(e.message || 'Error al crear admin');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <h2>Crear cuenta administrador</h2>
      <p className={styles.hint}>
        Es la primera cuenta de esta instalación de Clawmint. Tendrá acceso completo
        al panel, permisos, MCPs y configuración del service.
      </p>

      {err && <div className={styles.error}>{err}</div>}

      <label htmlFor="wz-name">Nombre (opcional)</label>
      <input id="wz-name" type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Brian" />

      <label htmlFor="wz-email">Email *</label>
      <input id="wz-email" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />

      <label htmlFor="wz-pw">Contraseña *</label>
      <input id="wz-pw" type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} />

      <label htmlFor="wz-pw2">Repetir contraseña *</label>
      <input id="wz-pw2" type="password" value={password2} onChange={e => setPassword2(e.target.value)} required />

      <div className={styles.actions}>
        <span />
        <button type="submit" className={styles.btnPrimary} disabled={loading || !email || !password}>
          {loading ? 'Creando...' : 'Crear admin →'}
        </button>
      </div>
    </form>
  );
}
