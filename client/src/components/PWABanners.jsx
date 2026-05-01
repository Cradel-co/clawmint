import { usePWA } from '../hooks/usePWA';
import styles from './PWABanners.module.css';

export default function PWABanners() {
  const { needRefresh, update, canInstall, install } = usePWA();

  return (
    <>
      {needRefresh && (
        <div className={styles.updateBanner} role="alert">
          <span>Nueva versión disponible</span>
          <button className={styles.updateBtn} onClick={update}>Actualizar</button>
        </div>
      )}
      {canInstall && (
        <button className={styles.installBtn} onClick={install} aria-label="Instalar Clawmint como app">
          <span className={styles.installIcon}>⊕</span>
          <span className={styles.installLabel}>Instalar app</span>
        </button>
      )}
    </>
  );
}
