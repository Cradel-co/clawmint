import { useState, useRef, useEffect } from 'react';
import { FileText, X, RefreshCw, Trash2 } from 'lucide-react';
import { useLogsConfig, useLogsTail, useUpdateLogsConfig, useClearLogs } from '../api/logs';
import styles from './LogsPanel.module.css';
import apStyles from './AgentsPanel.module.css';

export default function LogsPanel({ onClose }) {
  const { data: config } = useLogsConfig();
  const [lines, setLines] = useState(100);
  const { data: tailData, refetch } = useLogsTail(lines);
  const updateConfig = useUpdateLogsConfig();
  const clearLogs = useClearLogs();

  const [msg, setMsg] = useState('');
  const logRef = useRef(null);

  const enabled = config?.enabled ?? false;
  const logLines = tailData?.lines || [];

  // Auto-scroll al final cuando cambian los logs
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  async function toggleEnabled() {
    try {
      await updateConfig.mutateAsync(!enabled);
      setMsg(`Logging ${!enabled ? 'activado' : 'desactivado'}`);
    } catch (err) {
      setMsg('Error: ' + err.message);
    }
  }

  async function handleClear() {
    try {
      await clearLogs.mutateAsync();
      setMsg('Logs limpiados');
    } catch (err) {
      setMsg('Error: ' + err.message);
    }
  }

  return (
    <div className={apStyles.panel} role="region" aria-label="Panel de Logs" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className={apStyles.header}>
        <span className={apStyles.title}><FileText size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />Logs del servidor</span>
        {onClose && <button className={apStyles.close} onClick={onClose} aria-label="Cerrar panel logs"><X size={16} /></button>}
      </div>

      <div className={apStyles.body} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {msg && <div className={styles.msg}>{msg}</div>}

        <div className={styles.toggleRow}>
          <span className={styles.toggleLabel}>Logging {enabled ? 'activado' : 'desactivado'}</span>
          <button
            className={`${styles.toggle} ${enabled ? styles.toggleOn : ''}`}
            onClick={toggleEnabled}
            role="switch"
            aria-checked={enabled}
            aria-label="Toggle logging"
          />
        </div>

        <div className={styles.toolbar}>
          <label style={{ fontSize: 11, color: 'var(--text-hint)' }}>Líneas:</label>
          <select className={styles.linesSelect} value={lines} onChange={e => setLines(Number(e.target.value))}>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
            <option value={500}>500</option>
          </select>
          <button className={`${apStyles.btn} ${apStyles.btnGhost}`} onClick={() => refetch()} style={{ padding: '3px 8px', fontSize: 11 }}>
            <RefreshCw size={12} style={{ marginRight: 3 }} />Refrescar
          </button>
          <button className={`${apStyles.btn} ${styles.btnDanger}`} onClick={handleClear} disabled={clearLogs.isPending} style={{ padding: '3px 8px', fontSize: 11 }}>
            <Trash2 size={12} style={{ marginRight: 3 }} />Limpiar
          </button>
        </div>

        <div className={styles.logViewer} ref={logRef}>
          {logLines.length > 0
            ? logLines.join('\n')
            : <span className={styles.logEmpty}>Sin logs disponibles</span>
          }
        </div>
      </div>
    </div>
  );
}
