import { Trash2, X, LogIn, LogOut, User, History } from 'lucide-react';
import styles from '../WebChatPanel.module.css';

export default function ChatHeader({
  providers, provider, setProvider, agentsList, agent, setAgent,
  authUser, onLogout, onShowAuth, onClear, onClose, onSettingsChange, onOpenHistory, embedded,
}) {
  return (
    <div className={styles.header}>
      <div className={styles.headerCenter}>
        <select
          className={styles.select}
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
          className={styles.select}
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
      </div>
      <div className={styles.headerRight}>
        <button className={styles.btnIcon} onClick={onOpenHistory} title="Historial de conversaciones" aria-label="Historial">
          <History size={14} />
        </button>
        {authUser ? (
          <button className={styles.userBadge} onClick={onLogout} title="Cerrar sesión">
            {authUser.avatar_url
              ? <img src={authUser.avatar_url} alt="" className={styles.userAvatar} />
              : <User size={12} />
            }
            {authUser.name || authUser.email}
            <LogOut size={10} />
          </button>
        ) : !embedded && (
          <button className={styles.loginBtn} onClick={onShowAuth} title="Iniciar sesión">
            <LogIn size={12} /> Login
          </button>
        )}
        <button className={styles.btnIcon} onClick={onClear} title="Nueva conversación" aria-label="Nueva conversación">
          <Trash2 size={14} />
        </button>
        {!embedded && (
          <button className={styles.close} onClick={onClose} aria-label="Cerrar panel de chat">
            <X size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
