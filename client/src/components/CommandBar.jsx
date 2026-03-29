import { useState, useRef } from 'react';
import styles from './CommandBar.module.css';

export default function CommandBar({ onCommand, onClaude, onAI }) {
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

    if (raw === '/ai' || raw.startsWith('/ai ')) {
      const sys = raw.slice(3).trim();
      onClaude(sys || null);
      setValue('');
      return;
    }

    if (raw === '/gemini' || raw.startsWith('/gemini ')) {
      const sys = raw.slice(7).trim();
      if (onAI) onAI('gemini', sys || null);
      setValue('');
      return;
    }

    if (raw === '/openai' || raw.startsWith('/openai ')) {
      const sys = raw.slice(7).trim();
      if (onAI) onAI('openai', sys || null);
      setValue('');
      return;
    }

    if (raw === '/anthropic' || raw.startsWith('/anthropic ')) {
      const sys = raw.slice(10).trim();
      if (onAI) onAI('anthropic', sys || null);
      setValue('');
      return;
    }

    if (raw === '/grok' || raw.startsWith('/grok ')) {
      const sys = raw.slice(5).trim();
      if (onAI) onAI('grok', sys || null);
      setValue('');
      return;
    }

    if (raw === '/ollama' || raw.startsWith('/ollama ')) {
      const sys = raw.slice(7).trim();
      if (onAI) onAI('ollama', sys || null);
      setValue('');
      return;
    }

    if (raw === '/cc') {
      onCommand('claude --dangerously-skip-permissions');
      setValue('');
      return;
    }

    setError('Comandos: /new  /cmd <cmd>  /ai  /gemini  /openai  /grok  /ollama  /cc');
  };

  return (
    <form className={styles.bar} onSubmit={handleSubmit} role="search" aria-label="Barra de comandos">
      <label htmlFor="command-input" className={styles.prefix} aria-hidden="true">/</label>
      <input
        id="command-input"
        ref={inputRef}
        className={styles.input}
        value={value.startsWith('/') ? value.slice(1) : value}
        onChange={(e) => setValue('/' + e.target.value)}
        placeholder="new  |  cmd npm start  |  ai  |  gemini  |  openai  |  grok  |  ollama  |  cc"
        spellCheck={false}
        autoComplete="off"
        aria-label="Comando"
        aria-describedby={error ? 'command-error' : undefined}
      />
      <button type="submit" className={styles.submit}>Abrir</button>
      {error && <span id="command-error" className={styles.error} role="alert">{error}</span>}
    </form>
  );
}
