import { useState, useEffect } from 'react';
import { Network, X, RefreshCw } from 'lucide-react';
import { useNodrizaConfig, useNodrizaStatus, useUpdateNodriza, useReconnectNodriza } from '../api/nodriza';
import styles from './NodrizaPanel.module.css';
import apStyles from './AgentsPanel.module.css';

export default function NodrizaPanel({ onClose }) {
  const { data: config, isLoading } = useNodrizaConfig();
  const { data: status } = useNodrizaStatus();
  const updateNodriza = useUpdateNodriza();
  const reconnect = useReconnectNodriza();

  const [form, setForm] = useState({ url: '', serverId: '', apiKey: '', enabled: false });
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (config && !initialized) {
      setForm({ url: config.url || '', serverId: config.serverId || '', apiKey: '', enabled: config.enabled ?? false });
      setInitialized(true);
    }
  }, [config, initialized]);

  async function save() {
    setSaving(true);
    try {
      const payload = { url: form.url, serverId: form.serverId, enabled: form.enabled };
      if (form.apiKey) payload.apiKey = form.apiKey;
      await updateNodriza.mutateAsync(payload);
      setMsg('Configuración guardada');
      setForm(f => ({ ...f, apiKey: '' }));
    } catch (err) {
      setMsg('Error: ' + err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleReconnect() {
    try {
      await reconnect.mutateAsync();
      setMsg('Reconectando...');
    } catch (err) {
      setMsg('Error: ' + err.message);
    }
  }

  function toggleEnabled() {
    setForm(f => ({ ...f, enabled: !f.enabled }));
  }

  if (isLoading) return <div className={apStyles.panel}><p style={{ padding: 16 }}>Cargando...</p></div>;

  const peers = status?.peers || [];

  return (
    <div className={apStyles.panel} role="region" aria-label="Panel P2P Nodriza">
      <div className={apStyles.header}>
        <span className={apStyles.title}><Network size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />Nodriza (P2P)</span>
        {onClose && <button className={apStyles.close} onClick={onClose} aria-label="Cerrar panel P2P"><X size={16} /></button>}
      </div>

      <div className={apStyles.body}>
        {msg && <div className={styles.msg}>{msg}</div>}

        {/* Status */}
        <div className={styles.sectionTitle}>Estado</div>
        <div className={styles.statusCard}>
          <div className={styles.statusRow}>
            <span className={`${styles.statusDot} ${status?.connected ? styles.connected : styles.disconnected}`} />
            <span>{status?.connected ? 'Conectado' : 'Desconectado'}</span>
          </div>
          {peers.length > 0 ? (
            <div className={styles.peerList}>
              {peers.map((p, i) => <span key={i} className={styles.peer}>{p}</span>)}
            </div>
          ) : (
            <span className={styles.noPeers}>Sin peers conectados</span>
          )}
        </div>

        {/* Config */}
        <div className={styles.sectionTitle} style={{ marginTop: 12 }}>Configuración</div>

        <div className={styles.toggleRow}>
          <span className={styles.toggleLabel}>P2P {form.enabled ? 'activado' : 'desactivado'}</span>
          <button
            className={`${styles.toggle} ${form.enabled ? styles.toggleOn : ''}`}
            onClick={toggleEnabled}
            role="switch"
            aria-checked={form.enabled}
            aria-label="Toggle P2P"
          />
        </div>

        <label className={styles.fieldLabel}>URL del servidor de señalización</label>
        <input
          className={styles.input}
          type="text"
          placeholder="ws://localhost:3000/signaling"
          value={form.url}
          onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
        />

        <label className={styles.fieldLabel}>Server ID</label>
        <input
          className={styles.input}
          type="text"
          placeholder="ID del server en nodriza"
          value={form.serverId}
          onChange={e => setForm(f => ({ ...f, serverId: e.target.value }))}
        />

        <label className={styles.fieldLabel}>API Key {config?.apiKey ? `(actual: ${config.apiKey})` : ''}</label>
        <input
          className={styles.input}
          type="password"
          placeholder="Dejar vacío para no cambiar"
          value={form.apiKey}
          onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
        />

        <div className={styles.btnRow}>
          <button className={`${apStyles.btn} ${apStyles.btnPrimary}`} onClick={save} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
          <button className={`${apStyles.btn} ${apStyles.btnGhost}`} onClick={handleReconnect} disabled={reconnect.isPending}>
            <RefreshCw size={12} style={{ marginRight: 4 }} />
            Reconectar
          </button>
        </div>
      </div>
    </div>
  );
}
