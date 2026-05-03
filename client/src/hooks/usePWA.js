import { useState, useEffect, useCallback } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

export function usePWA() {
  const [installPrompt, setInstallPrompt] = useState(null);
  const [isInstalled, setIsInstalled] = useState(false);

  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(r) {
      // Polling cada hora para detectar actualizaciones en segundo plano
      if (r) {
        setInterval(() => r.update(), 60 * 60 * 1000);
      }
    },
  });

  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    const onInstalled = (e) => {
      if (e.matches) setIsInstalled(true);
    };

    window.addEventListener('beforeinstallprompt', onPrompt);

    // Detectar si ya está instalada (standalone mode)
    const mq = window.matchMedia('(display-mode: standalone)');
    setIsInstalled(mq.matches);
    mq.addEventListener('change', onInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      mq.removeEventListener('change', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!installPrompt) return false;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') setInstallPrompt(null);
    return outcome === 'accepted';
  }, [installPrompt]);

  const update = useCallback(() => updateServiceWorker(true), [updateServiceWorker]);

  return { needRefresh, update, canInstall: !!installPrompt && !isInstalled, install, isInstalled };
}
