import { useState, useEffect, useRef } from 'react';
import { Folder, X } from 'lucide-react';
import { API_BASE } from '../config.js';
import './DirPicker.css';

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
    <div className="dirpicker-overlay" onClick={onClose}>
      <div className="dirpicker" onClick={e => e.stopPropagation()}>
        <div className="dirpicker-header">
          <span>Directorio de trabajo</span>
          <button className="dirpicker-close" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="dirpicker-path-row">
          <button className="dirpicker-up" onClick={goUp} disabled={!parentPath || parentPath === currentPath} title="Subir">
            ..
          </button>
          <input
            ref={inputRef}
            className="dirpicker-input"
            value={currentPath}
            onChange={e => setCurrentPath(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') select(); }}
            spellCheck={false}
          />
        </div>

        {bookmarks.length > 0 && (
          <div className="dirpicker-bookmarks">
            {bookmarks.map(b => (
              <button key={b} className="dirpicker-bookmark" onClick={() => setCurrentPath(b)}>
                {b.split('/').pop() || b}
              </button>
            ))}
          </div>
        )}

        <div className="dirpicker-list">
          {loading && <div className="dirpicker-loading">Cargando...</div>}
          {error && <div className="dirpicker-error">{error}</div>}
          {!loading && !error && dirs.length === 0 && (
            <div className="dirpicker-empty">Sin subdirectorios</div>
          )}
          {dirs.map(d => (
            <div key={d} className="dirpicker-item" onClick={() => navigate(d)}>
              <span className="dirpicker-folder-icon"><Folder size={14} /></span>
              {d}
            </div>
          ))}
        </div>

        <div className="dirpicker-footer">
          <button className="dirpicker-select" onClick={select}>
            Abrir aqui
          </button>
        </div>
      </div>
    </div>
  );
}
