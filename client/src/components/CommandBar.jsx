import { useState, useRef } from 'react';
import './CommandBar.css';

export default function CommandBar({ onCommand, onClaude }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const handleSubmit = (e) => {
    e.preventDefault();
    const raw = value.trim();
    setError('');

    if (!raw.startsWith('/')) {
      setError('Los comandos deben comenzar con /');
      return;
    }

    if (raw === '/new') {
      onCommand(null);
      setValue('');
      return;
    }

    if (raw.startsWith('/cmd ')) {
      const cmd = raw.slice(5).trim();
      if (!cmd) { setError('Ej: /cmd npm run dev'); return; }
      onCommand(cmd);
      setValue('');
      return;
    }

    // /ai [system prompt opcional]
    if (raw === '/ai' || raw.startsWith('/ai ')) {
      const sys = raw.slice(3).trim();
      onClaude(sys || null);
      setValue('');
      return;
    }

    // /cc — Claude Code PTY interactivo
    if (raw === '/cc') {
      onCommand('claude --dangerously-skip-permissions');
      setValue('');
      return;
    }

    setError('Comandos: /new  /cmd <cmd>  /ai [system]  /cc');
  };

  return (
    <form className="command-bar" onSubmit={handleSubmit}>
      <span className="command-prefix">/</span>
      <input
        ref={inputRef}
        className="command-input"
        value={value.startsWith('/') ? value.slice(1) : value}
        onChange={(e) => setValue('/' + e.target.value)}
        placeholder="new  |  cmd npm start  |  ai [system]  |  cc"
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" className="command-submit">Abrir</button>
      {error && <span className="command-error">{error}</span>}
    </form>
  );
}
