import { useState, useEffect } from 'react';
import { Brain, X, ChevronLeft, Trash2, Search } from 'lucide-react';
import { useMemoryDebug, useMemoryFiles, useMemoryFile, useSaveMemoryFile, useDeleteMemoryFile } from '../api/memory';
import styles from './MemoryPanel.module.css';
import apStyles from './AgentsPanel.module.css';

export default function MemoryPanel({ onClose }) {
  const [agentKey, setAgentKey] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [msg, setMsg] = useState('');

  const { data: debug } = useMemoryDebug(agentKey);
  const { data: files } = useMemoryFiles(agentKey);
  const { data: fileData } = useMemoryFile(agentKey, selectedFile);
  const saveFile = useSaveMemoryFile();
  const deleteFile = useDeleteMemoryFile();

  // Cargar contenido cuando se selecciona archivo o cambia el fileData.
  useEffect(() => {
    if (selectedFile && fileData?.content !== undefined) {
      setEditContent(fileData.content);
    }
  }, [selectedFile, fileData?.content]);

  function openFile(filename) {
    setSelectedFile(filename);
    setEditContent('');
  }

  function backToList() {
    setSelectedFile(null);
    setEditContent('');
  }

  async function handleSave() {
    try {
      await saveFile.mutateAsync({ agentKey, filename: selectedFile, content: editContent });
      setMsg('Guardado');
    } catch (err) {
      setMsg('Error: ' + err.message);
    }
  }

  async function handleDelete(filename) {
    try {
      await deleteFile.mutateAsync({ agentKey, filename });
      if (selectedFile === filename) backToList();
      setMsg('Eliminado');
    } catch (err) {
      setMsg('Error: ' + err.message);
    }
  }

  const stats = debug?.stats;
  const fileList = Array.isArray(files) ? files : [];
  const filteredFiles = searchQ
    ? fileList.filter(f => (f.filename || f.title || '').toLowerCase().includes(searchQ.toLowerCase()))
    : fileList;

  return (
    <div className={apStyles.panel} role="region" aria-label="Panel de memoria">
      <div className={apStyles.header}>
        <span className={apStyles.title}><Brain size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />Memoria</span>
        {onClose && <button className={apStyles.close} onClick={onClose} aria-label="Cerrar"><X size={16} /></button>}
      </div>
      <div className={apStyles.body}>
        {msg && <div className={styles.msg}>{msg}</div>}

        <div className={styles.sectionTitle}>Agente</div>
        <input
          className={styles.select}
          type="text"
          placeholder="Clave del agente (ej: claude, pastor)"
          value={agentKey}
          onChange={e => { setAgentKey(e.target.value); setSelectedFile(null); }}
        />

        {agentKey && !selectedFile && (
          <>
            {stats && (
              <div className={styles.statsCard}>
                <div className={styles.stat}><span className={styles.statValue}>{stats.totalNotes || 0}</span><span className={styles.statLabel}>Notas</span></div>
                <div className={styles.stat}><span className={styles.statValue}>{stats.totalLinks || 0}</span><span className={styles.statLabel}>Links</span></div>
                <div className={styles.stat}><span className={styles.statValue}>{stats.uniqueTags || 0}</span><span className={styles.statLabel}>Tags</span></div>
              </div>
            )}

            <div className={styles.searchRow}>
              <Search size={14} style={{ color: 'var(--text-hint)', flexShrink: 0, marginTop: 6 }} />
              <input className={styles.searchInput} placeholder="Buscar notas..." value={searchQ} onChange={e => setSearchQ(e.target.value)} />
            </div>

            {filteredFiles.length === 0 ? (
              <div className={styles.empty}>{fileList.length === 0 ? 'Sin notas para este agente' : 'Sin resultados'}</div>
            ) : (
              filteredFiles.map(f => (
                <div key={f.filename || f} className={styles.noteCard} onClick={() => openFile(f.filename || f)}>
                  <div className={styles.noteTitle}>{f.title || f.filename || f}</div>
                  {f.tags && <div className={styles.noteMeta}><span>{f.tags.join(', ')}</span></div>}
                  {f.preview && <div className={styles.notePreview}>{f.preview}</div>}
                </div>
              ))
            )}
          </>
        )}

        {agentKey && selectedFile && (
          <div className={styles.editor}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button className={styles.backBtn} onClick={backToList}><ChevronLeft size={14} />Volver</button>
              <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{selectedFile}</span>
              <button className={styles.deleteBtn} onClick={() => handleDelete(selectedFile)}><Trash2 size={12} />Eliminar</button>
            </div>
            <textarea
              className={styles.editorTextarea}
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              placeholder="Contenido de la nota..."
            />
            <div className={styles.editorBtns}>
              <button className={`${apStyles.btn} ${apStyles.btnPrimary}`} onClick={handleSave} disabled={saveFile.isPending}>
                {saveFile.isPending ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
