import { useState } from 'react';
import { Settings, X } from 'lucide-react';
import { useProviders, useUpdateProvider, useSetDefaultProvider } from '../api/providers';
import styles from './ProvidersPanel.module.css';
import apStyles from './AgentsPanel.module.css';

const PROVIDER_NAMES = {
  'claude-code': 'Claude Code',
  anthropic: 'Anthropic API',
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  grok: 'Grok (xAI)',
  deepseek: 'DeepSeek',
  ollama: 'Ollama (local)',
};

export default function ProvidersPanel({ onClose }) {
  const { data, isLoading, error: loadError } = useProviders();
  const updateProvider = useUpdateProvider();
  const setDefault = useSetDefaultProvider();

  const providers = data?.providers || [];
  const defaultProvider = data?.default || 'claude-code';

  const [keys, setKeys] = useState({});
  const [saving, setSaving] = useState({});
  const [msg, setMsg] = useState('');

  // Init keys cuando llegan providers (solo si vacío)
  if (providers.length > 0 && Object.keys(keys).length === 0) {
    const k = {};
    for (const p of providers) {
      k[p.name] = { apiKey: '', model: p.currentModel || p.defaultModel || '' };
    }
    setKeys(k);
  }

  async function saveProvider(name) {
    setSaving(s => ({ ...s, [name]: true }));
    try {
      const { apiKey, model } = keys[name] || {};
      await updateProvider.mutateAsync({ name, apiKey: apiKey || undefined, model: model || undefined });
      setMsg(`${PROVIDER_NAMES[name] || name} guardado`);
    } catch (err) {
      setMsg('Error: ' + err.message);
    } finally {
      setSaving(s => ({ ...s, [name]: false }));
    }
  }

  async function saveDefault(name) {
    try {
      await setDefault.mutateAsync(name);
      setMsg(`Provider por defecto: ${PROVIDER_NAMES[name] || name}`);
    } catch (err) {
      setMsg('Error: ' + err.message);
    }
  }

  const configurable = providers.filter(p => p.name !== 'claude-code');

  if (isLoading) return <div className={apStyles.panel}><p style={{ padding: 16 }}>Cargando...</p></div>;

  return (
    <div className={apStyles.panel} role="region" aria-label="Panel de proveedores">
      <div className={apStyles.header}>
        <span className={apStyles.title}><Settings size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />Providers de IA</span>
        {onClose && <button className={apStyles.close} onClick={onClose} aria-label="Cerrar panel de proveedores"><X size={16} /></button>}
      </div>

      <div className={apStyles.body}>
        {(msg || loadError) && <div className={styles.msg}>{msg || 'Error cargando providers'}</div>}

        {/* Provider por defecto */}
        <div className={apStyles.section}>
          <div className={styles.sectionTitle}>Provider por defecto (Telegram)</div>
          <select
            className={styles.defaultSelect}
            value={defaultProvider}
            onChange={e => saveDefault(e.target.value)}
            aria-label="Provider por defecto"
          >
            {providers.map(p => (
              <option key={p.name} value={p.name}>{p.label}</option>
            ))}
          </select>
        </div>

        {/* API Keys por provider */}
        {configurable.map(p => (
          <div key={p.name} className={apStyles.section}>
            <div className={styles.providerTitle}>
              {p.label}
              <span className={`${styles.statusBadge} ${(p.configured || p.name === 'ollama') ? styles.configured : styles.unconfigured}`}>
                {p.name === 'ollama' ? '● local' : p.configured ? '● configurado' : '○ sin key'}
              </span>
            </div>

            {p.name !== 'ollama' && (<>
            <label className={styles.fieldLabel}>API Key</label>
            <input
              className={styles.input}
              type="password"
              placeholder="sk-... / AIza... / sk-ant-..."
              value={keys[p.name]?.apiKey || ''}
              onChange={e => setKeys(k => ({ ...k, [p.name]: { ...k[p.name], apiKey: e.target.value } }))}
              aria-label={`API Key para ${p.label}`}
            />
            </>)}

            <label className={styles.fieldLabel}>Modelo</label>
            <select
              className={styles.select}
              value={keys[p.name]?.model || p.defaultModel || ''}
              onChange={e => setKeys(k => ({ ...k, [p.name]: { ...k[p.name], model: e.target.value } }))}
              aria-label={`Modelo para ${p.label}`}
            >
              {(p.models || []).map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>

            <button
              className={`${apStyles.btn} ${apStyles.btnPrimary}`}
              onClick={() => saveProvider(p.name)}
              disabled={saving[p.name]}
            >
              {saving[p.name] ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
