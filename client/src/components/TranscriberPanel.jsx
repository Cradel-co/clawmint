import { useState, useEffect } from 'react';
import { Mic, X } from 'lucide-react';
import { useTranscriberConfig, useUpdateTranscriber } from '../api/transcriber';
import styles from './TranscriberPanel.module.css';
import apStyles from './AgentsPanel.module.css';

const MODELS = ['Xenova/whisper-tiny', 'Xenova/whisper-base', 'Xenova/whisper-small', 'Xenova/whisper-medium'];
const LANGUAGES = ['es', 'en', 'pt', 'fr', 'de', 'it', 'ja', 'zh', 'ko', 'auto'];

export default function TranscriberPanel({ onClose }) {
  const { data: config, isLoading } = useTranscriberConfig();
  const update = useUpdateTranscriber();
  const [model, setModel] = useState('');
  const [language, setLanguage] = useState('');
  const [msg, setMsg] = useState('');
  const [init, setInit] = useState(false);

  useEffect(() => {
    if (config && !init) {
      setModel(config.model || '');
      setLanguage(config.language || '');
      setInit(true);
    }
  }, [config, init]);

  async function save() {
    try {
      await update.mutateAsync({ model, language });
      setMsg('Configuración guardada');
    } catch (err) {
      setMsg('Error: ' + err.message);
    }
  }

  if (isLoading) return <div className={apStyles.panel}><p style={{ padding: 16 }}>Cargando...</p></div>;

  return (
    <div className={apStyles.panel} role="region" aria-label="Panel STT">
      <div className={apStyles.header}>
        <span className={apStyles.title}><Mic size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />Transcripción (STT)</span>
        {onClose && <button className={apStyles.close} onClick={onClose} aria-label="Cerrar"><X size={16} /></button>}
      </div>
      <div className={apStyles.body}>
        {msg && <div className={styles.msg}>{msg}</div>}

        <div className={styles.sectionTitle}>Modelo Whisper</div>
        <select className={styles.select} value={model} onChange={e => setModel(e.target.value)}>
          {MODELS.map(m => <option key={m} value={m}>{m.replace('Xenova/', '')}</option>)}
        </select>

        <label className={styles.fieldLabel}>Idioma</label>
        <select className={styles.select} value={language} onChange={e => setLanguage(e.target.value)}>
          {LANGUAGES.map(l => <option key={l} value={l}>{l === 'auto' ? 'Automático' : l.toUpperCase()}</option>)}
        </select>

        {config && (
          <>
            <div className={styles.sectionTitle} style={{ marginTop: 12 }}>Info</div>
            <div className={styles.infoRow}><span className={styles.infoLabel}>Chunk</span><span>{config.chunkLengthS}s</span></div>
            <div className={styles.infoRow}><span className={styles.infoLabel}>Idle timeout</span><span>{Math.round((config.idleTimeoutMs || 0) / 60000)}min</span></div>
            <div className={styles.infoRow}><span className={styles.infoLabel}>Timeout</span><span>{Math.round((config.timeout || 0) / 1000)}s</span></div>
          </>
        )}

        <button className={`${apStyles.btn} ${apStyles.btnPrimary}`} onClick={save} disabled={update.isPending} style={{ marginTop: 12 }}>
          {update.isPending ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </div>
  );
}
