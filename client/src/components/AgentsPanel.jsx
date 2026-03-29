import { useState, useEffect, useCallback } from 'react';
import { Check, Pencil, Trash2, X, Plus, Users, Sparkles } from 'lucide-react';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';
import { useAgents, useDeleteAgent } from '../api/agents';
import styles from './AgentsPanel.module.css';

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
      const res = await apiFetch(url, {
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
    <div className={styles.form}>
      <p className={styles.formTitle}>{isEdit ? `Editar agente: ${initial.key}` : 'Nuevo agente'}</p>

      {!isEdit && (
        <>
          <label className={styles.label}>Clave (key)</label>
          <input
            className={styles.input}
            type="text"
            placeholder="psicologo, chef, abogado..."
            value={key}
            onChange={e => { setKey(e.target.value); setError(''); }}
            aria-label="Clave del agente"
          />
        </>
      )}

      <label className={styles.label} style={{ marginTop: 8 }}>Descripción</label>
      <input
        className={styles.input}
        type="text"
        placeholder="Psicólogo empático y profesional"
        value={description}
        onChange={e => setDescription(e.target.value)}
        aria-label="Descripción del agente"
      />

      <label className={styles.label} style={{ marginTop: 8 }}>Prompt de rol</label>
      <textarea
        className={styles.textarea}
        rows={6}
        placeholder={"Sos un psicólogo empático y profesional. Escuchás con atención, hacés preguntas abiertas y respondés con calidez. Nunca dás diagnósticos médicos."}
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
      />
      <p className={styles.hint}>Dejá vacío si el agente no tiene rol especial (bash, claude base).</p>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.btnRow}>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSubmit} disabled={loading || !key.trim()}>
          {loading ? '...' : isEdit ? <><Check size={13} /> Guardar</> : <><Check size={13} /> Crear</>}
        </button>
        <button className={`${styles.btn} ${styles.btnGhost}`} onClick={onCancel}>
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
    <div className={styles.agentRow}>
      <div className={styles.agentTop}>
        <span className={styles.agentKey}>
          {hasPrompt && <span className={styles.roleBadge}><Sparkles size={12} /></span>}
          /{agent.key}
        </span>
        <div className={styles.agentActions}>
          <button className={styles.iconBtn} onClick={() => onEdit(agent)} title="Editar" aria-label={`Editar agente ${agent.key}`}><Pencil size={13} /></button>
          <button className={`${styles.iconBtn} ${styles.iconBtnDanger}`} onClick={() => onDelete(agent.key)} title="Eliminar" aria-label={`Eliminar agente ${agent.key}`}><Trash2 size={13} /></button>
        </div>
      </div>
      {agent.description && (
        <p className={styles.agentDesc}>{agent.description}</p>
      )}
      {promptPreview && (
        <p className={styles.agentPrompt}>"{promptPreview}"</p>
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
    apiFetch(SKILLS_API).then(r => r.json()).then(data => setSkillsList(Array.isArray(data) ? data : [])).catch(() => setError('Error cargando skills'));
  }, []);

  useEffect(() => { loadSkills(); }, [loadSkills]);

  const install = async () => {
    if (!slug.trim()) return;
    setInstalling(true);
    setError('');
    try {
      const res = await apiFetch(`${SKILLS_API}/install`, {
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
    await apiFetch(`${SKILLS_API}/${s}`, { method: 'DELETE' });
    loadSkills();
  };

  return (
    <div className={styles.skillsSection}>
      <h3 className={styles.skillsTitle}>Skills globales</h3>
      <p className={styles.skillsHint}>Los skills instalados se inyectan en el prompt de todos los agentes.</p>
      <div className={styles.skillsInstall}>
        <input
          className={styles.input}
          value={slug}
          onChange={e => { setSlug(e.target.value); setError(''); }}
          placeholder="slug del skill (ej: bible-study)"
          onKeyDown={e => e.key === 'Enter' && install()}
          aria-label="Slug del skill a instalar"
        />
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={install} disabled={installing || !slug.trim()}>
          {installing ? '...' : 'Instalar'}
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
      {skillsList.length === 0 && (
        <p className={styles.skillsEmpty}>Sin skills instalados. Escribí un slug arriba para instalar uno.</p>
      )}
      {skillsList.map(s => (
        <div key={s.slug} className={styles.skillRow}>
          <div className={styles.skillInfo}>
            <span className={styles.skillName}>{s.name || s.slug}</span>
            <span className={styles.skillSlug}>{s.slug}</span>
            {s.description && <span className={styles.skillDesc}>{s.description}</span>}
          </div>
          <button className={`${styles.iconBtn} ${styles.iconBtnDanger}`} onClick={() => uninstall(s.slug)} title="Desinstalar" aria-label={`Desinstalar skill ${s.name || s.slug}`}><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}

export default function AgentsPanel({ onClose }) {
  const { data: agents = [], isLoading, error: loadError } = useAgents();
  const deleteAgent = useDeleteAgent();
  const [showForm, setShowForm] = useState(false);
  const [editAgent, setEditAgent] = useState(null);

  const handleSave = () => {
    setShowForm(false);
    setEditAgent(null);
  };

  const handleEdit = (agent) => {
    setEditAgent(agent);
    setShowForm(true);
  };

  const handleDelete = async (key) => {
    if (!confirm(`¿Eliminar el agente "${key}"?`)) return;
    deleteAgent.mutate(key);
  };

  const handleNewClick = () => {
    setEditAgent(null);
    setShowForm(true);
  };

  if (isLoading) return <div className={styles.panel}><p style={{ padding: 16 }}>Cargando...</p></div>;

  return (
    <div className={styles.panel} role="region" aria-label="Panel de agentes">
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          <span className={styles.icon}><Users size={16} /></span>
          Agentes personalizados
        </span>
        {onClose && <button className={styles.close} onClick={onClose} aria-label="Cerrar panel de agentes"><X size={16} /></button>}
      </div>

      {(loadError || deleteAgent.error) && <div className={styles.error} style={{ padding: '6px 14px' }}>{loadError?.message || deleteAgent.error?.message || 'Error'}</div>}
      <div className={styles.body}>
        {agents.length === 0 && !showForm && (
          <div className={styles.emptyState}>
            <p>Sin agentes configurados</p>
            <p className={styles.emptyHint}>Creá un agente con un prompt de rol para usarlo en Telegram con /{'<key>'}</p>
            <button className={`${styles.btn} ${styles.btnPrimary}`} style={{ marginTop: 10 }} onClick={handleNewClick}>
              <Plus size={13} /> Crear primer agente
            </button>
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
          <button className={`${styles.btn} ${styles.btnAdd}`} onClick={handleNewClick}>
            <Plus size={14} /> Nuevo agente
          </button>
        )}

        <div className={styles.divider} />
        <SkillsSection />
      </div>
    </div>
  );
}
