import styles from './DiffViewer.module.css';

/**
 * <DiffViewer> — render de un diff tipo `edit_file` output.
 *
 * Soporta dos modos de input:
 *   1. `unified`  — string con formato git-diff unified (líneas con + y -).
 *   2. `before/after` — dos strings; computamos un diff básico línea por línea.
 *
 * Por simplicidad y sin deps, usamos un diff naive: si una línea existe antes
 * pero no después → `-`; si está después pero no antes → `+`. Para diffs
 * complejos (con reordenamientos), mejor pasar `unified`.
 *
 * Props:
 *   unified?      — string git-diff unified
 *   before, after — strings (alternativa)
 *   path?         — header con el path del archivo
 *   maxHeight?    — default '420px'
 */
export default function DiffViewer({ unified, before, after, path, maxHeight = '420px' }) {
  const lines = unified ? parseUnifiedDiff(unified) : simpleDiff(before || '', after || '');
  const added   = lines.filter(l => l.type === 'add').length;
  const removed = lines.filter(l => l.type === 'del').length;

  return (
    <div className={styles.root}>
      {(path || added || removed) && (
        <header className={styles.head}>
          {path && <span className={styles.path}>{path}</span>}
          <span className={styles.spacer} />
          <span className={styles.stats}>
            <span className={styles.added}>+{added}</span>
            <span className={styles.removed}>−{removed}</span>
          </span>
        </header>
      )}
      <div className={styles.body} style={{ maxHeight }}>
        <table className={styles.table}>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className={styles['row_' + l.type]}>
                <td className={styles.gutter}>{gutterChar(l.type)}</td>
                <td className={styles.lineNum}>{l.lineNo ?? ''}</td>
                <td className={styles.content}>{l.text || ' '}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function gutterChar(t) {
  switch (t) {
    case 'add': return '+';
    case 'del': return '−';
    case 'hunk': return '@';
    default: return ' ';
  }
}

/** Parser mínimo de unified diff (líneas +, -, @@, context). */
function parseUnifiedDiff(str) {
  const out = [];
  let lineNo = 0;
  for (const raw of (str || '').split('\n')) {
    if (raw.startsWith('@@')) {
      out.push({ type: 'hunk', text: raw });
      const m = raw.match(/\+(\d+)/);
      if (m) lineNo = Number(m[1]);
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue; // header
    if (raw.startsWith('+')) { out.push({ type: 'add', text: raw.slice(1), lineNo }); lineNo++; continue; }
    if (raw.startsWith('-')) { out.push({ type: 'del', text: raw.slice(1) }); continue; }
    out.push({ type: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw, lineNo });
    lineNo++;
  }
  return out;
}

/** Diff naive línea por línea para before/after simples. */
function simpleDiff(before, after) {
  const b = before.split('\n');
  const a = after.split('\n');
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const bLine = b[i];
    const aLine = a[i];
    if (bLine === aLine) {
      out.push({ type: 'ctx', text: bLine ?? '', lineNo: i + 1 });
    } else {
      if (bLine !== undefined) out.push({ type: 'del', text: bLine });
      if (aLine !== undefined) out.push({ type: 'add', text: aLine, lineNo: i + 1 });
    }
  }
  return out;
}
