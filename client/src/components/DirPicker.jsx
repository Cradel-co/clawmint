import { useState, useEffect, useRef } from 'react';
import { Folder, X } from 'lucide-react';
import { API_BASE } from '../config';
import styles from './DirPicker.module.css';

const API = API_BASE;

export default function DirPicker({ value, onChange, onClose }) {
  const [currentPath, setCurrentPath] = useState(value || '');
  const [dirs, setDirs] = useState([]);
  const [parentPath, setParentPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [bookmarks, setBookmarks] = useState([]);
  const inputRef = useRef(null);

  // Cargar bookmarks al montar
  useEffect(() => {
    fetch(`${API}/api/fs/bookmarks`)
      .then(r => r.json())
      .then(setBookmarks)
      .catch(() => {});
  }, []);

  // Cargar directorios cuando cambia el path
  useEffect(() => {
    if (!currentPath) return;
    setLoading(true);
    setError('');
    fetch(`${API}/api/fs/ls?path=${encodeURIComponent(currentPath)}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          setError(data.error);
          setDirs([]);
        } else {
          setDirs(data.dirs);
          setParentPath(data.parent);
          setCurrentPath(data.path);
        }
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [currentPath]);

  // Focus al input al montar
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Cerrar con Escape + focus trap
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Tab') {
        const focusable = dialog.querySelectorAll('button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const navigate = (dir) => {
    setCurrentPath(currentPath.replace(/\/$/, '') + '/' + dir);
  };

  const goUp = () => {
    if (parentPath && parentPath !== currentPath) setCurrentPath(parentPath);
  };

  const select = () => {
    onChange(currentPath);
    onClose();
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div ref={dialogRef} className={styles.picker} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="dirpicker-title">
        <div className={styles.header}>
          <span id="dirpicker-title">Directorio de trabajo</span>
          <button className={styles.close} onClick={onClose} aria-label="Cerrar"><X size={14} /></button>
        </div>

        <div className={styles.pathRow}>
          <button className={styles.up} onClick={goUp} disabled={!parentPath || parentPath === currentPath} aria-label="Subir al directorio padre">
            ..
          </button>
          <input
            ref={inputRef}
            className={styles.input}
            value={currentPath}
            onChange={e => setCurrentPath(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') select(); }}
            spellCheck={false}
            aria-label="Ruta del directorio"
          />
        </div>

        {bookmarks.length > 0 && (
          <div className={styles.bookmarks}>
            {bookmarks.map(b => (
              <button key={b} className={styles.bookmark} onClick={() => setCurrentPath(b)}>
                {b.split('/').pop() || b}
              </button>
            ))}
          </div>
        )}

        <div className={styles.list}>
          {loading && <div className={styles.loading}>Cargando...</div>}
          {error && <div className={styles.error}>{error}</div>}
          {!loading && !error && dirs.length === 0 && (
            <div className={styles.empty}>Sin subdirectorios</div>
          )}
          {dirs.map(d => (
            <button key={d} className={styles.item} onClick={() => navigate(d)}>
              <span className={styles.folderIcon}><Folder size={14} /></span>
              {d}
            </button>
          ))}
        </div>

        <div className={styles.footer}>
          <button className={styles.selectBtn} onClick={select} aria-label="Seleccionar este directorio">
            Abrir aqui
          </button>
        </div>
      </div>
    </div>
  );
}
