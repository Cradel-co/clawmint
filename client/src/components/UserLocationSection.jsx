import { useEffect, useState } from 'react';
import { MapPin, Search, Save, Trash2, Loader2, CheckCircle2 } from 'lucide-react';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';
import styles from './ProfilePanel.module.css';
import apStyles from './AgentsPanel.module.css';

const PREF_KEY = 'location';

/**
 * Sección "Mi ubicación" — guarda/edita la coord del usuario en
 * `userPreferencesRepo` (mismo storage que usan las MCP tools user_location_*).
 *
 * Geocoding: Nominatim (OSM) free + sin key. Buscás "Bahía Blanca" y rellena
 * lat/lon automáticamente. Después podés ajustar los valores manualmente.
 */
export default function UserLocationSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [searching, setSearching] = useState(false);
  const [name, setName]       = useState('');
  const [lat, setLat]         = useState('');
  const [lon, setLon]         = useState('');
  const [notes, setNotes]     = useState('');
  const [savedAt, setSavedAt] = useState(null);
  const [source, setSource]   = useState(null);
  const [results, setResults] = useState([]);
  const [msg, setMsg]         = useState(null);

  // Cargar preferencia existente
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`${API_BASE}/api/user-preferences/${PREF_KEY}`);
        if (res.ok) {
          const { value } = await res.json();
          let parsed;
          try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { parsed = { name: value }; }
          if (!cancelled && parsed) {
            setName(parsed.name || '');
            setLat(parsed.latitude != null ? String(parsed.latitude) : '');
            setLon(parsed.longitude != null ? String(parsed.longitude) : '');
            setNotes(parsed.notes || '');
            setSavedAt(parsed.savedAt || null);
            setSource(parsed.source || null);
          }
        }
      } catch { /* sin preferencia → form vacío */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  const search = async () => {
    if (!name.trim()) { setMsg({ type: 'error', text: 'Ingresá un nombre primero' }); return; }
    setSearching(true); setMsg(null); setResults([]);
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&limit=5&addressdetails=1`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'es' } });
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) {
        setMsg({ type: 'warn', text: 'Sin resultados. Probá con un nombre más específico.' });
      } else {
        setResults(data);
      }
    } catch (e) {
      setMsg({ type: 'error', text: 'Error en geocoding: ' + e.message });
    } finally { setSearching(false); }
  };

  const pickResult = (r) => {
    setName(r.display_name);
    setLat(r.lat);
    setLon(r.lon);
    setResults([]);
    setMsg({ type: 'info', text: 'Coordenadas cargadas — clic Guardar para persistir.' });
  };

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const value = {
        name: name.trim() || null,
        latitude:  lat !== '' ? Number(lat) : null,
        longitude: lon !== '' ? Number(lon) : null,
        notes: notes.trim() || null,
        savedAt: Date.now(),
        source: 'user-ui',
      };
      if (value.latitude == null || value.longitude == null) {
        setMsg({ type: 'error', text: 'Faltan latitude/longitude. Buscá una ciudad o pegalas a mano.' });
        setSaving(false);
        return;
      }
      const res = await apiFetch(`${API_BASE}/api/user-preferences/${PREF_KEY}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: JSON.stringify(value) }),
      });
      if (!res.ok) throw new Error((await res.json())?.error || 'HTTP ' + res.status);
      setSavedAt(value.savedAt);
      setSource(value.source);
      setMsg({ type: 'ok', text: 'Ubicación guardada. El widget de clima va a usarla.' });
    } catch (e) {
      setMsg({ type: 'error', text: 'No pude guardar: ' + e.message });
    } finally { setSaving(false); }
  };

  const clear = async () => {
    if (!confirm('¿Borrar la ubicación guardada?')) return;
    setSaving(true); setMsg(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/user-preferences/${PREF_KEY}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error('HTTP ' + res.status);
      setName(''); setLat(''); setLon(''); setNotes(''); setSavedAt(null); setSource(null);
      setMsg({ type: 'ok', text: 'Ubicación borrada.' });
    } catch (e) {
      setMsg({ type: 'error', text: 'Error: ' + e.message });
    } finally { setSaving(false); }
  };

  if (loading) return null;

  return (
    <div style={{ marginTop: 18 }}>
      <div className={styles.sectionTitle}>
        <MapPin size={14} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--accent-orange)' }} />
        Mi ubicación
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 12px' }}>
        Se usa para el widget de clima del Dashboard y para que los agentes puedan responder preguntas sobre tu ubicación.
      </p>

      {savedAt && (
        <div style={{
          fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10,
          padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 6,
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}>
          <CheckCircle2 size={12} style={{ color: 'var(--status-ok)' }} />
          Guardada {new Date(savedAt).toLocaleString('es-ES')}
          {source && <span style={{ marginLeft: 6, opacity: 0.7 }}>(source: {source})</span>}
        </div>
      )}

      {msg && (
        <div className={`${styles.msg} ${msg.type === 'error' ? styles.msgError : ''}`} style={{
          ...(msg.type === 'warn' ? { color: 'var(--accent-yellow)' } : {}),
          ...(msg.type === 'info' ? { color: 'var(--accent-orange)' } : {}),
        }}>
          {msg.text}
        </div>
      )}

      <label className={styles.fieldLabel}>Ciudad / dirección</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className={styles.input}
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Ej: Bahía Blanca, Argentina"
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); search(); } }}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className={`${apStyles.btn}`}
          onClick={search}
          disabled={searching || !name.trim()}
          title="Buscar coordenadas via OpenStreetMap"
        >
          {searching ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
          Buscar
        </button>
      </div>

      {results.length > 0 && (
        <div style={{
          marginTop: 8, padding: 6,
          background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
          borderRadius: 6, maxHeight: 220, overflowY: 'auto',
        }}>
          {results.map(r => (
            <div
              key={r.place_id}
              onClick={() => pickResult(r)}
              style={{
                padding: '6px 8px', fontSize: 12, cursor: 'pointer',
                color: 'var(--text-secondary)', borderRadius: 4,
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              {r.display_name}
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
                {Number(r.lat).toFixed(4)}, {Number(r.lon).toFixed(4)}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
        <div>
          <label className={styles.fieldLabel}>Latitude</label>
          <input className={styles.input} type="number" step="any" value={lat} onChange={e => setLat(e.target.value)} placeholder="-38.7183" />
        </div>
        <div>
          <label className={styles.fieldLabel}>Longitude</label>
          <input className={styles.input} type="number" step="any" value={lon} onChange={e => setLon(e.target.value)} placeholder="-62.2663" />
        </div>
      </div>

      <label className={styles.fieldLabel}>Notas (opcional)</label>
      <input
        className={styles.input}
        type="text"
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder='Ej: "casa", "oficina"'
      />

      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button
          type="button"
          className={`${apStyles.btn} ${apStyles.btnPrimary}`}
          onClick={save}
          disabled={saving || !lat || !lon}
        >
          {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
          Guardar
        </button>
        {savedAt && (
          <button type="button" className={apStyles.btn} onClick={clear} disabled={saving} style={{ color: 'var(--accent-red)' }}>
            <Trash2 size={14} /> Borrar
          </button>
        )}
      </div>
    </div>
  );
}
