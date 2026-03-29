import { useState, useEffect, useCallback } from 'react';
import { Check, Pencil, Trash2, X, Plus, Plug } from 'lucide-react';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';
import styles from './AgentsPanel.module.css';

const API = `${API_BASE}/api/mcps`;

// Parsea "KEY=VALUE\nKEY2=VALUE2" → { KEY: "VALUE", KEY2: "VALUE2" }
function parseEnv(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k) env[k] = v;
    }
  }
  return env;
}

// Parsea "Key: Value\nKey2: Value2" → { Key: "Value", Key2: "Value2" }
function parseHeaders(text) {
  const headers = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k) headers[k] = v;
    }
  }
  return headers;
}

function envToText(env) {
  if (!env || typeof env !== 'object') return '';
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
}

function headersToText(headers) {
  if (!headers || typeof headers !== 'object') return '';
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function McpForm({ initial, onSave, onCancel }) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [type, setType] = useState(initial?.type || 'stdio');
  const [command, setCommand] = useState(initial?.command || '');
  const [argsText, setArgsText] = useState((initial?.args || []).join(' '));
  const [envText, setEnvText] = useState(envToText(initial?.env));
  const [url, setUrl] = useState(initial?.url || '');
  const [headersText, setHeadersText] = useState(headersToText(initial?.headers));
  const [description, setDescription] = useState(initial?.description || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isStdio = isEdit ? initial.type === 'stdio' : type === 'stdio';
  const missingRequired = (!isEdit && !name.trim())
    || (isStdio && !command.trim())
    || (!isStdio && !url.trim());

  const handleSubmit = async () => {
    setError('');

    const body = { description: description.trim() };
    if (!isEdit) {
      body.name = name.trim();
      body.type = type;
    }
    if (type === 'stdio') {
      body.command = command.trim();
      body.args = argsText.trim() ? argsText.trim().split(/\s+/) : [];
      body.env = parseEnv(envText);
    } else {
      body.url = url.trim();
      body.headers = parseHeaders(headersText);
    }

    setLoading(true);
    try {
      const endpoint = isEdit ? `${API}/${initial.name}` : API;
      const method = isEdit ? 'PATCH' : 'POST';
      const res = await apiFetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');
      onSave();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.form}>
      <p className={styles.formTitle}>{isEdit ? `Editar: ${initial.name}` : 'Nuevo MCP'}</p>

      {!isEdit && (
        <>
          <label className={styles.label}>Nombre</label>
          <input
            className={styles.input}
            type="text"
            placeholder="filesystem, sentry, github..."
            value={name}
            onChange={e => { setName(e.target.value); setError(''); }}
          />

          <label className={styles.label} style={{ marginTop: 8 }}>Tipo</label>
          <select className={styles.input} value={type} onChange={e => setType(e.target.value)}>
            <option value="stdio">stdio</option>
            <option value="http">http</option>
            <option value="sse">sse</option>
          </select>
        </>
      )}

      {(isEdit ? initial.type === 'stdio' : type === 'stdio') ? (
        <>
          <label className={styles.label} style={{ marginTop: 8 }}>Comando</label>
          <input
            className={styles.input}
            type="text"
            placeholder="npx, node, python..."
            value={command}
            onChange={e => setCommand(e.target.value)}
          />

          <label className={styles.label} style={{ marginTop: 8 }}>Args (separados por espacio)</label>
          <input
            className={styles.input}
            type="text"
            placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
            value={argsText}
            onChange={e => setArgsText(e.target.value)}
          />

          <label className={styles.label} style={{ marginTop: 8 }}>Variables de entorno (KEY=VALUE por línea)</label>
          <textarea
            className={styles.textarea}
            rows={3}
            placeholder="SENTRY_TOKEN=xxx&#10;API_KEY=yyy"
            value={envText}
            onChange={e => setEnvText(e.target.value)}
          />
        </>
      ) : (
        <>
          <label className={styles.label} style={{ marginTop: 8 }}>URL</label>
          <input
            className={styles.input}
            type="text"
            placeholder="https://..."
            value={url}
            onChange={e => setUrl(e.target.value)}
          />

          <label className={styles.label} style={{ marginTop: 8 }}>Headers (Key: Value por línea)</label>
          <textarea
            className={styles.textarea}
            rows={3}
            placeholder="Authorization: Bearer xxx&#10;X-API-Key: yyy"
            value={headersText}
            onChange={e => setHeadersText(e.target.value)}
          />
        </>
      )}

      <label className={styles.label} style={{ marginTop: 8 }}>Descripción (opcional)</label>
      <input
        className={styles.input}
        type="text"
        placeholder="Acceso al sistema de archivos local"
        value={description}
        onChange={e => setDescription(e.target.value)}
      />

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.btnRow}>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handleSubmit}
          disabled={loading || missingRequired}
        >
          {loading ? '...' : isEdit ? <><Check size={13} /> Guardar</> : <><Check size={13} /> Crear</>}
        </button>
        <button className={`${styles.btn} ${styles.btnGhost}`} onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}

