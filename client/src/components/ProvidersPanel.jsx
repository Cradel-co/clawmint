import { useState, useRef, useEffect } from 'react';
import { Settings, X, Download, Check, Copy, Link } from 'lucide-react';
import { useProviders, useUpdateProvider, useSetDefaultProvider } from '../api/providers';
import { API_BASE } from '../config';
import styles from './ProvidersPanel.module.css';
import apStyles from './AgentsPanel.module.css';

const PROVIDER_NAMES = {
  'claude-code': 'Claude Code',
  'gemini-cli':  'Gemini CLI',
  opencode:      'OpenCode',
  anthropic:     'Anthropic API',
  gemini:        'Google Gemini',
  openai:        'OpenAI',
  grok:          'Grok (xAI)',
  deepseek:      'DeepSeek',
  ollama:        'Ollama (local)',
};

// Providers que no usan API key de Clawmint
const NO_API_KEY_PROVIDERS = new Set(['claude-code', 'gemini-cli', 'opencode', 'ollama']);

// Sub-providers que opencode puede usar, con su label y placeholder
const OPENCODE_SUB_PROVIDERS = [
  { key: 'anthropic', label: 'Anthropic',  placeholder: 'sk-ant-...' },
  { key: 'openai',    label: 'OpenAI',     placeholder: 'sk-...' },
  { key: 'google',    label: 'Google',     placeholder: 'AIza...' },
  { key: 'groq',      label: 'Groq',       placeholder: 'gsk_...' },
  { key: 'xai',       label: 'xAI (Grok)', placeholder: 'xai-...' },
];

