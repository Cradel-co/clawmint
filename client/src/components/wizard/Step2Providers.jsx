import { useState } from 'react';
import { saveProviderKey } from '../../api/firstRun';
import styles from '../WelcomeWizard.module.css';

const PROVIDERS = [
  { key: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-...' },
  { key: 'openai',    label: 'OpenAI',    placeholder: 'sk-...' },
  { key: 'gemini',    label: 'Gemini',    placeholder: 'AIza...' },
  { key: 'grok',      label: 'Grok (xAI)', placeholder: 'xai-...' },
  { key: 'deepseek',  label: 'DeepSeek',  placeholder: 'sk-...' },
  { key: 'ollama',    label: 'Ollama',    placeholder: 'http://localhost:11434 (sin key)' },
];

export default function Step2Providers({ auth, onNext, onSkip }) {
  const [active, setActive] = useState('anthropic');
  const [keys, setKeys] = useState({});
  const [saved, setSaved] = useState({});
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  const current = PROVIDERS.find(p => p.key === active);
  const currentValue = keys[active] || '';

  const saveCurrent = async () => {
    setErr(null);
    if (!currentValue.trim()) return;
    setSaving(true);
    try {
      await saveProviderKey({ provider: active, apiKey: currentValue.trim(), token: auth?.accessToken });
      setSaved(s => ({ ...s, [active]: true }));
    } catch (e) {
      setErr(`Error guardando ${active}: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2>Configurar LLM providers</h2>
      <p className={styles.hint}>
        Agregá al menos un API key. Podés skipear y hacerlo después desde Settings.
      </p>

      <div className={styles.providerTabs}>
        {PROVIDERS.map(p => (
          <button
            key={p.key}
            type="button"
            onClick={() => { setActive(p.key); setErr(null); }}
            className={active === p.key ? styles.providerTabActive : (saved[p.key] ? styles.providerTabDone : styles.providerTab)}
          >
            {saved[p.key] && '✓ '}{p.label}
          </button>
        ))}
      </div>

      {err && <div className={styles.error}>{err}</div>}
      {saved[active] && <div className={styles.success}>{current.label} guardado</div>}

      <label htmlFor="wz-key">API key para {current.label}</label>
      <input
        id="wz-key"
        type="password"
        value={currentValue}
        onChange={e => setKeys({ ...keys, [active]: e.target.value })}
        placeholder={current.placeholder}
      />

      <div className={styles.actions}>
        <button type="button" className={styles.btnGhost} onClick={onSkip}>Skip todo →</button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className={styles.btnSecondary} onClick={saveCurrent} disabled={saving || !currentValue.trim()}>
            {saving ? 'Guardando...' : 'Guardar'}
          </button>
          <button type="button" className={styles.btnPrimary} onClick={onNext}>Siguiente →</button>
        </div>
      </div>
    </div>
  );
}
