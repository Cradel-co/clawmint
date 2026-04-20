import { useState } from 'react';
import styles from './ReasoningSummary.module.css';

/**
 * ReasoningSummary (Fase D.5) — bloque colapsable para thinking blocks
 * (Anthropic extended thinking). Colapsado por default; tecla expandir revela
 * el contenido con background sutil. Markdown rendering opcional.
 *
 * Props:
 *   content   — string del thinking/reasoning
 *   title     — header (default: "Razonamiento")
 *   defaultOpen — bool (default: false)
 *   wordCount — show word count in header (default: true)
 */
export default function ReasoningSummary({ content, title = 'Razonamiento', defaultOpen = false, wordCount = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const words = content ? content.trim().split(/\s+/).length : 0;

  return (
    <div className={styles.root} data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className={styles.caret} aria-hidden="true">▸</span>
        <span className={styles.icon} aria-hidden="true">🧠</span>
        <span className={styles.title}>{title}</span>
        {wordCount && content && (
          <span className={styles.meta}>{words} palabras</span>
        )}
      </button>
      {open && (
        <div className={styles.body}>
          <pre className={styles.content}>{content}</pre>
        </div>
      )}
    </div>
  );
}