function McpRow({ mcp, onEdit, onDelete, onToggle, toggling }) {
  return (
    <div className={styles.agentRow}>
      <div className={styles.agentTop}>
        <span className={styles.agentKey}>
          <span style={{ color: mcp.enabled ? '#4caf50' : '#888', marginRight: 6 }}>●</span>
          {mcp.name}
          <span className={styles.roleBadge} style={{ marginLeft: 6, fontSize: '0.7rem', opacity: 0.7 }}>
            [{mcp.type}]
          </span>
        </span>
        <div className={styles.agentActions}>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            style={{ fontSize: '0.72rem', padding: '2px 8px', marginRight: 4 }}
            onClick={() => onToggle(mcp)}
            disabled={toggling === mcp.name}
            title={mcp.enabled ? 'Desactivar' : 'Activar'}
          >
            {toggling === mcp.name ? '...' : mcp.enabled ? 'OFF' : 'ON'}
          </button>
          <button className={styles.iconBtn} onClick={() => onEdit(mcp)} title="Editar"><Pencil size={13} /></button>
          <button className={`${styles.iconBtn} ${styles.iconBtnDanger}`} onClick={() => onDelete(mcp.name)} title="Eliminar"><Trash2 size={13} /></button>
        </div>
      </div>
      {mcp.description && <p className={styles.agentDesc}>{mcp.description}</p>}
      {mcp.type === 'stdio' && mcp.command && (
        <p className={styles.agentPrompt} style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>
          {mcp.command} {(mcp.args || []).join(' ')}
        </p>
      )}
      {mcp.type !== 'stdio' && mcp.url && (
        <p className={styles.agentPrompt} style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>
          {mcp.url}
        </p>
      )}
    </div>
  );
}

export default function McpsPanel({ onClose }) {
  const [mcpList, setMcpList] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editMcp, setEditMcp] = useState(null);
  const [toggling, setToggling] = useState(null);
  const [cliError, setCliError] = useState('');

  const fetchMcps = useCallback(async () => {
    try {
      setCliError('');
      const res = await apiFetch(API);
      const data = await res.json();
      setMcpList(Array.isArray(data) ? data : []);
    } catch { setCliError('Error cargando MCPs'); }
  }, []);

  useEffect(() => { fetchMcps(); }, [fetchMcps]);

  const handleSave = () => {
    setShowForm(false);
    setEditMcp(null);
    fetchMcps();
  };

  const handleEdit = (mcp) => {
    setEditMcp(mcp);
    setShowForm(true);
  };

  const handleDelete = async (name) => {
    if (!confirm(`¿Eliminar el MCP "${name}"?`)) return;
    try {
      await apiFetch(`${API}/${name}`, { method: 'DELETE' });
      fetchMcps();
    } catch { setCliError('Error eliminando MCP'); }
  };

  const handleToggle = async (mcp) => {
    setCliError('');
    setToggling(mcp.name);
    try {
      const action = mcp.enabled ? 'disable' : 'enable';
      const res = await apiFetch(`${API}/${mcp.name}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error CLI');
      fetchMcps();
    } catch (err) {
      setCliError(`Error al ${mcp.enabled ? 'desactivar' : 'activar'} "${mcp.name}": ${err.message}`);
    } finally {
      setToggling(null);
    }
  };

  return (
    <div className={styles.panel} role="region" aria-label="Panel de MCPs">
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          <span className={styles.icon}><Plug size={16} /></span>
          MCPs
        </span>
        {onClose && <button className={styles.close} onClick={onClose} aria-label="Cerrar panel de MCPs"><X size={16} /></button>}
      </div>

      <div className={styles.body}>
        {mcpList.length === 0 && !showForm && (
          <div className={styles.emptyState}>
            <p>Sin MCPs configurados</p>
            <p className={styles.emptyHint}>Agregá un MCP para extender las capacidades de Claude con herramientas externas.</p>
            <button className={`${styles.btn} ${styles.btnPrimary}`} style={{ marginTop: 10 }} onClick={() => { setEditMcp(null); setShowForm(true); }}>
              <Plus size={13} /> Agregar primer MCP
            </button>
          </div>
        )}

        {cliError && <p className={styles.error}>{cliError}</p>}

        {mcpList.map(mcp =>
          showForm && editMcp?.name === mcp.name ? null : (
            <McpRow
              key={mcp.name}
              mcp={mcp}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onToggle={handleToggle}
              toggling={toggling}
            />
          )
        )}

        {showForm ? (
          <McpForm
            initial={editMcp}
            onSave={handleSave}
            onCancel={() => { setShowForm(false); setEditMcp(null); }}
          />
        ) : (
          <button className={`${styles.btn} ${styles.btnAdd}`} onClick={() => { setEditMcp(null); setShowForm(true); }}>
            <Plus size={14} /> Nuevo MCP
          </button>
        )}
      </div>
    </div>
  );
}
