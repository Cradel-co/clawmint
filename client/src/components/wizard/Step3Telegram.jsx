import { useState } from 'react';
import { validateTelegramBot, addTelegramBot } from '../../api/firstRun';
import styles from '../WelcomeWizard.module.css';

export default function Step3Telegram({ auth, onNext, onSkip }) {
  const [token, setToken] = useState('');
  const [key, setKey] = useState('default');
  const [botInfo, setBotInfo] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const validate = async () => {
    setErr(null); setBotInfo(null);
    if (!token.trim()) return;
    setLoading(true);
    try {
      const res = await validateTelegramBot({ botToken: token.trim(), token: auth?.accessToken });
      setBotInfo(res.bot || res);
    } catch (e) {
      setErr(`Token inválido: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const add = async () => {
    setErr(null);
    setLoading(true);
    try {
      await addTelegramBot({
        botToken: token.trim(),
        key: key.trim() || 'default',
        defaultAgent: 'claude',
        whitelist: [],
        token: auth?.accessToken,
      });
      onNext();
    } catch (e) {
      setErr(`Error agregando bot: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2>Conectar bot de Telegram</h2>
      <p className={styles.hint}>
        Opcional. El uso principal de Clawmint es via Telegram. Creá un bot con{' '}
        <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>@BotFather</a>{' '}
        y pegá el token acá. Podés skipear y agregarlo desde Settings.
      </p>

      {err && <div className={styles.error}>{err}</div>}
      {botInfo && <div className={styles.success}>Bot válido: @{botInfo.username || botInfo.first_name || 'sin nombre'}</div>}

      <label htmlFor="wz-bot-token">Bot token</label>
      <input
        id="wz-bot-token"
        type="text"
        value={token}
        onChange={e => setToken(e.target.value)}
        placeholder="123456789:ABC-DEF..."
      />

      <label htmlFor="wz-bot-key">Nombre interno del bot (para admin UI)</label>
      <input id="wz-bot-key" type="text" value={key} onChange={e => setKey(e.target.value)} placeholder="default" />

      <div className={styles.actions}>
        <button type="button" className={styles.btnGhost} onClick={onSkip}>Skip →</button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className={styles.btnSecondary} onClick={validate} disabled={loading || !token.trim()}>
            {loading ? 'Validando...' : 'Validar'}
          </button>
          <button type="button" className={styles.btnPrimary} onClick={add} disabled={loading || !botInfo}>
            Agregar bot →
          </button>
        </div>
      </div>
    </div>
  );
}
