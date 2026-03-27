import { Trash2, X, LogIn, LogOut, User } from 'lucide-react';

export default function ChatHeader({
  providers, provider, setProvider, agentsList, agent, setAgent,
  authUser, onLogout, onShowAuth, onClear, onClose, onSettingsChange,
}) {
  return (
    <div className="wc-header">
      <span className="wc-header-title">Chat</span>
      <div className="wc-header-controls">
        <select
          className="wc-select"
          value={provider}
          aria-label="Proveedor"
          onChange={e => {
            const val = e.target.value;
            setProvider(val);
            onSettingsChange?.({ provider: val });
          }}
        >
          {providers.filter(p => p.configured).map(p => (
            <option key={p.name} value={p.name}>{p.label || p.name}</option>
          ))}
        </select>
        <select
          className="wc-select"
          value={agent || ''}
          aria-label="Agente"
          onChange={e => {
            const val = e.target.value || null;
            setAgent(val);
            onSettingsChange?.({ agent: val });
          }}
        >
          <option value="">Sin agente</option>
          {agentsList.map(a => (
            <option key={a.key} value={a.key}>{a.key}</option>
          ))}
        </select>
        {authUser ? (
          <button className="wc-user-badge" onClick={onLogout} title="Cerrar sesión">
            {authUser.avatar_url
              ? <img src={authUser.avatar_url} alt="" className="wc-user-avatar" />
              : <User size={12} />
            }
            {authUser.name || authUser.email}
            <LogOut size={10} />
          </button>
        ) : (
          <button className="wc-login-btn" onClick={onShowAuth} title="Iniciar sesión">
            <LogIn size={12} /> Login
          </button>
        )}
        <button className="wc-btn-icon" onClick={onClear} title="Nueva conversación" aria-label="Nueva conversación"><Trash2 size={14} /></button>
        <button className="wc-close" onClick={onClose} aria-label="Cerrar panel de chat"><X size={16} /></button>
      </div>
    </div>
  );
}
