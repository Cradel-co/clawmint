import { memo, useState, useCallback } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

/**
 * ChatMessage — renderiza un mensaje de chat con Markdown completo.
 *
 * Soporta: GFM (tablas, strikethrough, listas de tareas), code blocks
 * con syntax highlighting y botón de copiar, links, imágenes inline.
 */
function ChatMessage({ content, role, streaming, error, providerLabel, buttons, onButtonClick }) {
  return (
    <div className={`wc-msg wc-msg-${role} ${error ? 'wc-msg-error' : ''}`}>
      {role === 'assistant' && providerLabel && (
        <div className="wc-msg-label">{providerLabel}</div>
      )}
      <div className="wc-msg-content">
        {role === 'user' || role === 'system' ? (
          <span>{content}</span>
        ) : (
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              code: CodeBlock,
              a: ExternalLink,
            }}
          >
            {content}
          </Markdown>
        )}
        {streaming && <span className="wc-cursor">▊</span>}
      </div>
      {buttons && buttons.length > 0 && (
        <div className="wc-msg-buttons">
          {buttons.map((btn, i) => (
            <button
              key={i}
              className="wc-inline-btn"
              onClick={() => onButtonClick?.(btn)}
            >
              {btn.text || btn.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Code block con syntax highlighting y botón copiar */
function CodeBlock({ node, inline, className, children, ...props }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const lang = match ? match[1] : null;
  const code = String(children).replace(/\n$/, '');

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  if (inline) {
    return <code className="wc-inline-code" {...props}>{children}</code>;
  }

  return (
    <div className="wc-code-block">
      <div className="wc-code-header">
        <span className="wc-code-lang">{lang || 'text'}</span>
        <button className="wc-code-copy" onClick={handleCopy}>
          {copied ? '✓' : 'Copiar'}
        </button>
      </div>
      <SyntaxHighlighter
        style={oneDark}
        language={lang || 'text'}
        PreTag="div"
        customStyle={{ margin: 0, borderRadius: '0 0 6px 6px', fontSize: '13px' }}
        {...props}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

/** Links abren en nueva pestaña */
function ExternalLink({ href, children, ...props }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  );
}

export default memo(ChatMessage);
