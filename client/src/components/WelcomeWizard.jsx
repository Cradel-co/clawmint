import { useState } from 'react';
import Step1Admin from './wizard/Step1Admin.jsx';
import Step2Providers from './wizard/Step2Providers.jsx';
import Step3Telegram from './wizard/Step3Telegram.jsx';
import Step4Done from './wizard/Step4Done.jsx';
import styles from './WelcomeWizard.module.css';

/**
 * WelcomeWizard — flujo de 4 pasos para la primera configuración.
 *
 * Se muestra cuando `GET /api/auth/status` devuelve `firstRun: true`. Al
 * completar paso 1 el server marca al primer user como admin y emite JWT;
 * los pasos 2-4 son skippables y usan el token para guardar API keys, bot
 * Telegram, etc.
 *
 * Al terminar (o skip final), llama `onComplete({ accessToken, user })` para
 * que el App principal haga `handleAuth(...)` y cargue el panel normal.
 */
export default function WelcomeWizard({ onComplete }) {
  const [step, setStep] = useState(1);
  const [auth, setAuth] = useState(null); // { accessToken, user } post-register

  const next = () => setStep(s => Math.min(4, s + 1));
  const skip = () => next();
  const finish = () => {
    if (onComplete && auth) onComplete(auth);
    else if (onComplete) onComplete(null);
  };

  const handleAdminCreated = (authData) => {
    setAuth(authData);
    next();
  };

  return (
    <div className={styles.root}>
      <div className={styles.card}>
        <header className={styles.header}>
          <div className={styles.logo}>Clawmint</div>
          <div className={styles.progress} aria-label={`Paso ${step} de 4`}>
            {[1, 2, 3, 4].map(n => (
              <span key={n} className={n === step ? styles.dotActive : (n < step ? styles.dotDone : styles.dot)} />
            ))}
          </div>
        </header>
        <main className={styles.body}>
          {step === 1 && <Step1Admin onDone={handleAdminCreated} />}
          {step === 2 && <Step2Providers auth={auth} onNext={next} onSkip={skip} />}
          {step === 3 && <Step3Telegram auth={auth} onNext={next} onSkip={skip} />}
          {step === 4 && <Step4Done auth={auth} onFinish={finish} />}
        </main>
      </div>
    </div>
  );
}
