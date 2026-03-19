import { useState, useRef } from 'react';
import './CommandBar.css';

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

    // /ai [system prompt opcional] → Anthropic API
    if (raw === '/ai' || raw.startsWith('/ai ')) {
      const sys = raw.slice(3).trim();
      onClaude(sys || null);
      setValue('');
      return;
    }

    // /gemini [system] → Gemini
    if (raw === '/gemini' || raw.startsWith('/gemini ')) {
      const sys = raw.slice(7).trim();
      if (onAI) onAI('gemini', sys || null);
      setValue('');
      return;
    }

    // /openai [system] → OpenAI
    if (raw === '/openai' || raw.startsWith('/openai ')) {
      const sys = raw.slice(7).trim();
      if (onAI) onAI('openai', sys || null);
      setValue('');
      return;
    }

    // /anthropic [system] → Anthropic API
    if (raw === '/anthropic' || raw.startsWith('/anthropic ')) {
      const sys = raw.slice(10).trim();
      if (onAI) onAI('anthropic', sys || null);
      setValue('');
      return;
    }

    // /grok [system] → Grok (xAI)
    if (raw === '/grok' || raw.startsWith('/grok ')) {
      const sys = raw.slice(5).trim();
      if (onAI) onAI('grok', sys || null);
      setValue('');
      return;
    }

    // /ollama [system] → Ollama (local)
    if (raw === '/ollama' || raw.startsWith('/ollama ')) {
      const sys = raw.slice(7).trim();
      if (onAI) onAI('ollama', sys || null);
      setValue('');
      return;
    }

    // /cc — Claude Code PTY interactivo
    if (raw === '/cc') {
      onCommand('claude --dangerously-skip-permissions');
      setValue('');
      return;
    }

    setError('Comandos: /new  /cmd <cmd>  /ai  /gemini  /openai  /grok  /ollama  /cc');
  };

  return (
    <form className="command-bar" onSubmit={handleSubmit}>
      <span className="command-prefix">/</span>
      <input
        ref={inputRef}
        className="command-input"
        value={value.startsWith('/') ? value.slice(1) : value}
        onChange={(e) => setValue('/' + e.target.value)}
        placeholder="new  |  cmd npm start  |  ai  |  gemini  |  openai  |  grok  |  ollama  |  cc"
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" className="command-submit">Abrir</button>
      {error && <span className="command-error">{error}</span>}
    </form>
  );
}
