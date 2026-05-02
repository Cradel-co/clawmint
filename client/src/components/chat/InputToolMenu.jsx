import { useEffect, useRef, useState } from 'react';
import {
  Paperclip, Camera, Monitor, Clipboard, ShoppingCart, CalendarPlus,
  StickyNote, Bell, Globe, Sparkles, Folder, RefreshCcw, Cpu, Bot,
  ShieldCheck, Search, Wand2, DollarSign,
} from 'lucide-react';
import styles from '../WebChatPanel.module.css';

const MODES = [
  { id: 'auto', label: 'Auto',  hint: 'Ejecuta tools sin preguntar' },
  { id: 'ask',  label: 'Ask',   hint: 'Pide aprobación antes de cada tool' },
  { id: 'plan', label: 'Plan',  hint: 'Solo describe qué haría, no ejecuta' },
];

const QUICK_ACTIONS = [
  { id: 'grocery',  icon: ShoppingCart, label: 'Mercadería',   prompt: 'Agregá a la lista de mercadería: ' },
  { id: 'event',    icon: CalendarPlus, label: 'Evento',       prompt: 'Agendá un evento familiar: ' },
  { id: 'note',     icon: StickyNote,   label: 'Nota',         prompt: 'Anotá esto en la casa: ' },
  { id: 'reminder', icon: Bell,         label: 'Recordatorio', prompt: 'Recordame: ' },
];

