import { useEffect, useRef, useState } from 'react';
import styles from './CodeBlock.module.css';

/**
 * <CodeBlock> — render de code blocks con syntax highlight opcional.
 *
 * Por default usa estilos OC-2 sin highlighting (monospace sobre surface).
 * Cuando Shiki esté disponible (opcional, lazy-import en Fase A.2 final),
 * highlighteará tokens usando las CSS vars --oc2-syntax-*.
 *
 * Props:
 *   code           — string con el código
 *   lang           — lenguaje ('js', 'ts', 'bash', 'json', 'diff', 'markdown', etc.)
 *   showLineNumbers — bool
 *   maxHeight      — CSS value (default '420px')
 *   copyable       — bool, default true
 */
export default function CodeBlock({
  code,
  lang = 'text',
  showLineNumbers = false,
  maxHeight = '420px',
  copyable = true,
}) {
  const [highlighted, setHighlighted] = useState(null); // HTML when ready, null = plain
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  // Lazy-load Shiki si el cliente la tiene instalada. Si no, degrade a plain.
  // @vite-ignore → evita que Vite falle en static analysis si shiki no está
  // instalada. Se instala como dep opcional en Fase A final.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const modName = 'shiki';
        const mod = await import(/* @vite-ignore */ modName).catch(() => null);
        if (!mod || !mod.codeToHtml) return;
        const html = await mod.codeToHtml(code || '', {
          lang: normalizeLang(lang),
          theme: isDark() ? 'github-dark-default' : 'github-light-default',
          transformers: [{
            pre(node) { node.properties.class = styles.shikiPre; },
            code(node) { node.properties.class = styles.shikiCode; },
          }],
        });
        if (!cancelled && mountedRef.current) setHighlighted(html);
      } catch {
        // sin shiki → plain
      }
    })();
    return () => { cancelled = true; };
  }, [code, lang]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const lines = (code || '').split('\n');

  return (
    <div className={styles.root} data-lang={lang}>
      <header className={styles.head}>
        <span className={styles.lang}>{lang}</span>
        {copyable && (
          <button type="button" className={styles.copyBtn} onClick={copy} aria-label="Copiar">
            {copied ? '✓ copiado' : 'copiar'}
          </button>
        )}
      </header>
      <div className={styles.body} style={{ maxHeight }}>
        {highlighted ? (
          <div className={styles.shikiWrap} dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <pre className={styles.pre}>
            {showLineNumbers ? (
              <table className={styles.lnTable}>
                <tbody>
                  {lines.map((line, i) => (
                    <tr key={i}>
                      <td className={styles.lnCell}>{i + 1}</td>
                      <td className={styles.lnContent}>{line || ' '}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <code>{code}</code>
            )}
          </pre>
        )}
      </div>
    </div>
  );
}

function normalizeLang(l) {
  if (!l) return 'text';
  const map = { sh: 'bash', js: 'javascript', ts: 'typescript', py: 'python', md: 'markdown' };
  return map[l] || l;
}

function isDark() {
  return document.documentElement.getAttribute('data-theme') !== 'light';
}
