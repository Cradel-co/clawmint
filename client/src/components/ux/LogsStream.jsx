import { useEffect, useRef, useState } from 'react';
import { WS_URL } from '../../config';
import styles from '../admin/AdminPanel.module.css';

const LEVELS = ['INFO', 'WARN', 'ERROR'];
const MAX_LINES = 2000; // buffer ring

/**
 * LogsStream (Fase D.4) — live streaming de logs del server via WS.
 *
 * Admin-only. Conecta al WS con `sessionType: 'logs'` y accessToken. Muestra
 * cada línea con filtros client-side por level + search highlight + autoscroll.
 */
export default function LogsStream({ accessToken }) {
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState('idle'); // idle|connecting|open|error
  const [error, setError] = useState(null);
  const [levelFilter, setLevelFilter] = useState(new Set(LEVELS));
  const [search, setSearch] = useState('');
  const [autoscroll, setAutoscroll] = useState(true);
  const wsRef = useRef(null);
  const scrollRef = useRef(null);

  // Conectar
  useEffect(() => {
    if (!accessToken) return;
    setStatus('connecting');
    setError(null);
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'init', sessionType: 'logs', token: accessToken }));
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (msg.type === 'logs_ready') setStatus('open');
      else if (msg.type === 'logs_error') { setStatus('error'); setError(msg.error); }
      else if (msg.type === 'log') {
        setLines(prev => {
          const next = [...prev, msg];
          if (next.length > MAX_LINES) next.splice(0, next.length - MAX_LINES);
          return next;
        });
      }
    });

    ws.addEventListener('close', () => { if (status !== 'error') setStatus('idle'); });
    ws.addEventListener('error', () => { setStatus('error'); setError('WebSocket error'); });

    return () => { try { ws.close(); } catch {} };
  }, [accessToken]);

  // Autoscroll
  useEffect(() => {
    if (autoscroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, autoscroll]);

  const toggleLevel = (lvl) => {
    const next = new Set(levelFilter);
    if (next.has(lvl)) next.delete(lvl); else next.add(lvl);
    setLevelFilter(next);
  };

  const filtered = lines.filter(l => {
    const lvl = (l.level || '').toUpperCase().trim();
    if (lvl && !levelFilter.has(lvl)) return false;
    if (search && !(l.raw || l.message || '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Logs (live stream)</h1>
          <p className={styles.subtitle}>
            Stream en vivo del Logger del server.
            {' '}
            <span className={`${styles.tag} ${statusTag(status)}`}>{status}</span>
          </p>
        </div>
        <div className={styles.actions}>
          <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={autoscroll} onChange={e => setAutoscroll(e.target.checked)} />
            autoscroll
          </label>
          <button className={styles.btn} onClick={() => setLines([])}>Clear</button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.card}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className={styles.input}
            placeholder="Filtrar por texto…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ maxWidth: 300 }}
          />
          <div style={{ display: 'flex', gap: 4 }}>
            {LEVELS.map(lvl => (
              <button
                key={lvl}
                className={`${styles.btn} ${levelFilter.has(lvl) ? levelBtnClass(lvl) : ''}`}
                onClick={() => toggleLevel(lvl)}
              >
                {lvl}
              </button>
            ))}
          </div>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--oc2-text-weak)' }}>
            {filtered.length} / {lines.length} líneas
          </span>
        </div>

        <div
          ref={scrollRef}
          onScroll={e => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
            if (!atBottom && autoscroll) setAutoscroll(false);
          }}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            lineHeight: 1.5,
            background: 'var(--oc2-surface-base, var(--bg-panel))',
            border: '1px solid var(--oc2-border-weaker, var(--border-subtle))',
            borderRadius: 6,
            padding: 8,
            height: '60vh',
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ opacity: 0.5, padding: 16, textAlign: 'center' }}>
              {status === 'connecting' ? 'Conectando…' : status === 'open' ? 'Esperando logs…' : 'Sin logs.'}
            </div>
          ) : filtered.map((l, i) => <LogLine key={i} line={l} search={search} />)}
        </div>
      </section>
    </div>
  );
}

function LogLine({ line, search }) {
  const lvl = (line.level || '').trim().toUpperCase();
  const color = lvl === 'ERROR' ? 'var(--oc2-error)' : lvl === 'WARN' ? 'var(--oc2-warning)' : 'var(--oc2-text-base)';
  const text = line.raw || `[${line.ts || '-'}] [${line.level || '-'}] ${line.message || ''}`;
  return (
    <div style={{ color, opacity: line.historical ? 0.6 : 1 }}>
      {search ? highlight(text, search) : text}
    </div>
  );
}

function highlight(text, query) {
  if (!query) return text;
  const ql = query.toLowerCase();
  const tl = text.toLowerCase();
  const out = [];
  let i = 0;
  while (i < text.length) {
    const hit = tl.indexOf(ql, i);
    if (hit < 0) { out.push(text.slice(i)); break; }
    if (hit > i) out.push(text.slice(i, hit));
    out.push(<mark key={hit} style={{ background: 'var(--oc2-warning)', color: '#000' }}>{text.slice(hit, hit + query.length)}</mark>);
    i = hit + query.length;
  }
  return out;
}

function statusTag(s) {
  if (s === 'open') return styles.tagSuccess;
  if (s === 'error') return styles.tagError;
  if (s === 'connecting') return styles.tagInfo;
  return '';
}

function levelBtnClass(lvl) {
  if (lvl === 'ERROR') return styles.btnDanger;
  return styles.btnPrimary;
}
