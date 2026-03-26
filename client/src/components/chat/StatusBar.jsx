export default function StatusBar({ connected, providerLabel, agent, cwd, statusText }) {
  return (
    <div className="wc-status-bar">
      <span className={`wc-dot ${connected ? 'on' : 'off'}`} />
      <span>{providerLabel}</span>
      {agent && <span> &middot; {agent}</span>}
      <span className="wc-cwd"> &middot; {cwd}</span>
      {statusText && <span className="wc-status-text"> &middot; {statusText}</span>}
    </div>
  );
}
