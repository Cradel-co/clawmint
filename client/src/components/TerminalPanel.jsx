import { useEffect, useRef, useState } from 'react';
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
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef(null);

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
    term.open(containerRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

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

    term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const handleResize = () => {
      if (!active) return;
      fitAddon.fit();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(reconnectTimerRef.current);
      manualCloseRef.current = true;
      wsRef.current?.close();
      term.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cuando este panel se vuelve activo, re-ajustar el tamaño
  useEffect(() => {
    if (active && fitAddonRef.current && xtermRef.current) {
      // Pequeño delay para que el DOM se actualice antes de medir
      const t = setTimeout(() => {
        fitAddonRef.current.fit();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'resize',
            cols: xtermRef.current.cols,
            rows: xtermRef.current.rows,
          }));
        }
      }, 50);
      return () => clearTimeout(t);
    }
  }, [active]);

  const sendText = () => {
    const text = inputValue.trim();
    if (!text) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: text + '\r' }));
      setInputValue('');
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        padding: 8,
        display: active ? 'flex' : 'none',
        flexDirection: 'column',
      }}
    >
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
      />
      <div
        style={{
          display: 'flex',
          gap: '6px',
          padding: '6px 8px',
          background: '#111',
          borderTop: '1px solid #333',
          flexShrink: 0,
        }}
      >
        <input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              sendText();
            }
          }}
          placeholder="Escribí un comando y presioná Enter..."
          autoComplete="off"
          spellCheck={false}
          style={{
            flex: 1,
            background: '#1e1e1e',
            color: '#f0f0f0',
            border: '1px solid #444',
            borderRadius: '4px',
            padding: '6px 10px',
            fontFamily: '"Cascadia Code", "Fira Code", "Courier New", monospace',
            fontSize: '13px',
            outline: 'none',
          }}
          onFocus={(e) => (e.target.style.borderColor = '#007aff')}
          onBlur={(e) => (e.target.style.borderColor = '#444')}
        />
        <button
          onClick={sendText}
          style={{
            padding: '6px 14px',
            background: '#007aff',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '13px',
            fontFamily: 'inherit',
          }}
        >
          Enviar
        </button>
      </div>
    </div>
  );
}
