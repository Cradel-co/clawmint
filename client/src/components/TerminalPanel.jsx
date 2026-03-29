import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './TerminalPanel.css';

export default function TerminalPanel({ session, wsUrl, active, onSessionId }) {
  const containerRef = useRef(null);
  const xtermRef = useRef(null);
  const wsRef = useRef(null);
  const fitAddonRef = useRef(null);
  const sessionIdRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const manualCloseRef = useRef(false);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    // Leer colores del tema CSS
    const styles = getComputedStyle(document.documentElement);
    const v = (name) => styles.getPropertyValue(name).trim();

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", "Fira Code", "Courier New", monospace',
      theme: {
        background:          v('--bg-primary')   || '#0d1117',
        foreground:          v('--text-primary')  || '#e8edf2',
        cursor:              v('--accent-cyan')   || '#4fc3f7',
        cursorAccent:        v('--bg-primary')    || '#0d1117',
        selectionBackground: v('--bg-active')     || '#1a2d42',
        selectionForeground: v('--text-primary')  || '#e8edf2',
        black:               v('--bg-primary')    || '#0d1117',
        red:                 v('--accent-red')    || '#f87171',
        green:               v('--accent-green')  || '#4ade80',
        yellow:              v('--accent-yellow') || '#fbbf24',
        blue:                v('--accent-blue')   || '#5b8df0',
        magenta:             v('--accent-purple') || '#a78bfa',
        cyan:                v('--accent-cyan')   || '#4fc3f7',
        white:               v('--text-primary')  || '#e8edf2',
        brightBlack:         v('--text-muted')    || '#637282',
        brightRed:           '#ff6b6b',
        brightGreen:         '#5af78e',
        brightYellow:        '#f4f99d',
        brightBlue:          '#93c5fd',
        brightMagenta:       '#c4b5fd',
        brightCyan:          '#67e8f9',
        brightWhite:         '#ffffff',
      },
      scrollback: 1000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Diferir open() al siguiente frame para que el renderer se inicialice correctamente
    requestAnimationFrame(() => {
      if (containerRef.current && containerRef.current.offsetWidth > 0) {
        term.open(containerRef.current);
        fitAddon.fit();
      }
    });

    function connect() {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
        ws.send(JSON.stringify({
          type: 'init',
          sessionType: session.type || 'pty',
          command: session.command || null,
          systemPrompt: session.command || null, // para /ai con system prompt
          // Al reconectar usar sessionId guardado; primera vez usar httpSessionId si lo hay
          sessionId: sessionIdRef.current || session.httpSessionId || null,
          provider: session.provider || null,    // provider de IA seleccionado
          cols: term.cols,
          rows: term.rows,
        }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'session_id') {
          sessionIdRef.current = msg.id;
          if (onSessionId) onSessionId(msg.id);
        } else if (msg.type === 'output') {
          term.write(msg.data);
        } else if (msg.type === 'exit') {
          term.writeln('\r\n\x1b[33m[proceso terminado]\x1b[0m');
        }
      };

      ws.onclose = () => {
        if (manualCloseRef.current) return;
        const MAX_ATTEMPTS = 5;
        const attempt = reconnectAttemptsRef.current;
        if (attempt >= MAX_ATTEMPTS) {
          term.writeln('\r\n\x1b[31m[no se pudo reconectar — recargá la página]\x1b[0m');
          return;
        }
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s, 16s
        reconnectAttemptsRef.current = attempt + 1;
        term.writeln(`\r\n\x1b[33m[reconectando en ${delay / 1000}s...]\x1b[0m`);
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose se dispara automáticamente después de onerror
      };
    }

    connect();

    const onDataDisposable = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const doFit = () => {
      if (!containerRef.current?.offsetWidth || !containerRef.current?.offsetHeight) return;
      fitAddon.fit();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    // ResizeObserver para detectar cambios de tamaño del contenedor
    // (sidebar toggle, split mode, lazy mount, window resize)
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(doFit);
    });
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      manualCloseRef.current = true;
      clearTimeout(reconnectTimerRef.current);
      onDataDisposable.dispose();
      wsRef.current?.close();
      ro.disconnect();
      term.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cuando este panel se vuelve activo, abrir terminal si es necesario y re-ajustar el tamaño
  useEffect(() => {
    if (active && fitAddonRef.current && xtermRef.current) {
      const rafId = requestAnimationFrame(() => {
        if (!containerRef.current?.offsetWidth) return;
        if (!xtermRef.current.element) {
          xtermRef.current.open(containerRef.current);
        }
        fitAddonRef.current.fit();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'resize',
            cols: xtermRef.current.cols,
            rows: xtermRef.current.rows,
          }));
        }
        // Segundo fit después de que el layout se estabilice
        setTimeout(() => fitAddonRef.current?.fit(), 100);
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [active]);

  const sendText = () => {
    const text = inputValue.trim();
    if (!text) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: text + '\r' }));
      setInputValue('');
      inputRef.current?.focus();
    }
  };

  return (
    <div className="tp-container" aria-hidden={!active}>
      <div ref={containerRef} className="tp-xterm" />
      <div className="tp-input-bar">
        <input
          ref={inputRef}
          className="tp-input"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              sendText();
            }
          }}
          placeholder="Escribí un comando y presioná Enter..."
          aria-label="Entrada de comando de terminal"
          autoComplete="off"
          spellCheck={false}
        />
        <button className="tp-send-btn" onClick={sendText}>
          Enviar
        </button>
      </div>
    </div>
  );
}
