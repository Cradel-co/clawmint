import { useState, useRef, useEffect } from 'react';
import styles from './Collapsible.module.css';

/**
 * <Collapsible> — primitive con animación smooth de height.
 *
 * Props:
 *   trigger       — JSX clickable que togglea (render completo, se le agrega onClick)
 *   children      — contenido revelable
 *   defaultOpen   — bool, default false
 *   open          — controlado (opcional); si viene, el componente es controlado
 *   onOpenChange  — callback cuando cambia (controlado)
 *   triggerClassName, contentClassName — custom classes
 */
export default function Collapsible({
  trigger,
  children,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  triggerClassName = '',
  contentClassName = '',
}) {
  const [openState, setOpenState] = useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : openState;
  const contentRef = useRef(null);

  const toggle = () => {
    const next = !open;
    if (!isControlled) setOpenState(next);
    if (onOpenChange) onOpenChange(next);
  };

  // Anim: medir contenido y setear max-height para transición
  useEffect(() => {
    if (!contentRef.current) return;
    const el = contentRef.current;
    if (open) {
      const h = el.scrollHeight;
      el.style.maxHeight = h + 'px';
      // Después de la transición, dejar free para contenido dinámico
      const t = setTimeout(() => { if (open && el) el.style.maxHeight = 'none'; }, 350);
      return () => clearTimeout(t);
    } else {
      // Primero seteo al height actual para animar from there, después a 0
      el.style.maxHeight = el.scrollHeight + 'px';
      // Forzar reflow antes de setear 0
      void el.offsetHeight;
      el.style.maxHeight = '0px';
    }
  }, [open]);

  return (
    <div className={styles.root} data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        onClick={toggle}
        className={`${styles.trigger} ${triggerClassName}`.trim()}
        aria-expanded={open}
      >
        {trigger}
      </button>
      <div ref={contentRef} className={`${styles.content} ${contentClassName}`.trim()}>
        {children}
      </div>
    </div>
  );
}
