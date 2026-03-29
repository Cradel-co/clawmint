import { useState } from 'react';
import { Bell, X, Trash2 } from 'lucide-react';
import { useReminders, useCreateReminder, useDeleteReminder } from '../api/reminders';
import styles from './RemindersPanel.module.css';
import apStyles from './AgentsPanel.module.css';

function formatRemaining(triggerAt) {
  const diff = triggerAt - Date.now();
  if (diff <= 0) return 'vencido';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}min`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export default function RemindersPanel({ onClose }) {
  const { data, isLoading } = useReminders();
  const create = useCreateReminder();
  const del = useDeleteReminder();

  const [text, setText] = useState('');
  const [duration, setDuration] = useState('');
  const [msg, setMsg] = useState('');

  const reminders = data?.reminders || [];

  async function handleCreate(e) {
    e.preventDefault();
    if (!text || !duration) return;
    try {
      await create.mutateAsync({ text, duration });
      setText('');
      setDuration('');
      setMsg('Recordatorio creado');
    } catch (err) {
      setMsg('Error: ' + err.message);
    }
  }

  async function handleDelete(id) {
    try {
      await del.mutateAsync(id);
    } catch (err) {
      setMsg('Error: ' + err.message);
    }
  }

  if (isLoading) return <div className={apStyles.panel}><p style={{ padding: 16 }}>Cargando...</p></div>;

  return (
    <div className={apStyles.panel} role="region" aria-label="Panel de recordatorios">
      <div className={apStyles.header}>
        <span className={apStyles.title}><Bell size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />Recordatorios</span>
        {onClose && <button className={apStyles.close} onClick={onClose} aria-label="Cerrar"><X size={16} /></button>}
      </div>
      <div className={apStyles.body}>
        {msg && <div className={styles.msg}>{msg}</div>}

        <div className={styles.sectionTitle}>Nuevo recordatorio</div>
        <form onSubmit={handleCreate}>
          <input className={styles.input} placeholder="Texto del recordatorio" value={text} onChange={e => setText(e.target.value)} />
          <div className={styles.row}>
            <input className={styles.input} placeholder="Duración (5m, 2h, 1d)" value={duration} onChange={e => setDuration(e.target.value)} />
            <button className={`${apStyles.btn} ${apStyles.btnPrimary}`} type="submit" disabled={create.isPending || !text || !duration}>
              {create.isPending ? '...' : 'Crear'}
            </button>
          </div>
        </form>

        <div className={styles.sectionTitle} style={{ marginTop: 14 }}>Activos ({reminders.length})</div>
        {reminders.length === 0 ? (
          <div className={styles.empty}>Sin recordatorios activos</div>
        ) : (
          reminders.map(r => (
            <div key={r.id} className={styles.reminderCard}>
              <div className={styles.reminderInfo}>
                <div className={styles.reminderText}>{r.text}</div>
                <div className={styles.reminderMeta}>en {formatRemaining(r.triggerAt)} — {r.botKey || 'web'}</div>
              </div>
              <button className={styles.deleteBtn} onClick={() => handleDelete(r.id)} aria-label="Eliminar"><Trash2 size={14} /></button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
