import { useState, useEffect, useCallback } from 'react';
import { API_BASE } from '../config.js';
import './AgentsPanel.css';

const API = `${API_BASE}/api/agents`;
const SKILLS_API = `${API_BASE}/api/skills`;

function AgentForm({ initial, onSave, onCancel }) {
  const isEdit = !!initial;
  const [key, setKey] = useState(initial?.key || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [prompt, setPrompt] = useState(initial?.prompt || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    setError('');
    if (!key.trim()) { setError('La clave es obligatoria'); return; }
    setLoading(true);
    try {
      const url = isEdit ? `${API}/${initial.key}` : API;
      const method = isEdit ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key.trim(), description: description.trim(), prompt: prompt.trim() }),
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
    <div className="ap-form">
      <p className="ap-form-title">{isEdit ? `Editar agente: ${initial.key}` : 'Nuevo agente'}</p>

      {!isEdit && (
        <>
          <label className="ap-label">Clave (key)</label>
          <input
            className="ap-input"
            type="text"
            placeholder="psicologo, chef, abogado..."
            value={key}
            onChange={e => { setKey(e.target.value); setError(''); }}
          />
        </>
      )}

      <label className="ap-label" style={{ marginTop: 8 }}>Descripción</label>
      <input
        className="ap-input"
        type="text"
        placeholder="Psicólogo empático y profesional"
        value={description}
        onChange={e => setDescription(e.target.value)}
      />

      <label className="ap-label" style={{ marginTop: 8 }}>Prompt de rol</label>
      <textarea
        className="ap-textarea"
        rows={6}
        placeholder={"Sos un psicólogo empático y profesional. Escuchás con atención, hacés preguntas abiertas y respondés con calidez. Nunca dás diagnósticos médicos."}
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
      />
      <p className="ap-hint">Dejá vacío si el agente no tiene rol especial (bash, claude base).</p>

      {error && <p className="ap-error">{error}</p>}

      <div className="ap-btn-row">
        <button className="ap-btn ap-btn-primary" onClick={handleSubmit} disabled={loading || !key.trim()}>
          {loading ? '...' : isEdit ? '✓ Guardar' : '✓ Crear'}
        </button>
        <button className="ap-btn ap-btn-ghost" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

function AgentRow({ agent, onEdit, onDelete }) {
  const hasPrompt = agent.prompt && agent.prompt.trim().length > 0;
  const promptPreview = hasPrompt
    ? agent.prompt.slice(0, 50) + (agent.prompt.length > 50 ? '…' : '')
    : null;

  return (
    <div className="ap-agent-row">
      <div className="ap-agent-top">
        <span className="ap-agent-key">
          {hasPrompt && <span className="ap-role-badge">🎭</span>}
          /{agent.key}
        </span>
        <div className="ap-agent-actions">
          <button className="ap-icon-btn" onClick={() => onEdit(agent)} title="Editar">✏️</button>
          <button className="ap-icon-btn ap-icon-btn-danger" onClick={() => onDelete(agent.key)} title="Eliminar">🗑</button>
        </div>
      </div>
      {agent.description && (
        <p className="ap-agent-desc">{agent.description}</p>
      )}
      {promptPreview && (
        <p className="ap-agent-prompt">"{promptPreview}"</p>
      )}
    </div>
  );
}

function SkillsSection() {
  const [skillsList, setSkillsList] = useState([]);
  const [installing, setInstalling] = useState(false);
  const [slug, setSlug] = useState('');
  const [error, setError] = useState('');

  const loadSkills = useCallback(() => {
    fetch(SKILLS_API).then(r => r.json()).then(setSkillsList).catch(() => {});
  }, []);

  useEffect(() => { loadSkills(); }, [loadSkills]);

  const install = async () => {
    if (!slug.trim()) return;
    setInstalling(true);
    setError('');
    try {
      const res = await fetch(`${SKILLS_API}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: slug.trim() }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error al instalar');
      setSlug('');
      loadSkills();
    } catch (err) {
      setError(err.message);
    } finally {
      setInstalling(false);
    }
  };

  const uninstall = async (s) => {
    await fetch(`${SKILLS_API}/${s}`, { method: 'DELETE' });
    loadSkills();
  };

  return (
    <div className="ap-skills-section">
      <h3 className="ap-skills-title">Skills globales</h3>
      <p className="ap-skills-hint">Los skills instalados se inyectan en el prompt de todos los agentes.</p>
      <div className="ap-skills-install">
        <input
          className="ap-input"
          value={slug}
          onChange={e => { setSlug(e.target.value); setError(''); }}
          placeholder="slug del skill (ej: bible-study)"
          onKeyDown={e => e.key === 'Enter' && install()}
        />
        <button className="ap-btn ap-btn-primary" onClick={install} disabled={installing || !slug.trim()}>
          {installing ? '...' : 'Instalar'}
        </button>
      </div>
      {error && <p className="ap-error">{error}</p>}
      {skillsList.length === 0 && (
        <p className="ap-skills-empty">Sin skills instalados</p>
      )}
      {skillsList.map(s => (
        <div key={s.slug} className="ap-skill-row">
          <div className="ap-skill-info">
            <span className="ap-skill-name">{s.name || s.slug}</span>
            <span className="ap-skill-slug">{s.slug}</span>
            {s.description && <span className="ap-skill-desc">{s.description}</span>}
          </div>
          <button className="ap-icon-btn ap-icon-btn-danger" onClick={() => uninstall(s.slug)} title="Desinstalar">✕</button>
        </div>
      ))}
    </div>
  );
}

export default function AgentsPanel({ onClose }) {
  const [agents, setAgents] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editAgent, setEditAgent] = useState(null);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch(API);
      const data = await res.json();
      setAgents(Array.isArray(data) ? data : []);
    } catch { /* ignorar */ }
  }, []);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

  const handleSave = () => {
    setShowForm(false);
    setEditAgent(null);
    fetchAgents();
  };

  const handleEdit = (agent) => {
    setEditAgent(agent);
    setShowForm(true);
  };

  const handleDelete = async (key) => {
    if (!confirm(`¿Eliminar el agente "${key}"?`)) return;
    try {
      await fetch(`${API}/${key}`, { method: 'DELETE' });
      fetchAgents();
    } catch { /* ignorar */ }
  };

  const handleNewClick = () => {
    setEditAgent(null);
    setShowForm(true);
  };

  return (
    <div className="ap-panel">
      <div className="ap-header">
        <span className="ap-header-title">
          <span className="ap-icon">🎭</span>
          Agentes personalizados
        </span>
        <button className="ap-close" onClick={onClose} title="Cerrar">×</button>
      </div>

      <div className="ap-body">
        {agents.length === 0 && !showForm && (
          <div className="ap-empty-state">
            <p>Sin agentes configurados</p>
            <p className="ap-empty-hint">Creá un agente con un prompt de rol para usarlo en Telegram con /{'<key>'}</p>
          </div>
        )}

        {agents.map(agent => (
          showForm && editAgent?.key === agent.key ? null : (
            <AgentRow
              key={agent.key}
              agent={agent}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          )
        ))}

        {showForm ? (
          <AgentForm
            initial={editAgent}
            onSave={handleSave}
            onCancel={() => { setShowForm(false); setEditAgent(null); }}
          />
        ) : (
          <button className="ap-btn ap-btn-add" onClick={handleNewClick}>
            + Nuevo agente
          </button>
        )}

        <div className="ap-divider" />
        <SkillsSection />
      </div>
    </div>
  );
}
