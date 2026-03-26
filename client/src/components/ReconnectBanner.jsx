import { useState, useEffect } from 'react';

export default function ReconnectBanner({ connected }) {
  const [visible, setVisible] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    if (!connected) {
      setVisible(true);
      setShowSuccess(false);
    } else if (visible) {
      // Was disconnected, now reconnected — show success briefly
      setShowSuccess(true);
      const t = setTimeout(() => {
        setVisible(false);
        setShowSuccess(false);
      }, 2000);
      return () => clearTimeout(t);
    }
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!visible) return null;

  return (
    <div className={`reconnect-banner ${showSuccess ? 'reconnect-success' : 'reconnect-warning'}`} role="alert">
      {showSuccess ? (
        <span>✓ Conexión restablecida</span>
      ) : (
        <>
          <span className="reconnect-spinner" />
          <span>Reconectando...</span>
        </>
      )}
    </div>
  );
}
