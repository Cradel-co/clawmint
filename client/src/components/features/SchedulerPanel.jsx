import { useEffect, useState } from 'react';
import { scheduler as api } from '../../api/features';
import styles from '../admin/AdminPanel.module.css';

/**
 * SchedulerPanel (Fase C.2) — 3 tabs:
 *   1. Reminders (usa /api/reminders existente)
 *   2. Scheduled actions (cron/once en scheduled_actions) — placeholder hasta endpoint
 *   3. Resumable sessions (schedule_wakeup) — placeholder hasta endpoint
 *
 * El server ya tiene los backends (scheduler.js + ResumableSessionsRepository),
 * pero no expone REST dedicado. Mostramos lo disponible y dejamos stubs claros
 * para cuando existan /api/scheduled-actions y /api/resumable-sessions.
 */
export default function SchedulerPanel({ accessToken }) {
  const [tab, setTab] = useState('reminders');
  const [reminders, setReminders] = useState(null);
  const [error, setError] = useState(null);

  const loadReminders = async () => {
    setError(null);
    try {
      const data = await api.reminders(accessToken);
      // Server devuelve { reminders: [...] } o directamente el array en algunas rutas.
      const list = Array.isArray(data) ? data : (data?.reminders || data?.items || []);
      setReminders(list);
    } catch (e) { setError(e.message); }
  };

  useEffect(() => { if (tab === 'reminders') loadReminders(); }, [tab, accessToken]);

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Scheduler</h1>
          <p className={styles.subtitle}>Reminders, cron jobs y sesiones reanudables (schedule_wakeup).</p>
        </div>
        <div className={styles.actions}>
          <button className={`${styles.btn} ${tab === 'reminders' ? styles.btnPrimary : ''}`} onClick={() => setTab('reminders')}>Reminders</button>
          <button className={`${styles.btn} ${tab === 'actions' ? styles.btnPrimary : ''}`} onClick={() => setTab('actions')}>Scheduled actions</button>
          <button className={`${styles.btn} ${tab === 'resumable' ? styles.btnPrimary : ''}`} onClick={() => setTab('resumable')}>Resumable</button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      {tab === 'reminders' && (
        <section className={styles.card}>
          {reminders === null ? <div className={styles.empty}>Cargando…</div> : reminders.length === 0 ? (
            <div className={styles.empty}>Sin reminders programados.</div>
          ) : (
            <table className={styles.table}>
              <thead><tr><th>ID</th><th>Texto</th><th>Chat</th><th>Dispara</th></tr></thead>
              <tbody>
                {reminders.map(r => (
                  <tr key={r.id}>
                    <td className={styles.mono}>{r.id}</td>
                    <td>{r.text}</td>
                    <td className={styles.mono}>{r.chatId ?? r.chat_id ?? '—'}</td>
                    <td className={styles.mono}>{formatDate(r.triggerAt ?? r.trigger_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'actions' && (
        <section className={styles.card}>
          <div className={styles.empty}>
            Scheduled actions (cron + webhooks) se crean vía tools <code>cron_create</code> y <code>schedule_action</code> desde el agente.
            El endpoint REST <code>/api/scheduled-actions</code> está parked.
          </div>
        </section>
      )}

      {tab === 'resumable' && (
        <section className={styles.card}>
          <div className={styles.empty}>
            Resumable sessions (<code>schedule_wakeup</code>) están en la tabla <code>resumable_sessions</code>.
            Endpoint REST <code>/api/resumable-sessions</code> parked.
          </div>
        </section>
      )}
    </div>
  );
}

function formatDate(ms) {
  if (!ms) return '—';
  try {
    const d = new Date(ms);
    const age = ms - Date.now();
    if (age > 0 && age < 86_400_000) return `en ${Math.round(age / 60_000)}m`;
    return d.toISOString().slice(0, 16).replace('T', ' ');
  } catch { return '—'; }
}
