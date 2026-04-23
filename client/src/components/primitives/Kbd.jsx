import styles from './Kbd.module.css';

/**
 * <Kbd> — chip para keyboard shortcut.
 *
 * Uso:
 *   <Kbd>Cmd+K</Kbd>
 *   <Kbd keys={['Ctrl', 'Shift', 'P']} />
 *
 * Auto-detecta Mac y convierte Cmd ↔ Ctrl.
 */
export default function Kbd({ children, keys }) {
  const list = keys || String(children || '').split('+').map(s => s.trim()).filter(Boolean);
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.platform);

  return (
    <span className={styles.group}>
      {list.map((k, i) => (
        <kbd key={i} className={styles.key}>{translate(k, isMac)}</kbd>
      ))}
    </span>
  );
}

function translate(key, isMac) {
  const lower = String(key).toLowerCase();
  if (isMac) {
    if (lower === 'ctrl' || lower === 'cmd' || lower === 'meta') return '⌘';
    if (lower === 'shift') return '⇧';
    if (lower === 'alt' || lower === 'option') return '⌥';
    if (lower === 'enter' || lower === 'return') return '↵';
    if (lower === 'escape' || lower === 'esc') return '⎋';
    if (lower === 'backspace') return '⌫';
    if (lower === 'tab') return '⇥';
    if (lower === 'up') return '↑';
    if (lower === 'down') return '↓';
    if (lower === 'left') return '←';
    if (lower === 'right') return '→';
  }
  return key.length === 1 ? key.toUpperCase() : key;
}
