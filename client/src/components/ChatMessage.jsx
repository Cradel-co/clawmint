import { memo, useState, useCallback } from 'react';
import { Check, Copy, Download, FileText, Image, Film, Volume2 } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { Highlight, themes } from 'prism-react-renderer';
import AudioPlayer from './AudioPlayer.jsx';
import styles from './WebChatPanel.module.css';

const ROLE_CLASS = { user: styles.msgUser, assistant: styles.msgAssistant, system: styles.msgSystem, tts: styles.msgTts };

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
      <div className={`${styles.msg} ${styles.msgTts}`}>
        <div className={styles.msgLabel}>Audio TTS</div>
        <div className={`${styles.msgContent} ${styles.audioContent}`}>
          <audio controls src={audioUrl} className={styles.audioPlayer} />
        </div>
      </div>
    );
  }

  // Media: photo, document, voice, video
  if (mediaType && mediaSrc) {
    return (
      <div className={`${styles.msg} ${ROLE_CLASS[role] || ''}`}>
        {role === 'assistant' && providerLabel && (
          <div className={styles.msgLabel}>{providerLabel}</div>
        )}
        <div className={`${styles.msgContent} ${styles.mediaContent}`}>
          {mediaType === 'photo' && (
            <img src={mediaSrc} alt={caption || filename || 'imagen'} className={styles.mediaImg} />
          )}
          {mediaType === 'video' && (
            <video controls src={mediaSrc} className={styles.mediaVideo} />
          )}
          {mediaType === 'voice' && (
            <div className={styles.mediaVoice}>
              <Volume2 size={14} className={styles.mediaVoiceIcon} />
              <audio controls src={mediaSrc} className={styles.mediaAudio} />
            </div>
          )}
          {mediaType === 'document' && (
            <a href={mediaSrc} download={filename || 'archivo'} className={styles.mediaDoc}>
              <FileText size={18} />
              <span className={styles.mediaDocName}>{filename || 'archivo'}</span>
              <Download size={14} className={styles.mediaDocDl} />
            </a>
          )}
          {caption && <p className={styles.mediaCaption}>{caption}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.msg} ${ROLE_CLASS[role] || ''} ${error ? styles.msgError : ''}`}>
      {role === 'assistant' && providerLabel && (
        <div className={styles.msgLabel}>{providerLabel}</div>
      )}
      <div className={styles.msgContent}>
        {audioUrl ? (
          <>
            <AudioPlayer src={audioUrl} knownDuration={audioDuration} />
            {transcription ? (
              <span className={styles.audioTranscription}>{transcription}</span>
            ) : (
              <span className={styles.audioTranscribing}>Transcribiendo...</span>
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
        {streaming && <span className={styles.cursor}>▊</span>}
      </div>
      {buttons && buttons.length > 0 && (
        <div className={styles.msgButtons}>
          {buttons.map((btn, i) => (
            <button
              key={i}
              className={styles.inlineBtn}
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
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 2000); };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).then(done);
    } else {
      // Fallback para HTTP (sin secure context)
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    }
  }, [code]);

  if (inline) {
    return <code className={styles.inlineCode} {...props}>{children}</code>;
  }

  // Bloque corto sin lenguaje: renderizar compacto (inline con botón copiar)
  const isSingleLine = !code.includes('\n');
  if (isSingleLine && !lang) {
    return (
      <div className={styles.codeInlineBlock}>
        <code className={styles.codeInlineText}>{code}</code>
        <button className={styles.codeInlineCopy} onClick={handleCopy} title="Copiar">
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHeader}>
        <span className={styles.codeLang}>{lang || 'text'}</span>
        <button className={styles.codeCopy} onClick={handleCopy}>
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
