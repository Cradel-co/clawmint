import { useState, useEffect, useRef } from 'react';

const INITIAL_GRACE_MS = 1500;

export default function ReconnectBanner({ connected }) {
  const [visible, setVisible] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [graceOver, setGraceOver] = useState(false);
  const everConnected = useRef(false);

  // Grace inicial: durante los primeros 1.5s del mount, no mostramos el banner
  // de "Reconectando" para no parpadear durante el bootstrap del WS.
  // Si llega el primer connected=true antes, también cancela el grace.
  useEffect(() => {
    const t = setTimeout(() => setGraceOver(true), INITIAL_GRACE_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (connected) {
      everConnected.current = true;
      if (visible) {
        // Estaba desconectado y volvió → mostrar "✓ Conexión restablecida" 2s.
        setShowSuccess(true);
        const t = setTimeout(() => {
          setVisible(false);
          setShowSuccess(false);
        }, 2000);
        return () => clearTimeout(t);
      }
    } else {
      // No conectado: solo mostrar si pasó el grace inicial O si ya estuvimos conectados antes.
      if (graceOver || everConnected.current) {
        setVisible(true);
        setShowSuccess(false);
      }
    }
  }, [connected, graceOver]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!visible) return null;

  return (
    <div className={`reconnect-banner ${showSuccess ? 'reconnect-success' : 'reconnect-warning'}`} role="alert">
      {showSuccess ? (
        <span>✓ Conexión restablecida</span>
      ) : (
        <>
          <span className="reconnect-spinner" />
          <span>Reconectando…</span>
        </>
      )}
    </div>
  );
}
