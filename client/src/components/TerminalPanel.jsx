import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

export default function TerminalPanel({ session, wsUrl, active, onSessionId }) {
  const containerRef = useRef(null);
  const xtermRef = useRef(null);
  const wsRef = useRef(null);
  const fitAddonRef = useRef(null);
  const sessionIdRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const manualCloseRef = useRef(false);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", "Fira Code", "Courier New", monospace',
      theme: {
        background: '#1a1a1a',
        foreground: '#f0f0f0',
        cursor: '#f0f0f0',
        selectionBackground: '#555',
        black: '#1a1a1a',
        red: '#ff5f57',
        green: '#28c840',
        yellow: '#febc2e',
        blue: '#007aff',
        magenta: '#c678dd',
        cyan: '#56b6c2',
        white: '#f0f0f0',
        brightBlack: '#666',
        brightRed: '#ff6b6b',
        brightGreen: '#5af78e',
        brightYellow: '#f4f99d',
        brightBlue: '#caa9fa',
        brightMagenta: '#ff92d0',
        brightCyan: '#9aedfe',
        brightWhite: '#ffffff',
      },
      scrollback: 1000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Diferir open() al siguiente frame para que el renderer se inicialice correctamente
    let cancelled = false;
    requestAnimationFrame(() => {
      if (cancelled) return;
      if (containerRef.current && containerRef.current.offsetWidth > 0) {
        term.open(containerRef.current);
        fitAddon.fit();
        term.focus();
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

    const handleResize = () => {
      if (!active || !containerRef.current?.offsetWidth) return;
      fitAddon.fit();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      cancelled = true;
      window.removeEventListener('resize', handleResize);
      clearTimeout(reconnectTimerRef.current);
      manualCloseRef.current = true;
      wsRef.current?.close();
      onDataDisposable.dispose();
      term.dispose();
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cuando este panel se vuelve activo, abrir terminal si es necesario y re-ajustar el tamaño
  useEffect(() => {
    if (active && fitAddonRef.current && xtermRef.current) {
      // Esperar al siguiente frame para que el DOM se actualice antes de medir
      const rafId = requestAnimationFrame(() => {
        if (!containerRef.current?.offsetWidth) return;
        // Si el terminal no fue abierto aún (contenedor tenía display:none al montar), abrirlo ahora
        if (!xtermRef.current.element) {
          xtermRef.current.open(containerRef.current);
        }
        fitAddonRef.current.fit();
        xtermRef.current.focus();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'resize',
            cols: xtermRef.current.cols,
            rows: xtermRef.current.rows,
          }));
        }
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [active]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: active ? 'flex' : 'none',
        flexDirection: 'column',
      }}
    >
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}
      />
    </div>
  );
}