export default function ProvidersPanel({ onClose }) {
  const { data, isLoading, error: loadError, refetch } = useProviders();
  const updateProvider = useUpdateProvider();
  const setDefault = useSetDefaultProvider();

  const providers = data?.providers || [];
  const defaultProvider = data?.default || 'claude-code';

  const [keys, setKeys] = useState({});
  const [saving, setSaving] = useState({});
  const [msg, setMsg] = useState('');

  // Estado de instalación de opencode
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState('');
  const logRef = useRef(null);

  // Estado de API keys de opencode (sub-providers)
  const [ocKeys, setOcKeys]       = useState({});
  const [savingOcKey, setSavingOcKey] = useState({});

  // Estado del endpoint OpenAI-compat
  const v1Url = `${API_BASE}/v1`;
  const [compatKey, setCompatKey]             = useState('');
  const [compatKeyStatus, setCompatKeyStatus] = useState(null); // null | 'set' | 'unset'
  const [savingCompatKey, setSavingCompatKey] = useState(false);
  const [compatDefaultModel, setCompatDefaultModel] = useState('');
  const [savedDefaultModel, setSavedDefaultModel]   = useState('');
  const [savingDefaultModel, setSavingDefaultModel] = useState(false);
  const [copied, setCopied] = useState({});

  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    fetch(`${API_BASE}/api/system-config/openai_compat_api_key`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => setCompatKeyStatus(d ? 'set' : 'unset'))
      .catch(() => setCompatKeyStatus('unset'));
    fetch(`${API_BASE}/api/system-config/openai_compat_default_model`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.value) { setSavedDefaultModel(d.value); setCompatDefaultModel(d.value); } })
      .catch(() => {});
  }, []);

  async function applyCompatDefaultModel(value) {
    setSavingDefaultModel(true);
    try {
      const token = localStorage.getItem('accessToken');
      if (!value) {
        await fetch(`${API_BASE}/api/system-config/openai_compat_default_model`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
        });
        setSavedDefaultModel('');
        setMsg('Modelo restablecido al built-in (Haiku)');
      } else {
        const r = await fetch(`${API_BASE}/api/system-config/openai_compat_default_model`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ value }),
        });
        if (r.ok) { setSavedDefaultModel(value); setMsg(`Modelo por defecto: ${value}`); }
        else { const d = await r.json(); setMsg('Error: ' + (d.error || r.status)); }
      }
    } catch (err) {
      setMsg('Error: ' + err.message);
    } finally {
      setSavingDefaultModel(false);
    }
  }

  async function saveCompatKey() {
    if (!compatKey.trim()) return;
    setSavingCompatKey(true);
    try {
      const token = localStorage.getItem('accessToken');
      const r = await fetch(`${API_BASE}/api/system-config/openai_compat_api_key`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ value: compatKey.trim() }),
      });
      if (r.ok) { setMsg('API key guardada'); setCompatKeyStatus('set'); setCompatKey(''); }
      else { const d = await r.json(); setMsg('Error: ' + (d.error || r.status)); }
    } catch (err) {
      setMsg('Error: ' + err.message);
    } finally {
      setSavingCompatKey(false);
    }
  }

  async function deleteCompatKey() {
    const token = localStorage.getItem('accessToken');
    await fetch(`${API_BASE}/api/system-config/openai_compat_api_key`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    setCompatKeyStatus('unset');
    setMsg('API key eliminada');
  }

  function copyToClipboard(text, key) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(c => ({ ...c, [key]: true }));
      setTimeout(() => setCopied(c => ({ ...c, [key]: false })), 1500);
    });
  }

  // Init keys cuando llegan providers (solo si vacío)
  if (providers.length > 0 && Object.keys(keys).length === 0) {
    const k = {};
    for (const p of providers) {
      k[p.name] = { apiKey: '', model: p.currentModel || p.defaultModel || '' };
    }
    setKeys(k);
  }

  async function saveProvider(name) {
    setSaving(s => ({ ...s, [name]: true }));
    try {
      const { apiKey, model } = keys[name] || {};
      await updateProvider.mutateAsync({ name, apiKey: apiKey || undefined, model: model || undefined });
      setMsg(`${PROVIDER_NAMES[name] || name} guardado`);
    } catch (err) {
      setMsg('Error: ' + err.message);
    } finally {
      setSaving(s => ({ ...s, [name]: false }));
    }
  }

  async function saveDefault(name) {
    try {
      await setDefault.mutateAsync(name);
      setMsg(`Provider por defecto: ${PROVIDER_NAMES[name] || name}`);
    } catch (err) {
      setMsg('Error: ' + err.message);
    }
  }

  async function installOpenCode() {
    setInstalling(true);
    setInstallLog('');
    try {
      const token = localStorage.getItem('accessToken');
      const res = await fetch(`${API_BASE}/api/providers/opencode/install`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            if (ev.log) {
              setInstallLog(l => l + ev.log);
              if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
            }
            if (ev.done) {
              if (ev.installed) {
                setMsg('OpenCode instalado correctamente');
                refetch();
              } else {
                setMsg('Error al instalar: ' + (ev.error || 'desconocido'));
              }
            }
          } catch (_) {}
        }
      }
    } catch (err) {
      setMsg('Error de conexión: ' + err.message);
    } finally {
      setInstalling(false);
    }
  }

  async function saveOcKey(provider) {
    setSavingOcKey(s => ({ ...s, [provider]: true }));
    try {
      const token = localStorage.getItem('accessToken');
      const key   = ocKeys[provider] || '';
      if (key) {
        await fetch(`${API_BASE}/api/providers/opencode/apikeys/${provider}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ key }),
        });
      } else {
        await fetch(`${API_BASE}/api/providers/opencode/apikeys/${provider}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      }
      setMsg(`Clave de ${provider} guardada`);
      refetch();
    } catch (err) {
      setMsg('Error: ' + err.message);
    } finally {
      setSavingOcKey(s => ({ ...s, [provider]: false }));
    }
  }

  const configurable = providers.filter(p => p.name !== 'claude-code' && p.name !== 'gemini-cli');
  const opencodePv   = providers.find(p => p.name === 'opencode');

  if (isLoading) return <div className={apStyles.panel}><p style={{ padding: 16 }}>Cargando...</p></div>;

  return (
    <div className={apStyles.panel} role="region" aria-label="Panel de proveedores">
      <div className={apStyles.header}>
        <span className={apStyles.title}>
          <Settings size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
          Providers de IA
        </span>
        {onClose && (
          <button className={apStyles.close} onClick={onClose} aria-label="Cerrar panel de proveedores">
            <X size={16} />
          </button>
        )}
      </div>

      <div className={apStyles.body}>
        {(msg || loadError) && <div className={styles.msg}>{msg || 'Error cargando providers'}</div>}

        {/* Provider por defecto */}
        <div className={apStyles.section}>
          <div className={styles.sectionTitle}>Provider por defecto (Telegram)</div>
          <select
            className={styles.defaultSelect}
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
          <div key={p.name} className={apStyles.section}>
            <div className={styles.providerTitle}>
              {p.label}
              <span className={`${styles.statusBadge} ${p.configured ? styles.configured : styles.unconfigured}`}>
                {NO_API_KEY_PROVIDERS.has(p.name)
                  ? (p.name === 'opencode' ? (p.installed ? '● instalado' : '○ no instalado') : '● local')
                  : p.configured ? '● configurado' : '○ sin key'}
              </span>
            </div>

            {/* Sección especial de OpenCode */}
            {p.name === 'opencode' && (
              <>
                {/* Instalación */}
                {!p.installed && (
                  <div style={{ marginBottom: 8 }}>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                      OpenCode no está instalado en este sistema.
                    </p>
                    <button
                      className={`${apStyles.btn} ${apStyles.btnPrimary}`}
                      onClick={installOpenCode}
                      disabled={installing}
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <Download size={14} />
                      {installing ? 'Instalando…' : 'Instalar OpenCode (npm)'}
                    </button>
                  </div>
                )}

                {p.installed && (
                  <p style={{ fontSize: 12, color: 'var(--accent-orange)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Check size={13} /> opencode en PATH
                  </p>
                )}

                {/* Log de instalación */}
                {installLog && (
                  <pre
                    ref={logRef}
                    style={{
                      fontSize: 10, background: 'var(--bg-secondary)', padding: 8, borderRadius: 4,
                      maxHeight: 140, overflow: 'auto', marginBottom: 8, color: 'var(--text-muted)',
                    }}
                  >
                    {installLog}
                  </pre>
                )}

                {/* Modelo */}
                <label className={styles.fieldLabel}>Modelo por defecto (provider/model)</label>
                <input
                  className={styles.input}
                  type="text"
                  placeholder="anthropic/claude-opus-4-7"
                  value={keys[p.name]?.model || ''}
                  onChange={e => setKeys(k => ({ ...k, [p.name]: { ...k[p.name], model: e.target.value } }))}
                />
                <button
                  className={`${apStyles.btn} ${apStyles.btnPrimary}`}
                  onClick={() => saveProvider(p.name)}
                  disabled={saving[p.name]}
                  style={{ marginBottom: 12 }}
                >
                  {saving[p.name] ? 'Guardando…' : 'Guardar modelo'}
                </button>

                {/* API Keys de sub-proveedores */}
                <div className={styles.sectionTitle} style={{ marginTop: 4 }}>
                  API Keys para sub-proveedores de OpenCode
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                  Configurá las keys del proveedor IA que OpenCode va a usar internamente.
                </p>
                {OPENCODE_SUB_PROVIDERS.map(sub => {
                  const saved = p.apiKeys?.[sub.key];
                  return (
                    <div key={sub.key} style={{ marginBottom: 8 }}>
                      <label className={styles.fieldLabel}>
                        {sub.label}
                        {saved && (
                          <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent-orange)' }}>
                            ● {saved}
                          </span>
                        )}
                      </label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          className={styles.input}
                          type="password"
                          placeholder={sub.placeholder}
                          value={ocKeys[sub.key] || ''}
                          onChange={e => setOcKeys(k => ({ ...k, [sub.key]: e.target.value }))}
                          style={{ flex: 1 }}
                        />
                        <button
                          className={`${apStyles.btn} ${apStyles.btnPrimary}`}
                          onClick={() => saveOcKey(sub.key)}
                          disabled={savingOcKey[sub.key]}
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          {savingOcKey[sub.key] ? '…' : saved ? 'Actualizar' : 'Guardar'}
                        </button>
                        {saved && (
                          <button
                            className={apStyles.btn}
                            onClick={() => { setOcKeys(k => ({ ...k, [sub.key]: '' })); saveOcKey(sub.key); }}
                            title="Borrar key"
                          >
                            <X size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            {/* Providers normales (con API key única) */}
            {p.name !== 'opencode' && !NO_API_KEY_PROVIDERS.has(p.name) && (
              <>
                <label className={styles.fieldLabel}>API Key</label>
                <input
                  className={styles.input}
                  type="password"
                  placeholder="sk-... / AIza... / sk-ant-..."
                  value={keys[p.name]?.apiKey || ''}
                  onChange={e => setKeys(k => ({ ...k, [p.name]: { ...k[p.name], apiKey: e.target.value } }))}
                  aria-label={`API Key para ${p.label}`}
                />
              </>
            )}

            {p.name !== 'opencode' && (
              <>
                <label className={styles.fieldLabel}>Modelo</label>
                <select
                  className={styles.select}
                  value={keys[p.name]?.model || p.defaultModel || ''}
                  onChange={e => setKeys(k => ({ ...k, [p.name]: { ...k[p.name], model: e.target.value } }))}
                  aria-label={`Modelo para ${p.label}`}
                >
                  {(p.models || []).map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>

                <button
                  className={`${apStyles.btn} ${apStyles.btnPrimary}`}
                  onClick={() => saveProvider(p.name)}
                  disabled={saving[p.name]}
                >
                  {saving[p.name] ? 'Guardando…' : 'Guardar'}
                </button>
              </>
            )}
          </div>
        ))}
        {/* ── API Compatible OpenAI (/v1) ─────────────────────────── */}
        <div className={apStyles.section}>
          <div className={styles.sectionTitle} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Link size={12} />
            API Compatible OpenAI
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            Conectá Open WebUI, LM Studio, SillyTavern u otros clientes que soporten la API de OpenAI.
            El modelo que responde se controla con el campo <code style={{ background: 'var(--bg-card)', padding: '1px 4px', borderRadius: 3 }}>model</code> del request.
          </p>

          {/* Modelo por defecto */}
          <label className={styles.fieldLabel}>
            Proveedor / modelo por defecto
            <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)' }}>
              {savingDefaultModel ? '  guardando…' : ''}
            </span>
          </label>
          <select
            className={styles.select}
            value={compatDefaultModel}
            disabled={savingDefaultModel}
            onChange={e => { setCompatDefaultModel(e.target.value); applyCompatDefaultModel(e.target.value); }}
          >
            <option value="">— Haiku (built-in por defecto) —</option>
            {providers
              .filter(p => !['claude-code', 'gemini-cli'].includes(p.name))
              .map(p => (
                <optgroup key={p.name} label={p.label + (!p.configured ? '  ⚠ sin API key' : '')}>
                  {(p.models || []).map(m => (
                    <option key={`${p.name}/${m}`} value={`${p.name}/${m}`}>
                      {m}
                    </option>
                  ))}
                </optgroup>
              ))
            }
          </select>

          {/* URL */}
          <label className={styles.fieldLabel}>Endpoint URL</label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <input
              className={styles.input}
              style={{ flex: 1, marginBottom: 0, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-orange)' }}
              readOnly
              value={v1Url}
            />
            <button className={apStyles.btn} onClick={() => copyToClipboard(v1Url, 'url')} title="Copiar URL">
              {copied.url ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>

          {/* API Key */}
          <label className={styles.fieldLabel}>
            API Key
            {compatKeyStatus === 'set' && (
              <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent-orange)' }}>● configurada</span>
            )}
            {compatKeyStatus === 'unset' && (
              <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)' }}>○ no configurada</span>
            )}
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className={styles.input}
              style={{ flex: 1, marginBottom: 0 }}
              type="password"
              placeholder={compatKeyStatus === 'set' ? 'Nueva key (dejar vacío para mantener)' : 'ej. mi-clave-secreta-123'}
              value={compatKey}
              onChange={e => setCompatKey(e.target.value)}
            />
            <button
              className={`${apStyles.btn} ${apStyles.btnPrimary}`}
              onClick={saveCompatKey}
              disabled={savingCompatKey || !compatKey.trim()}
              style={{ whiteSpace: 'nowrap' }}
            >
              {savingCompatKey ? '…' : compatKeyStatus === 'set' ? 'Cambiar' : 'Guardar'}
            </button>
            {compatKeyStatus === 'set' && (
              <button className={apStyles.btn} onClick={deleteCompatKey} title="Eliminar key">
                <X size={13} />
              </button>
            )}
          </div>

          {/* Ejemplo de uso */}
          <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8 }}>
            Ejemplo de model: <code style={{ background: 'var(--bg-card)', padding: '1px 4px', borderRadius: 3 }}>anthropic/claude-opus-4-6</code> ·{' '}
            <code style={{ background: 'var(--bg-card)', padding: '1px 4px', borderRadius: 3 }}>ollama/llama3.2</code> ·{' '}
            <code style={{ background: 'var(--bg-card)', padding: '1px 4px', borderRadius: 3 }}>default</code>
          </p>
        </div>
      </div>
    </div>
  );
}
