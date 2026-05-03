import { useEffect, useState } from 'react';
import styles from '../WelcomeWizard.module.css';

export default function Step4Done({ auth, onFinish }) {
  const [lanUrls, setLanUrls] = useState([]);

  useEffect(() => {
    // Best-effort: leer window.location para el URL actual; ésto funciona tanto
    // en dev (http://localhost:5173) como en packaged (tauri localhost:3001).
    const urls = new Set();
    urls.add(window.location.origin);
    // El server expone /api/system/lan-addresses (si existe) para detectar las IPs de LAN.
    // Fallback: showen solo localhost.
    fetch('/api/system/lan-addresses', {
      headers: auth?.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {},
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && Array.isArray(data.addresses)) {
          for (const addr of data.addresses) urls.add(`http://${addr}:${window.location.port || 3001}`);
        }
        setLanUrls(Array.from(urls));
      })
      .catch(() => setLanUrls(Array.from(urls)));
  }, [auth]);

  return (
    <div>
      <h2>¡Clawmint listo! 🎉</h2>
      <p className={styles.hint}>
        El server ya está corriendo en segundo plano. Podés:
      </p>

      <ul style={{ paddingLeft: 20, lineHeight: 1.8 }}>
        <li>Acceder al panel desde cualquier dispositivo de la LAN.</li>
        <li>Usar tu bot de Telegram para chatear con los agentes.</li>
        <li>Minimizar esta ventana — el service sigue activo en segundo plano.</li>
        <li>Agregar MCPs, skills, permisos y más desde Settings.</li>
      </ul>

      <div className={styles.urlList}>
        <strong>URLs del panel:</strong>
        {lanUrls.length === 0
          ? <div>{window.location.origin}</div>
          : lanUrls.map(u => (
              <div key={u}><a href={u} target="_blank" rel="noopener noreferrer">{u}</a></div>
            ))
        }
      </div>

      <div className={styles.actions}>
        <span />
        <button type="button" className={styles.btnPrimary} onClick={onFinish}>Abrir panel →</button>
      </div>
    </div>
  );
}
