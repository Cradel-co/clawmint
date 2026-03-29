import { useState } from 'react';
import { Volume2, X } from 'lucide-react';
import { useVoiceProviders, useUpdateVoiceProvider, useSetDefaultVoice } from '../api/voiceProviders';
import styles from './VoicePanel.module.css';
import apStyles from './AgentsPanel.module.css';

export default function VoicePanel({ onClose }) {
  const { data, isLoading, error: loadError } = useVoiceProviders();
  const updateProvider = useUpdateVoiceProvider();
  const setDefault = useSetDefaultVoice();

  const providers = data?.providers || [];
  const defaultVoice = data?.default || '';
  const ttsEnabled = data?.enabled ?? false;

  const [fields, setFields] = useState({});
  const [saving, setSaving] = useState({});
  const [msg, setMsg] = useState('');

  if (providers.length > 0 && Object.keys(fields).length === 0) {
    const f = {};
    for (const p of providers) {
      f[p.name] = { apiKey: '', voice: p.currentVoice || p.defaultVoice || '', model: p.currentModel || p.defaultModel || '' };
    }
    setFields(f);
  }

  async function saveProvider(name) {
    setSaving(s => ({ ...s, [name]: true }));
    try {
      const { apiKey, voice, model } = fields[name] || {};
      await updateProvider.mutateAsync({ name, apiKey: apiKey || undefined, voice: voice || undefined, model: model || undefined });
      setMsg(`${name} guardado`);
    } catch (err) {
      setMsg('Error: ' + err.message);
    } finally {
      setSaving(s => ({ ...s, [name]: false }));
    }
  }

  async function saveDefault(name) {
    try {
      await setDefault.mutateAsync(name);
      setMsg(`Provider TTS por defecto: ${name}`);
    } catch (err) {
      setMsg('Error: ' + err.message);
    }
  }

  if (isLoading) return <div className={apStyles.panel}><p style={{ padding: 16 }}>Cargando...</p></div>;

  return (
    <div className={apStyles.panel} role="region" aria-label="Panel de TTS">
      <div className={apStyles.header}>
        <span className={apStyles.title}><Volume2 size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />Voces (TTS)</span>
        {onClose && <button className={apStyles.close} onClick={onClose} aria-label="Cerrar panel TTS"><X size={16} /></button>}
      </div>

      <div className={apStyles.body}>
        {(msg || loadError) && <div className={styles.msg}>{msg || 'Error cargando voice providers'}</div>}

        <div className={styles.toggleRow}>
          <span className={styles.toggleLabel}>TTS {ttsEnabled ? 'activado' : 'desactivado'}</span>
          <span className={styles.statusBadge + ' ' + (ttsEnabled ? styles.configured : styles.unconfigured)}>
            {ttsEnabled ? '● activo' : '○ inactivo'}
          </span>
        </div>

        <div className={apStyles.section}>
          <div className={styles.sectionTitle}>Provider por defecto</div>
          <select
            className={styles.defaultSelect}
            value={defaultVoice}
            onChange={e => saveDefault(e.target.value)}
            aria-label="Provider TTS por defecto"
          >
            {providers.map(p => (
              <option key={p.name} value={p.name}>{p.label || p.name}</option>
            ))}
          </select>
        </div>

        {providers.map(p => (
          <div key={p.name} className={apStyles.section}>
            <div className={styles.providerTitle}>
              {p.label || p.name}
              <span className={`${styles.statusBadge} ${p.type === 'local' ? styles.local : styles.cloud}`}>
                {p.type === 'local' ? '● local' : '● cloud'}
              </span>
              {p.configured && <span className={`${styles.statusBadge} ${styles.configured}`}>configurado</span>}
            </div>

            {p.type !== 'local' && (<>
              <label className={styles.fieldLabel}>API Key</label>
              <input
                className={styles.input}
                type="password"
                placeholder="API key..."
                value={fields[p.name]?.apiKey || ''}
                onChange={e => setFields(f => ({ ...f, [p.name]: { ...f[p.name], apiKey: e.target.value } }))}
                aria-label={`API Key para ${p.label || p.name}`}
              />
            </>)}

            <label className={styles.fieldLabel}>Voz</label>
            <input
              className={styles.input}
              type="text"
              placeholder={p.defaultVoice || 'voz...'}
              value={fields[p.name]?.voice || ''}
              onChange={e => setFields(f => ({ ...f, [p.name]: { ...f[p.name], voice: e.target.value } }))}
              aria-label={`Voz para ${p.label || p.name}`}
            />

            <label className={styles.fieldLabel}>Modelo</label>
            <input
              className={styles.input}
              type="text"
              placeholder={p.defaultModel || 'modelo...'}
              value={fields[p.name]?.model || ''}
              onChange={e => setFields(f => ({ ...f, [p.name]: { ...f[p.name], model: e.target.value } }))}
              aria-label={`Modelo para ${p.label || p.name}`}
            />

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
