import styles from './StatusBar.module.css';

/**
 * <StatusBar> — footer sticky con metadata de la sesión actual.
 *
 * Props (todos opcionales, renderiza solo lo que viene):
 *   model          — 'claude-opus-4-7', 'gpt-5', etc.
 *   provider       — 'anthropic', 'openai', etc.
 *   contextTokens  — tokens consumidos en la ventana actual
 *   contextLimit   — tokens máximos del modelo
 *   agent          — agentKey
 *   sessionId      — identificador corto
 *   status         — 'connected' | 'disconnected' | 'reconnecting' | 'error'
 *   latencyMs      — latencia del último turn en ms
 *   extra          — JSX adicional a la derecha (ej: botón custom)
 */
export default function StatusBar({
  model,
  provider,
  contextTokens,
  contextLimit,
  agent,
  sessionId,
  status = 'connected',
  latencyMs,
  extra,
}) {
  const ctxPct = contextTokens && contextLimit
    ? Math.min(100, Math.round((contextTokens / contextLimit) * 100))
    : null;

  return (
    <footer className={styles.root} data-status={status}>
      <span className={`${styles.dot} ${styles['dot_' + status]}`} aria-hidden="true" />

      {agent && <span className={styles.item}><span className={styles.label}>agent:</span> <span className={styles.value}>{agent}</span></span>}
      {provider && <span className={styles.item}><span className={styles.label}>prov:</span> <span className={styles.value}>{provider}</span></span>}
      {model && <span className={styles.item} title={model}><span className={styles.label}>model:</span> <span className={styles.value}>{truncateModel(model)}</span></span>}

      {ctxPct !== null && (
        <span className={styles.item} title={`${contextTokens} / ${contextLimit} tokens`}>
          <span className={styles.label}>ctx:</span>
          <span className={styles.value}>{ctxPct}%</span>
          <span className={styles.ctxBar} aria-hidden="true">
            <span className={styles.ctxFill} style={{ width: ctxPct + '%' }} data-level={ctxLevel(ctxPct)} />
          </span>
        </span>
      )}

      {latencyMs != null && (
        <span className={styles.item}>
          <span className={styles.label}>lat:</span> <span className={styles.value}>{formatLatency(latencyMs)}</span>
        </span>
      )}

      {sessionId && (
        <span className={styles.item} title={sessionId}>
          <span className={styles.label}>sid:</span> <span className={styles.value}>{String(sessionId).slice(0, 8)}</span>
        </span>
      )}

      <span className={styles.spacer} />
      {extra}
    </footer>
  );
}

function truncateModel(m) {
  // 'claude-opus-4-7' → 'opus-4.7', 'gpt-5-turbo' → 'gpt-5', etc.
  if (!m) return '';
  return m.replace(/^claude-/, '').replace(/-20\d{6}$/, '');
}

function ctxLevel(pct) {
  if (pct >= 90) return 'critical';
  if (pct >= 75) return 'warning';
  return 'ok';
}

function formatLatency(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
