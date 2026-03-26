import { useState, useEffect } from 'react';
import { Settings, X, CheckCircle } from 'lucide-react';
import { API_BASE } from '../config.js';
import './ProvidersPanel.css';

const API = API_BASE;

const PROVIDER_NAMES = {
  'claude-code': 'Claude Code',
  anthropic: 'Anthropic API',
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  grok: 'Grok (xAI)',
  ollama: 'Ollama (local)',
};

export default function ProvidersPanel({ onClose }) {
  const [providers, setProviders] = useState([]);
  const [defaultProvider, setDefaultProvider] = useState('claude-code');
  const [keys, setKeys] = useState({});   // { providerName: { apiKey, model } }
  const [saving, setSaving] = useState({});
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetchProviders();
  }, []);

  async function fetchProviders() {
    try {
      const res = await fetch(`${API}/api/providers`);
      const data = await res.json();
      setProviders(data.providers || []);
      setDefaultProvider(data.default || 'claude-code');
      const k = {};
      for (const p of data.providers || []) {
        k[p.name] = { apiKey: '', model: p.currentModel || p.defaultModel || '' };
      }
      setKeys(k);
    } catch (err) {
      setMsg('Error cargando providers: ' + err.message);
    }
  }

  async function saveProvider(name) {
    setSaving(s => ({ ...s, [name]: true }));
    try {
      const { apiKey, model } = keys[name] || {};
      await fetch(`${API}/api/providers/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey || undefined, model: model || undefined }),
      });
      setMsg(`${PROVIDER_NAMES[name] || name} guardado`);
      fetchProviders();
    } catch (err) {
      setMsg('Error: ' + err.message);
    } finally {
      setSaving(s => ({ ...s, [name]: false }));
    }
  }

  async function saveDefault(name) {
    try {
      await fetch(`${API}/api/providers/default`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: name }),
      });
      setDefaultProvider(name);
      setMsg(`Provider por defecto: ${PROVIDER_NAMES[name] || name}`);
    } catch (err) {
      setMsg('Error: ' + err.message);
    }
  }

  const configurable = providers.filter(p => p.name !== 'claude-code');

  return (
    <div className="ap-panel" role="region" aria-label="Panel de proveedores">
      <div className="ap-header">
        <span className="ap-title"><Settings size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />Providers de IA</span>
        <button className="ap-close" onClick={onClose} aria-label="Cerrar panel de proveedores"><X size={16} /></button>
      </div>

      <div className="ap-body">
        {msg && <div className="pp-msg">{msg}</div>}

        {/* Provider por defecto */}
        <div className="ap-section">
          <div className="pp-section-title">Provider por defecto (Telegram)</div>
          <select
            className="pp-default-select"
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
          <div key={p.name} className="ap-section">
            <div className="pp-provider-title">
              {p.label}
              <span className={`pp-status-badge ${(p.configured || p.name === 'ollama') ? 'configured' : 'unconfigured'}`}>
                {p.name === 'ollama' ? '● local' : p.configured ? '● configurado' : '○ sin key'}
              </span>
            </div>

            {p.name !== 'ollama' && (<>
            <label className="pp-field-label">API Key</label>
            <input
              className="pp-input"
              type="password"
              placeholder="sk-... / AIza... / sk-ant-..."
              value={keys[p.name]?.apiKey || ''}
              onChange={e => setKeys(k => ({ ...k, [p.name]: { ...k[p.name], apiKey: e.target.value } }))}
              aria-label={`API Key para ${p.label}`}
            />
            </>)}

            <label className="pp-field-label">Modelo</label>
            <select
              className="pp-select"
              value={keys[p.name]?.model || p.defaultModel || ''}
              onChange={e => setKeys(k => ({ ...k, [p.name]: { ...k[p.name], model: e.target.value } }))}
              aria-label={`Modelo para ${p.label}`}
            >
              {(p.models || []).map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>

            <button
              className="ap-btn ap-btn-primary"
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
