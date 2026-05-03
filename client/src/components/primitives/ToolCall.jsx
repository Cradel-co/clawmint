import Collapsible from './Collapsible.jsx';
import styles from './ToolCall.module.css';

/**
 * <ToolCall> — render de una tool call del agente estilo OpenCode.
 *
 * Header: icon + name + args summary + status badge (spinner si running).
 * Body: full args (JSON) + output (text o <CodeBlock>).
 *
 * Props:
 *   name        — 'bash', 'read_file', 'edit_file', etc.
 *   args        — objeto con los argumentos (se JSON.stringify para preview)
 *   output      — string con la respuesta (opcional hasta que llegue)
 *   status      — 'pending' | 'running' | 'completed' | 'error'
 *   duration    — ms que tardó (opcional)
 *   defaultOpen — bool
 */
export default function ToolCall({
  name,
  args,
  output,
  status = 'completed',
  duration = null,
  defaultOpen = false,
}) {
  const argPreview = buildArgPreview(name, args);
  const statusLabel = status === 'running' ? 'ejecutando…'
                    : status === 'error'   ? 'error'
                    : status === 'pending' ? 'pendiente'
                    : duration != null ? `${formatDuration(duration)}` : '';

  return (
    <Collapsible
      defaultOpen={defaultOpen || status === 'error'}
      triggerClassName={styles.header}
      contentClassName={styles.body}
      trigger={
        <div className={styles.headerRow}>
          <ToolIcon name={name} status={status} />
          <span className={styles.name}>{name}</span>
          {argPreview && <span className={styles.argPreview} title={typeof args === 'object' ? JSON.stringify(args) : ''}>{argPreview}</span>}
          <span className={styles.spacer} />
          <span className={`${styles.status} ${styles['status_' + status]}`}>
            {status === 'running' && <span className={styles.spinner} aria-hidden="true" />}
            {statusLabel}
          </span>
          <span className={styles.caret} aria-hidden="true">▸</span>
        </div>
      }
    >
      <div className={styles.bodyInner}>
        {args && Object.keys(args).length > 0 && (
          <section className={styles.section}>
            <header className={styles.sectionHeader}>argumentos</header>
            <pre className={styles.pre}>{JSON.stringify(args, null, 2)}</pre>
          </section>
        )}
        {output !== undefined && output !== null && (
          <section className={styles.section}>
            <header className={styles.sectionHeader}>output</header>
            <pre className={`${styles.pre} ${status === 'error' ? styles.errorOutput : ''}`}>{String(output)}</pre>
          </section>
        )}
      </div>
    </Collapsible>
  );
}

function ToolIcon({ name, status }) {
  const emoji = iconForTool(name);
  return <span className={`${styles.icon} ${styles['icon_' + status]}`} aria-hidden="true">{emoji}</span>;
}

function iconForTool(name) {
  if (!name) return '●';
  if (name.startsWith('bash'))         return '$';
  if (name.startsWith('read_file'))    return '◎';
  if (name.startsWith('write_file'))   return '✎';
  if (name.startsWith('edit_file'))    return '✎';
  if (name.startsWith('list_dir'))     return '▦';
  if (name.startsWith('glob'))         return '⟫';
  if (name.startsWith('grep'))         return '⌕';
  if (name.startsWith('web'))          return '⟾';
  if (name.startsWith('memory'))       return '◈';
  if (name.startsWith('task'))         return '✓';
  if (name.startsWith('telegram'))     return '✈';
  if (name.startsWith('webchat'))      return '⌘';
  if (name.startsWith('pty'))          return '⌨';
  if (name.startsWith('git'))          return '⎇';
  if (name.startsWith('lsp'))          return '◇';
  if (name.startsWith('cron'))         return '⏱';
  if (name.startsWith('contact'))      return '☺';
  if (name.startsWith('delegate') || name.startsWith('ask_agent')) return '⚟';
  return '⚙';
}

function buildArgPreview(name, args) {
  if (!args || typeof args !== 'object') return '';
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  // Heurísticas por tool común para mejor preview
  if (args.path) return args.path;
  if (args.command) return String(args.command).slice(0, 60);
  if (args.pattern) return args.pattern;
  if (args.query) return args.query;
  if (args.url) return args.url;
  if (args.name) return args.name;
  // Default: primer arg
  const first = args[keys[0]];
  if (typeof first === 'string' || typeof first === 'number') return `${keys[0]}=${String(first).slice(0, 50)}`;
  return keys.join(', ');
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}