export default function InputToolMenu({
  open, onClose,
  claudeMode, onModeChange,
  webSearch, onWebSearchToggle,
  providers, provider, onProviderChange,
  agentsList, agent, onAgentChange,
  cwd,
  skills,
  onAttachFile, onWebcam, onScreenshotRemote, onPasteClipboard,
  onPrefill, onCdChange, onNew, onShowCost, onInvokeSkill,
}) {
  const ref = useRef(null);
  const [view, setView] = useState('main'); // main | skills | cwd | provider | agent
  const [cwdValue, setCwdValue] = useState(cwd || '');

  useEffect(() => {
    if (!open) return;
    setView('main');
    setCwdValue(cwd || '');
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, cwd, onClose]);

  if (!open) return null;

  const handleQuick = (prompt) => { onPrefill(prompt); onClose(); };

  return (
    <div ref={ref} className={styles.toolMenu} role="menu">
      {view === 'main' && (
        <>
          {/* ── Modos ───────────────────────────────────────────── */}
          <div className={styles.toolSection}>
            <div className={styles.toolSectionTitle}><ShieldCheck size={12} /> Modo</div>
            <div className={styles.modeRow}>
              {MODES.map(m => (
                <button
                  key={m.id}
                  className={`${styles.modePill} ${claudeMode === m.id ? styles.modePillActive : ''}`}
                  onClick={() => { onModeChange(m.id); onClose(); }}
                  title={m.hint}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Adjuntar ────────────────────────────────────────── */}
          <div className={styles.toolSection}>
            <div className={styles.toolSectionTitle}><Paperclip size={12} /> Adjuntar</div>
            <button className={styles.toolItem} onClick={() => { onAttachFile(); onClose(); }}>
              <Paperclip size={14} /> Archivo
            </button>
            <button className={styles.toolItem} onClick={() => { onPasteClipboard(); onClose(); }}>
              <Clipboard size={14} /> Pegar imagen del portapapeles
            </button>
            <button className={styles.toolItem} onClick={() => { onWebcam(); onClose(); }}>
              <Camera size={14} /> Foto desde cámara
            </button>
            <button className={styles.toolItem} onClick={() => { onScreenshotRemote(); onClose(); }}>
              <Monitor size={14} /> Captura del PC remoto (critter)
            </button>
          </div>

          {/* ── Hogar ───────────────────────────────────────────── */}
          <div className={styles.toolSection}>
            <div className={styles.toolSectionTitle}><Sparkles size={12} /> Hogar</div>
            <div className={styles.quickGrid}>
              {QUICK_ACTIONS.map(qa => (
                <button key={qa.id} className={styles.quickBtn} onClick={() => handleQuick(qa.prompt)}>
                  <qa.icon size={14} />
                  <span>{qa.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ── Productividad ───────────────────────────────────── */}
          <div className={styles.toolSection}>
            <div className={styles.toolSectionTitle}><Wand2 size={12} /> Productividad</div>
            <button
              className={`${styles.toolItem} ${webSearch ? styles.toolItemActive : ''}`}
              onClick={() => onWebSearchToggle(!webSearch)}
            >
              <Globe size={14} /> Buscar en la web {webSearch && '✓'}
            </button>
            <button className={styles.toolItem} onClick={() => setView('skills')}>
              <Search size={14} /> Skills <span className={styles.toolMeta}>{skills?.length || 0} →</span>
            </button>
            <button className={styles.toolItem} onClick={() => setView('cwd')}>
              <Folder size={14} /> Cambiar directorio <span className={styles.toolMeta}>{cwd}</span>
            </button>
          </div>

          {/* ── Sesión ──────────────────────────────────────────── */}
          <div className={styles.toolSection}>
            <div className={styles.toolSectionTitle}>Sesión</div>
            <button className={styles.toolItem} onClick={() => setView('provider')}>
              <Cpu size={14} /> Provider <span className={styles.toolMeta}>{provider} →</span>
            </button>
            <button className={styles.toolItem} onClick={() => setView('agent')}>
              <Bot size={14} /> Agente <span className={styles.toolMeta}>{agent || '(ninguno)'} →</span>
            </button>
            <button className={styles.toolItem} onClick={() => { onShowCost(); onClose(); }}>
              <DollarSign size={14} /> Ver costo de la sesión
            </button>
            <button className={styles.toolItem} onClick={() => { onNew(); onClose(); }}>
              <RefreshCcw size={14} /> Nueva conversación
            </button>
          </div>
        </>
      )}

      {view === 'skills' && (
        <div className={styles.toolSection}>
          <div className={styles.toolSectionTitle}>
            <button className={styles.toolBack} onClick={() => setView('main')}>← Skills</button>
          </div>
          {skills && skills.length > 0 ? skills.map(sk => (
            <button
              key={sk.name || sk.id}
              className={styles.toolItem}
              onClick={() => { onInvokeSkill(sk.name || sk.id); onClose(); }}
              title={sk.description || ''}
            >
              <Search size={14} /> {sk.name || sk.id}
            </button>
          )) : <div className={styles.toolEmpty}>No hay skills instalados</div>}
        </div>
      )}

      {view === 'cwd' && (
        <div className={styles.toolSection}>
          <div className={styles.toolSectionTitle}>
            <button className={styles.toolBack} onClick={() => setView('main')}>← Directorio</button>
          </div>
          <input
            type="text"
            className={styles.toolInput}
            value={cwdValue}
            onChange={e => setCwdValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && cwdValue.trim()) {
                onCdChange(cwdValue.trim()); onClose();
              }
            }}
            placeholder="Ruta absoluta o ~"
            autoFocus
          />
          <button
            className={styles.toolItemPrimary}
            onClick={() => { if (cwdValue.trim()) { onCdChange(cwdValue.trim()); onClose(); } }}
          >
            Cambiar a {cwdValue || '...'}
          </button>
        </div>
      )}

      {view === 'provider' && (
        <div className={styles.toolSection}>
          <div className={styles.toolSectionTitle}>
            <button className={styles.toolBack} onClick={() => setView('main')}>← Provider</button>
          </div>
          {providers?.map(p => (
            <button
              key={p.name}
              className={`${styles.toolItem} ${provider === p.name ? styles.toolItemActive : ''}`}
              onClick={() => { onProviderChange(p.name); onClose(); }}
            >
              <Cpu size={14} /> {p.label}
            </button>
          ))}
        </div>
      )}

      {view === 'agent' && (
        <div className={styles.toolSection}>
          <div className={styles.toolSectionTitle}>
            <button className={styles.toolBack} onClick={() => setView('main')}>← Agente</button>
          </div>
          <button
            className={`${styles.toolItem} ${!agent ? styles.toolItemActive : ''}`}
            onClick={() => { onAgentChange(null); onClose(); }}
          >
            <Bot size={14} /> Sin agente
          </button>
          {agentsList?.map(a => (
            <button
              key={a.key || a.name}
              className={`${styles.toolItem} ${agent === (a.key || a.name) ? styles.toolItemActive : ''}`}
              onClick={() => { onAgentChange(a.key || a.name); onClose(); }}
            >
              <Bot size={14} /> {a.key || a.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
