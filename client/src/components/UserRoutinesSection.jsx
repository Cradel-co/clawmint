import { useEffect, useState } from 'react';
import { Sunrise, Moon, CloudRain, Save, X, Loader2 } from 'lucide-react';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';
import styles from './ProfilePanel.module.css';
import apStyles from './AgentsPanel.module.css';

/**
 * Sección "Rutinas proactivas" — el agente envía briefings/alertas a la hora
 * configurada sin que el user lo pida.
 *
 * Lee/escribe vía /api/user-preferences (key: routine:morning:action_id, etc.)
 * — pero el flow real es vía MCP tools routine_morning_set / routine_bedtime_set
 * que crean los scheduled_actions. Acá usamos un endpoint REST helper que las
 * llama internamente (vía /api/routines).
 *
 * Por ahora — primera versión simple — usamos directamente /api/user-preferences
 * para guardar la pref + un endpoint POST /api/routines/sync que materializa
 * los scheduled_actions. Si no hay endpoint, el user puede pedirle al agente
 * "configura morning brief a las 7:30".
 */

const ROUTINES = [
  { id: 'morning',        Icon: Sunrise,   label: 'Morning brief', desc: 'Resumen al levantarte: clima, agenda, recordatorios.', defaultTime: '07:30', color: 'var(--accent-orange)' },
  { id: 'bedtime',        Icon: Moon,      label: 'Bedtime brief', desc: 'Cierre del día + qué viene mañana antes de dormir.',   defaultTime: '22:30', color: 'var(--accent-purple)' },
  { id: 'weather_alert',  Icon: CloudRain, label: 'Alerta clima',  desc: 'Te avisa si mañana hay alta probabilidad de lluvia.',  defaultTime: '20:00', color: 'var(--accent-cyan)' },
];

export default function UserRoutinesSection() {
  return (
    <div style={{ marginTop: 18 }}>
      <div className={styles.sectionTitle}>
        <Sunrise size={14} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--accent-orange)' }} />
        Rutinas proactivas
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 12px' }}>
        El agente te manda mensajes automáticos a la hora que elijas (Telegram o WebChat). Cero intervención.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {ROUTINES.map(r => <RoutineCard key={r.id} routine={r} />)}
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12, fontStyle: 'italic', lineHeight: 1.5 }}>
        También podés pedírselo al agente directo: <em>"configurame el morning brief a las 7"</em> o <em>"avisame si mañana llueve más de 70%"</em>.
      </p>
    </div>
  );
}

function RoutineCard({ routine }) {
  const PREF_KEY = `routine_pref:${routine.id}`;
  const [enabled, setEnabled] = useState(false);
  const [time, setTime]       = useState(routine.defaultTime);
  const [threshold, setThreshold] = useState(60);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg]   = useState(null);

  // Cargar pref existente
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`${API_BASE}/api/user-preferences/${PREF_KEY}`);
        if (res.ok) {
          const { value } = await res.json();
          let parsed; try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { parsed = null; }
          if (parsed && !cancelled) {
            setEnabled(true);
            setTime(parsed.time || routine.defaultTime);
            if (parsed.rain_threshold) setThreshold(parsed.rain_threshold);
          }
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const value = { time, ...(routine.id === 'weather_alert' ? { rain_threshold: Number(threshold) } : {}) };
      const res = await apiFetch(`${API_BASE}/api/user-preferences/${PREF_KEY}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: JSON.stringify(value) }),
      });
      if (!res.ok) throw new Error((await res.json())?.error || 'HTTP ' + res.status);
      setEnabled(true);
      setMsg({ type: 'ok', text: 'Guardado. Pedile al agente "activá mi rutina ' + routine.id + '" para ponerla en marcha.' });
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally { setBusy(false); }
  };

  const disable = async () => {
    if (!confirm(`¿Desactivar la rutina "${routine.label}"?`)) return;
    setBusy(true); setMsg(null);
    try {
      await apiFetch(`${API_BASE}/api/user-preferences/${PREF_KEY}`, { method: 'DELETE' });
      setEnabled(false);
      setMsg({ type: 'ok', text: 'Desactivada. Pedile al agente "desactivá ' + routine.id + '" para borrar el cron del scheduler.' });
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally { setBusy(false); }
  };

  return (
    <div style={{
      padding: 12,
      background: 'var(--bg-card)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
      borderLeft: `3px solid ${routine.color}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <routine.Icon size={18} style={{ color: routine.color }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{routine.label}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{routine.desc}</div>
        </div>
        {enabled && (
          <span style={{
            padding: '2px 8px', borderRadius: 999,
            background: 'rgba(16, 185, 129, 0.14)', color: 'var(--status-ok)',
            fontSize: 10, fontWeight: 700, letterSpacing: 0.04, textTransform: 'uppercase',
          }}>Activa</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Hora:
          <input
            type="time"
            value={time}
            onChange={e => setTime(e.target.value)}
            style={{
              marginLeft: 6, padding: '4px 8px',
              background: 'var(--bg-input)', border: '1px solid var(--border-primary)',
              borderRadius: 6, color: 'var(--text-primary)', fontFamily: 'var(--font-ui)', fontSize: 13,
            }}
          />
        </label>
        {routine.id === 'weather_alert' && (
          <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Umbral lluvia %:
            <input
              type="number" min="10" max="100" step="5"
              value={threshold}
              onChange={e => setThreshold(e.target.value)}
              style={{
                marginLeft: 6, padding: '4px 8px', width: 70,
                background: 'var(--bg-input)', border: '1px solid var(--border-primary)',
                borderRadius: 6, color: 'var(--text-primary)', fontFamily: 'var(--font-ui)', fontSize: 13,
              }}
            />
          </label>
        )}
        <button
          onClick={save}
          disabled={busy}
          className={`${apStyles.btn} ${apStyles.btnPrimary}`}
          style={{ marginLeft: 'auto' }}
        >
          {busy ? <Loader2 size={12} className="spin" /> : <Save size={12} />}
          {enabled ? 'Actualizar' : 'Activar'}
        </button>
        {enabled && (
          <button onClick={disable} disabled={busy} className={apStyles.btn} style={{ color: 'var(--accent-red)' }}>
            <X size={12} /> Desactivar
          </button>
        )}
      </div>

      {msg && (
        <div style={{
          marginTop: 8, padding: '6px 10px', borderRadius: 6,
          background: msg.type === 'error' ? 'rgba(239,68,68,0.10)' : 'rgba(16,185,129,0.10)',
          color: msg.type === 'error' ? 'var(--accent-red)' : 'var(--status-ok)',
          fontSize: 11.5, lineHeight: 1.4,
        }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
