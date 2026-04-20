import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './CommandPalette.module.css';

/**
 * CommandPalette (Fase D.1) — overlay global con fuzzy search.
 *
 * Se abre con Cmd+K / Ctrl+K y se controla con teclado:
 *   ↑/↓ — navegar
 *   Enter — ejecutar
 *   Escape — cerrar
 *
 * Comandos inyectados por el caller (App.jsx) con shape:
 *   { id, title, hint?, group?, icon?, keywords?, action: () => void }
 *
 * Sin deps externas — fuzzy match propio por subsecuencia + score.
 */
export default function CommandPalette({ commands = [], open, onOpenChange }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const results = useMemo(() => filterAndScore(commands, q), [commands, q]);

  useEffect(() => { setIdx(0); }, [q]);

  const close = () => onOpenChange(false);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(results.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = results[idx];
      if (item) { close(); Promise.resolve().then(() => item.action && item.action()); }
      return;
    }
  };

  if (!open) return null;

  return (
    <div className={styles.overlay} onClick={close}>
      <div className={styles.palette} onClick={e => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className={styles.inputWrap}>
          <span className={styles.kbd}>⌘K</span>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            placeholder="Buscar comando, panel, sesión…"
            value={q}
            onChange={e => setQ(e.target.value)}
          />
          <span className={styles.count}>{results.length}</span>
        </div>
        <ul className={styles.list} role="listbox">
          {results.length === 0 ? (
            <li className={styles.empty}>Sin resultados.</li>
          ) : results.map((cmd, i) => (
            <li
              key={cmd.id}
              role="option"
              aria-selected={i === idx}
              className={`${styles.item} ${i === idx ? styles.itemActive : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => { close(); Promise.resolve().then(() => cmd.action && cmd.action()); }}
            >
              {cmd.icon && <span className={styles.itemIcon} aria-hidden="true">{cmd.icon}</span>}
              <span className={styles.itemBody}>
                <span className={styles.itemTitle}>{highlightMatch(cmd.title, q)}</span>
                {cmd.hint && <span className={styles.itemHint}>{cmd.hint}</span>}
              </span>
              {cmd.group && <span className={styles.itemGroup}>{cmd.group}</span>}
            </li>
          ))}
        </ul>
        <footer className={styles.footer}>
          <span><kbd>↑</kbd><kbd>↓</kbd> navegar</span>
          <span><kbd>↵</kbd> ejecutar</span>
          <span><kbd>Esc</kbd> cerrar</span>
        </footer>
      </div>
    </div>
  );
}

// ── Hook de teclado global para abrir con Cmd+K ─────────────────────────────
export function useCommandPaletteShortcut(onOpen) {
  useEffect(() => {
    const h = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onOpen]);
}

// ── Fuzzy subsequence match + scoring ───────────────────────────────────────
function fuzzyScore(haystack, needle) {
  if (!needle) return { score: 0, match: false };
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let i = 0, j = 0, score = 0, last = -2, conseq = 0;
  while (i < h.length && j < n.length) {
    if (h[i] === n[j]) {
      if (i === last + 1) { conseq++; score += 3 + conseq; }
      else { score += 1; conseq = 0; }
      if (i === 0 || h[i - 1] === ' ' || h[i - 1] === '-' || h[i - 1] === '/' || h[i - 1] === '.') score += 2; // start-of-word bonus
      last = i;
      j++;
    }
    i++;
  }
  return { score, match: j === n.length };
}

function filterAndScore(commands, q) {
  if (!q || !q.trim()) return commands.slice(0, 20);
  const term = q.trim();
  return commands
    .map(cmd => {
      const hay = [cmd.title, cmd.hint || '', cmd.group || '', ...(cmd.keywords || [])].join(' ');
      const { score, match } = fuzzyScore(hay, term);
      return { cmd, score, match };
    })
    .filter(r => r.match)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50)
    .map(r => r.cmd);
}

function highlightMatch(text, q) {
  if (!q) return text;
  const n = q.toLowerCase();
  const lower = text.toLowerCase();
  const out = [];
  let j = 0;
  for (let i = 0; i < text.length; i++) {
    if (j < n.length && lower[i] === n[j]) {
      out.push(<mark key={i} className={styles.mark}>{text[i]}</mark>);
      j++;
    } else {
      out.push(text[i]);
    }
  }
  return out;
}
