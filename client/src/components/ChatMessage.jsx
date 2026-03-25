import { memo, useState, useCallback } from 'react';
import { Check, Copy, Download, FileText, Image, Film, Volume2 } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { Highlight, themes } from 'prism-react-renderer';
import AudioPlayer from './AudioPlayer.jsx';

/** Schema de sanitización: permite HTML visual pero bloquea scripts/iframes */
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames || []),
    'style', 'mark', 'figure', 'figcaption', 'caption', 'colgroup', 'col',
    'abbr', 'address', 'cite', 'dfn', 'meter', 'progress', 'time', 'wbr',
  ],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes['*'] || []), 'style', 'className', 'class', 'id'],
    img: [...(defaultSchema.attributes.img || []), 'alt', 'width', 'height', 'loading'],
    td: ['colspan', 'rowspan', 'style'],
    th: ['colspan', 'rowspan', 'style'],
    col: ['span', 'style'],
    meter: ['value', 'min', 'max', 'low', 'high', 'optimum'],
    progress: ['value', 'max'],
    time: ['datetime'],
  },
};

/**
 * ChatMessage — renderiza un mensaje de chat con Markdown completo.
 *
 * Soporta: GFM, code blocks con syntax highlighting, media (foto, documento, audio, video),
 * botones inline, audio del usuario con transcripción.
 */
function ChatMessage({ content, role, streaming, error, providerLabel, buttons, onButtonClick, audioUrl, audioDuration, transcription, mediaType, mediaSrc, caption, filename, mimeType }) {
  // Mensaje de audio TTS
  if (role === 'tts' && audioUrl) {
    return (
      <div className="wc-msg wc-msg-tts">
        <div className="wc-msg-label">Audio TTS</div>
        <div className="wc-msg-content wc-audio-content">
          <audio controls src={audioUrl} className="wc-audio-player" />
        </div>
      </div>
    );
  }

  // Media: photo, document, voice, video
  if (mediaType && mediaSrc) {
    return (
      <div className={`wc-msg wc-msg-${role}`}>
        {role === 'assistant' && providerLabel && (
          <div className="wc-msg-label">{providerLabel}</div>
        )}
        <div className="wc-msg-content wc-media-content">
          {mediaType === 'photo' && (
            <img src={mediaSrc} alt={caption || filename || 'imagen'} className="wc-media-img" />
          )}
          {mediaType === 'video' && (
            <video controls src={mediaSrc} className="wc-media-video" />
          )}
          {mediaType === 'voice' && (
            <div className="wc-media-voice">
              <Volume2 size={14} className="wc-media-voice-icon" />
              <audio controls src={mediaSrc} className="wc-media-audio" />
            </div>
          )}
          {mediaType === 'document' && (
            <a href={mediaSrc} download={filename || 'archivo'} className="wc-media-doc">
              <FileText size={18} />
              <span className="wc-media-doc-name">{filename || 'archivo'}</span>
              <Download size={14} className="wc-media-doc-dl" />
            </a>
          )}
          {caption && <p className="wc-media-caption">{caption}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className={`wc-msg wc-msg-${role} ${error ? 'wc-msg-error' : ''}`}>
      {role === 'assistant' && providerLabel && (
        <div className="wc-msg-label">{providerLabel}</div>
      )}
      <div className="wc-msg-content">
        {audioUrl ? (
          <>
            <AudioPlayer src={audioUrl} knownDuration={audioDuration} />
            {transcription ? (
              <span className="wc-audio-transcription">{transcription}</span>
            ) : (
              <span className="wc-audio-transcribing">Transcribiendo...</span>
            )}
          </>
        ) : role === 'user' || role === 'system' ? (
          <span>{content}</span>
        ) : (
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
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

  // Bloque corto sin lenguaje: renderizar compacto (inline con botón copiar)
  const isSingleLine = !code.includes('\n');
  if (isSingleLine && !lang) {
    return (
      <div className="wc-code-inline-block">
        <code className="wc-code-inline-text">{code}</code>
        <button className="wc-code-inline-copy" onClick={handleCopy} title="Copiar">
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
    );
  }

  return (
    <div className="wc-code-block">
      <div className="wc-code-header">
        <span className="wc-code-lang">{lang || 'text'}</span>
        <button className="wc-code-copy" onClick={handleCopy}>
          {copied ? <Check size={12} /> : <><Copy size={12} /> Copiar</>}
        </button>
      </div>
      <Highlight theme={themes.oneDark} code={code} language={lang || 'text'}>
        {({ style, tokens, getLineProps, getTokenProps }) => (
          <pre style={{ ...style, margin: 0, borderRadius: '0 0 6px 6px', fontSize: '13px', padding: '12px', overflow: 'auto' }}>
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
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
