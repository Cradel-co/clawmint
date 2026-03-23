import { X, Plus } from 'lucide-react';
import './TabBar.css';

export default function TabBar({ sessions, activeId, onSelect, onClose, onNew }) {
  return (
    <div className="tab-bar">
      {sessions.map((session) => (
        <div
          key={session.id}
          className={`tab ${session.id === activeId ? 'active' : ''}`}
          onClick={() => onSelect(session.id)}
        >
          <span className="tab-title">{session.title}</span>
          {sessions.length > 1 && (
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(session.id);
              }}
              title="Cerrar"
            >
              <X size={12} />
            </button>
          )}
        </div>
      ))}
      <button className="tab-new" onClick={onNew} title="Nueva terminal">
        <Plus size={14} />
      </button>
    </div>
  );
}
