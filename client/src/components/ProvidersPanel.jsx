import { useState, useEffect } from 'react';

const API = 'http://localhost:3001';

const PROVIDER_NAMES = {
  'claude-code': 'Claude Code',
  anthropic: 'Anthropic API',
  gemini: 'Google Gemini',
  openai: 'OpenAI',
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
      setMsg(`✅ ${PROVIDER_NAMES[name] || name} guardado`);
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
      setMsg(`✅ Provider por defecto: ${PROVIDER_NAMES[name] || name}`);
    } catch (err) {
      setMsg('Error: ' + err.message);
    }
  }

  const configurable = providers.filter(p => p.name !== 'claude-code');

  return (
    <div className="ap-panel">
      <div className="ap-header">
        <span className="ap-title">⚙️ Providers de IA</span>
        <button className="ap-close" onClick={onClose}>✕</button>
      </div>

      <div className="ap-body">
        {msg && (
          <div style={{ padding: '6px 10px', marginBottom: 8, background: '#1a2a1a', borderRadius: 4, color: '#7ec87e', fontSize: 12 }}>
            {msg}
          </div>
        )}

        {/* Provider por defecto */}
        <div className="ap-section">
          <div className="ap-section-title">Provider por defecto (Telegram)</div>
          <select
            value={defaultProvider}
            onChange={e => saveDefault(e.target.value)}
            style={{ width: '100%', padding: '6px 8px', background: '#1e1e2e', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4 }}
          >
            {providers.map(p => (
              <option key={p.name} value={p.name}>{p.label}</option>
            ))}
          </select>
        </div>

        {/* API Keys por provider */}
        {configurable.map(p => (
          <div key={p.name} className="ap-section">
            <div className="ap-section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {p.label}
              <span style={{
                padding: '1px 6px', borderRadius: 10, fontSize: 10,
                background: p.configured ? '#1a3a1a' : '#3a1a1a',
                color: p.configured ? '#7ec87e' : '#f38ba8',
              }}>
                {p.configured ? '● configurado' : '○ sin key'}
              </span>
            </div>

            <label style={{ fontSize: 11, color: '#6c7086', display: 'block', marginBottom: 3 }}>API Key</label>
            <input
              type="password"
              placeholder="sk-... / AIza... / sk-ant-..."
              value={keys[p.name]?.apiKey || ''}
              onChange={e => setKeys(k => ({ ...k, [p.name]: { ...k[p.name], apiKey: e.target.value } }))}
              style={{ width: '100%', marginBottom: 6, padding: '5px 8px', background: '#1e1e2e', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, fontSize: 12, boxSizing: 'border-box' }}
            />

            <label style={{ fontSize: 11, color: '#6c7086', display: 'block', marginBottom: 3 }}>Modelo</label>
            <select
              value={keys[p.name]?.model || p.defaultModel || ''}
              onChange={e => setKeys(k => ({ ...k, [p.name]: { ...k[p.name], model: e.target.value } }))}
              style={{ width: '100%', marginBottom: 8, padding: '5px 8px', background: '#1e1e2e', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, fontSize: 12, boxSizing: 'border-box' }}
            >
              {(p.models || []).map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>

            <button
              className="ap-btn"
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
