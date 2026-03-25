import { X, Plus } from 'lucide-react';
import './TabBar.css';

export default function TabBar({ sessions, activeId, onSelect, onClose, onNew }) {
  return (
    <div className="tab-bar" role="tablist" aria-label="Sesiones de terminal">
      {sessions.map((session) => (
        <div
          key={session.id}
          className={`tab ${session.id === activeId ? 'active' : ''}`}
          role="tab"
          tabIndex={session.id === activeId ? 0 : -1}
          aria-selected={session.id === activeId}
          onClick={() => onSelect(session.id)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(session.id); } }}
        >
          <span className="tab-title">{session.title}</span>
          {sessions.length > 1 && (
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(session.id);
              }}
              aria-label={`Cerrar ${session.title}`}
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
      <button className="tab-new" onClick={onNew} aria-label="Nueva terminal">
        <Plus size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
