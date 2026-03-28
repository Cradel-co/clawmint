import { useState, useEffect, useCallback, memo } from 'react';
import { Gauge, Plus, X, Pencil, Trash2, Save, RotateCcw } from 'lucide-react';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';
import './LimitsPanel.css';

const API = `${API_BASE}/api/limits`;

const TYPES  = ['rate', 'session'];
const SCOPES = ['global', 'channel', 'bot', 'user', 'agent', 'provider'];

const TYPE_LABELS  = { rate: 'Rate limit', session: 'Sesión CLI' };
const SCOPE_LABELS = { global: 'Global', channel: 'Canal', bot: 'Bot', user: 'Usuario', agent: 'Agente', provider: 'Provider' };

function windowLabel(ms) {
  if (!ms) return '';
  if (ms < 60000) return `${ms / 1000}s`;
  if (ms < 3600000) return `${ms / 60000}min`;
  return `${ms / 3600000}h`;
}

// ── Form ──────────────────────────────────────────────────────────────────────

const LimitForm = memo(function LimitForm({ initial, onSave, onCancel }) {
  const isEdit = !!initial;
  const [type, setType]       = useState(initial?.type || 'rate');
  const [scope, setScope]     = useState(initial?.scope || 'global');
  const [scopeId, setScopeId] = useState(initial?.scope_id || '');
  const [maxCount, setMaxCount] = useState(initial?.max_count ?? 10);
  const [windowMs, setWindowMs] = useState(initial?.window_ms ?? 60000);
  const [windowUnit, setWindowUnit] = useState('min');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    if (initial?.window_ms) {
      if (initial.window_ms >= 3600000) setWindowUnit('h');
      else if (initial.window_ms >= 60000) setWindowUnit('min');
      else setWindowUnit('s');
    }
  }, [initial]);

  const windowValue = windowUnit === 'h' ? windowMs / 3600000
    : windowUnit === 'min' ? windowMs / 60000
    : windowMs / 1000;

  const handleWindowChange = (val) => {
    const n = Number(val) || 1;
    if (windowUnit === 'h') setWindowMs(n * 3600000);
    else if (windowUnit === 'min') setWindowMs(n * 60000);
    else setWindowMs(n * 1000);
  };

  const handleUnitChange = (unit) => {
    setWindowUnit(unit);
    const current = windowUnit === 'h' ? windowMs / 3600000
      : windowUnit === 'min' ? windowMs / 60000
      : windowMs / 1000;
    if (unit === 'h') setWindowMs(current * 3600000);
    else if (unit === 'min') setWindowMs(current * 60000);
    else setWindowMs(current * 1000);
  };

  const handleSubmit = async () => {
    setError('');
    setSaving(true);
    try {
      const body = {
        type, scope,
        scope_id: scope === 'global' ? null : scopeId || null,
        max_count: Number(maxCount),
        window_ms: type === 'rate' ? windowMs : null,
      };

      if (isEdit) {
        const res = await apiFetch(`${API}/${initial.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ max_count: body.max_count, window_ms: body.window_ms, scope_id: body.scope_id }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Error');
      } else {
        const res = await apiFetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Error');
      }
      onSave();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="lp-form">
      <p className="lp-form-title">{isEdit ? 'Editar límite' : 'Nuevo límite'}</p>

      {!isEdit && (
        <>
          <label className="ap-label">Tipo</label>
          <div className="lp-toggle-row">
            {TYPES.map(t => (
              <button key={t} className={`lp-toggle ${type === t ? 'active' : ''}`} onClick={() => setType(t)}>
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>

          <label className="ap-label">Scope</label>
          <select className="ap-input" value={scope} onChange={e => setScope(e.target.value)}>
            {SCOPES.map(s => <option key={s} value={s}>{SCOPE_LABELS[s]}</option>)}
          </select>
        </>
      )}

      {scope !== 'global' && (
        <>
          <label className="ap-label">ID del scope</label>
          <input
            className="ap-input"
            placeholder={scope === 'channel' ? 'telegram, webchat...' : scope === 'provider' ? 'claude-code, anthropic...' : 'identificador'}
            value={scopeId}
            onChange={e => setScopeId(e.target.value)}
            disabled={isEdit}
          />
        </>
      )}

      <label className="ap-label">Máximo de mensajes</label>
      <input
        className="ap-input"
        type="number"
        min="1"
        value={maxCount}
        onChange={e => setMaxCount(e.target.value)}
      />

      {type === 'rate' && (
        <>
          <label className="ap-label">Ventana de tiempo</label>
          <div className="lp-window-row">
            <input
              className="ap-input lp-window-input"
              type="number"
              min="1"
              value={windowValue}
              onChange={e => handleWindowChange(e.target.value)}
            />
            <select className="ap-input lp-window-unit" value={windowUnit} onChange={e => handleUnitChange(e.target.value)}>
              <option value="s">segundos</option>
              <option value="min">minutos</option>
              <option value="h">horas</option>
            </select>
          </div>
        </>
      )}

      {error && <p className="ap-error">{error}</p>}

      <div className="lp-form-actions">
        <button className="ap-btn ap-btn-primary" onClick={handleSubmit} disabled={saving}>
          <Save size={13} /> {saving ? 'Guardando...' : 'Guardar'}
        </button>
        <button className="ap-btn ap-btn-ghost" onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
});

// ── Row ───────────────────────────────────────────────────────────────────────

const LimitRow = memo(function LimitRow({ rule, onEdit, onDelete }) {
  const scopeLabel = rule.scope === 'global'
    ? 'Global'
    : `${SCOPE_LABELS[rule.scope]}: ${rule.scope_id}`;

  return (
    <div className="lp-row">
      <div className="lp-row-top">
        <span className={`lp-type-badge ${rule.type}`}>{TYPE_LABELS[rule.type]}</span>
        <span className="lp-scope">{scopeLabel}</span>
        <div className="lp-row-actions">
          <button className="ap-btn ap-btn-icon" onClick={() => onEdit(rule)} title="Editar"><Pencil size={13} /></button>
          <button className="ap-btn ap-btn-icon lp-btn-danger" onClick={() => onDelete(rule.id)} title="Eliminar"><Trash2 size={13} /></button>
        </div>
      </div>
      <div className="lp-row-detail">
        <span className="lp-value">{rule.max_count} msgs</span>
        {rule.type === 'rate' && rule.window_ms && (
          <span className="lp-window">/ {windowLabel(rule.window_ms)}</span>
        )}
        {!rule.enabled && <span className="lp-disabled-badge">deshabilitado</span>}
      </div>
    </div>
  );
});

// ── Panel principal ──────────────────────────────────────────────────────────

export default function LimitsPanel({ onClose, embedded }) {
  const [rules, setRules]       = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editRule, setEditRule] = useState(null);
  const [error, setError]       = useState('');

  const fetchRules = useCallback(async () => {
    try {
      const res = await apiFetch(API);
      const data = await res.json();
      setRules(Array.isArray(data) ? data : []);
      setError('');
    } catch (err) {
      setError('Error cargando límites: ' + err.message);
    }
  }, []);

  useEffect(() => { fetchRules(); }, [fetchRules]);

  const handleSave = () => {
    setShowForm(false);
    setEditRule(null);
    fetchRules();
  };

  const handleEdit = (rule) => {
    setEditRule(rule);
    setShowForm(true);
  };

  const handleDelete = async (id) => {
    if (!confirm('¿Eliminar esta regla de límite?')) return;
    try {
      await apiFetch(`${API}/${id}`, { method: 'DELETE' });
      fetchRules();
    } catch (err) {
      setError('Error eliminando: ' + err.message);
    }
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditRule(null);
  };

  const rateRules    = rules.filter(r => r.type === 'rate');
  const sessionRules = rules.filter(r => r.type === 'session');

  return (
    <div className="ap-panel" role="region" aria-label="Panel de límites">
      {!embedded && (
        <div className="ap-header">
          <span className="ap-header-title"><Gauge size={16} /> Límites</span>
          <button className="ap-close" onClick={onClose}><X size={16} /></button>
        </div>
      )}
      <div className="ap-body">
        {error && <div className="pp-msg lp-error-msg">{error}</div>}

        <p className="lp-section-hint">
          Configura límites de mensajes por tiempo (rate) y duración de sesión CLI.
          Prioridad: provider {'>'} agent {'>'} user {'>'} bot {'>'} channel {'>'} global.
        </p>

        {/* Rate limiting */}
        {rateRules.length > 0 && (
          <>
            <p className="lp-section-title">Rate Limiting</p>
            {rateRules.map(r => (
              <LimitRow key={r.id} rule={r} onEdit={handleEdit} onDelete={handleDelete} />
            ))}
          </>
        )}

        {/* Session limits */}
        {sessionRules.length > 0 && (
          <>
            <p className="lp-section-title">Sesión CLI</p>
            {sessionRules.map(r => (
              <LimitRow key={r.id} rule={r} onEdit={handleEdit} onDelete={handleDelete} />
            ))}
          </>
        )}

        {rules.length === 0 && !showForm && (
          <div className="lp-empty">
            <p>Sin límites configurados</p>
            <p className="lp-empty-hint">Se usan los defaults: 10 msgs/min (rate) y 10 msgs (sesión)</p>
          </div>
        )}

        {/* Form */}
        {showForm ? (
          <LimitForm initial={editRule} onSave={handleSave} onCancel={handleCancel} />
        ) : (
          <button className="ap-btn ap-btn-add" onClick={() => { setEditRule(null); setShowForm(true); }}>
            <Plus size={14} /> Nuevo límite
          </button>
        )}
      </div>
    </div>
  );
}
