import { useState, useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Brain, Search, X, ChevronLeft, Save, RefreshCw, LayoutGrid, Trash2 } from 'lucide-react';
import ForceGraph3D from '3d-force-graph';
import { useMemoryGraph, useMemoryFile, useSaveMemoryFile, useGlobalMemorySearch, useDeleteMemoryFile } from '../api/memory';
import styles from './MemoryGraphPanel.module.css';

// Wrapper imperativo sobre 3d-force-graph
function Graph3D({ graphData, highlightIds, onNodeClick, selectedNodeId, containerRef }) {
  const instanceRef = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (instanceRef.current) {
      instanceRef.current._destructor?.();
      el.innerHTML = '';
    }

    const inst = ForceGraph3D()(el)
      .backgroundColor('#0a0a0c')
      .cooldownTicks(120)
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.3)
      .enableNodeDrag(true)
      .nodeLabel(node => {
        const tags = node.tags?.length ? ` [${node.tags.join(', ')}]` : '';
        return `${node.title || node.filename}${tags}\n${node.agentKey}`;
      })
      .nodeColor(node => _nodeColor(node, selectedNodeId, highlightIds))
      .nodeVal(node => Math.max(1, Math.min(8, 1 + Math.log2((node.accessCount ?? 1) + 1))))
      .linkColor(link => {
        const w = link.weight ?? 0.5;
        return link.type === 'explicit'
          ? `rgba(249,115,22,${0.3 + w * 0.5})`
          : `rgba(251,191,36,${0.15 + w * 0.4})`;
      })
      .linkWidth(link => 0.5 + (link.weight ?? 0.5) * 2)
      .linkOpacity(0.5)
      .linkDirectionalParticles(graphData.nodes.length > 300 ? 0 : 2)
      .linkDirectionalParticleWidth(link => link.type === 'explicit' ? 1.5 : 0.8)
      .onNodeClick(node => {
        const distance = 120;
        const h = Math.hypot(node.x || 1, node.y || 1, node.z || 1);
        const r = 1 + distance / h;
        inst.cameraPosition(
          { x: node.x * r, y: node.y * r, z: node.z * r },
          node, 800
        );
        onNodeClick(node);
      })
      .graphData(graphData);

    // Aumentar separación entre nodos: carga negativa más fuerte + distancia de links mayor
    inst.d3Force('charge').strength(-180);
    inst.d3Force('link').distance(80);

    const ro = new ResizeObserver(() => {
      inst.width(el.clientWidth);
      inst.height(el.clientHeight);
    });
    ro.observe(el);

    instanceRef.current = inst;
    instanceRef.current._ro = ro;

    return () => {
      ro.disconnect();
      inst._destructor?.();
      if (containerRef.current) containerRef.current.innerHTML = '';
      instanceRef.current = null;
    };
  // Re-montar solo cuando cambian los datos del grafo
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData]);

  // Actualizar colores sin re-montar al cambiar selección / highlights
  useEffect(() => {
    instanceRef.current?.nodeColor(node => _nodeColor(node, selectedNodeId, highlightIds));
  }, [selectedNodeId, highlightIds]);

  return null;
}

function _nodeColor(node, selectedNodeId, highlightIds) {
  if (node.id === selectedNodeId) return '#ffffff';
  if (highlightIds?.size > 0) {
    return highlightIds.has(node.id) ? '#fbbf24' : 'rgba(100,60,20,0.35)';
  }
  const imp = (node.importance ?? 5) / 10;
  if (imp >= 0.8) return '#fbbf24';
  if (imp >= 0.5) return '#f97316';
  if (imp >= 0.2) return '#fb923c';
  return '#7c4a28';
}

export default function MemoryGraphPanel() {
  const [searchQuery, setSearchQuery]   = useState('');
  const [debouncedQ, setDebouncedQ]     = useState('');
  const [selectedNode, setSelectedNode] = useState(null);
  const [editContent, setEditContent]   = useState('');
  const [sidebarOpen, setSidebarOpen]   = useState(false);
  const [msg, setMsg]                   = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canvasRef = useRef();

  // Debounce de 400ms para la búsqueda
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(searchQuery.trim()), 400);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Grafo global completo
  const { data: graphRaw, isLoading, error, refetch } = useMemoryGraph(null);

  // Búsqueda global (solo cuando hay query)
  const { data: searchResults } = useGlobalMemorySearch(debouncedQ);

  // IDs que coinciden con la búsqueda → Set para lookup O(1)
  const highlightIds = debouncedQ && searchResults?.length
    ? new Set(searchResults.map(r => r.id))
    : null;

  // Leer archivo al seleccionar nodo
  const { data: fileData } = useMemoryFile(selectedNode?.agentKey, selectedNode?.filename);
  const saveFile   = useSaveMemoryFile();
  const deleteFile = useDeleteMemoryFile();
  const qc         = useQueryClient();

  useEffect(() => {
    if (fileData?.content !== undefined) setEditContent(fileData.content);
  }, [fileData?.content]);

  const graphData = graphRaw ?? { nodes: [], links: [] };

  const handleNodeClick = useCallback((node) => {
    setSelectedNode(node);
    setSidebarOpen(true);
    setEditContent('');
    setConfirmDelete(false);
    // Forzar fetch fresco del contenido para evitar cache de otro nodo
    qc.invalidateQueries({ queryKey: ['memory-file', node.agentKey, node.filename] });
  }, [qc]);

  const handleDelete = useCallback(async () => {
    if (!selectedNode) return;
    try {
      await deleteFile.mutateAsync({ agentKey: selectedNode.agentKey, filename: selectedNode.filename });
      refetch();
      setSidebarOpen(false);
      setSelectedNode(null);
      setConfirmDelete(false);
    } catch (err) {
      setMsg('Error: ' + err.message);
      setConfirmDelete(false);
    }
  }, [selectedNode, deleteFile, refetch]);

  const handleSave = useCallback(async () => {
    if (!selectedNode) return;
    try {
      await saveFile.mutateAsync({
        agentKey: selectedNode.agentKey,
        filename: selectedNode.filename,
        content: editContent,
      });
      setMsg('Guardado');
      setTimeout(() => setMsg(''), 2500);
    } catch (err) {
      setMsg('Error: ' + err.message);
    }
  }, [selectedNode, editContent, saveFile]);

  const showGraph = !isLoading && !error && graphData.nodes.length > 0;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Brain size={15} className={styles.headerIcon} />
        <span className={styles.title}>Knowledge Graph</span>

        <div className={styles.searchWrap}>
          <Search size={12} />
          <input
            className={styles.searchInput}
            placeholder="Buscar en todas las notas…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className={styles.clearBtn} onClick={() => setSearchQuery('')}>
              <X size={10} />
            </button>
          )}
        </div>

        {debouncedQ && searchResults && (
          <span className={styles.searchCount}>
            {highlightIds?.size ?? 0} resultado{highlightIds?.size !== 1 ? 's' : ''}
          </span>
        )}

        <div className={styles.headerRight}>
          <span className={styles.stats}>
            {graphData.nodes.length} nodos · {graphData.links.length} links
          </span>
          <button className={styles.refreshBtn} onClick={() => { setSearchQuery(''); refetch(); }} title="Cargar todo / Refrescar">
            <LayoutGrid size={13} />
          </button>
          <button className={styles.refreshBtn} onClick={() => refetch()} title="Refrescar">
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      <div className={styles.body}>
        <div className={styles.canvasWrap}>
          {isLoading && <div className={styles.loadingState}>Cargando grafo…</div>}
          {error && <div className={styles.errorState}>Error: {error.message}</div>}
          {!isLoading && !error && graphData.nodes.length === 0 && (
            <div className={styles.emptyState}>
              <Brain size={48} className={styles.emptyIcon} />
              <p>Sin notas en la base de datos</p>
            </div>
          )}

          <div
            ref={canvasRef}
            className={styles.canvas3d}
            style={{ display: showGraph ? 'block' : 'none' }}
          />

          {showGraph && (
            <Graph3D
              graphData={graphData}
              highlightIds={highlightIds}
              onNodeClick={handleNodeClick}
              selectedNodeId={selectedNode?.id}
              containerRef={canvasRef}
            />
          )}
        </div>

        <div className={`${styles.editorPanel} ${sidebarOpen ? styles.editorPanelOpen : ''}`}>
          {selectedNode && (
            <>
              <div className={styles.editorHeader}>
                <button
                  className={styles.backBtn}
                  onClick={() => { setSidebarOpen(false); setSelectedNode(null); }}
                >
                  <ChevronLeft size={14} />
                </button>
                <span className={styles.editorTitle}>{selectedNode.title || selectedNode.filename}</span>
                {msg && <span className={styles.saveMsg}>{msg}</span>}
                {confirmDelete ? (
                  <>
                    <button className={styles.deleteConfirmBtn} onClick={handleDelete} disabled={deleteFile.isPending}>
                      {deleteFile.isPending ? '…' : '¿Borrar?'}
                    </button>
                    <button className={styles.deleteCancelBtn} onClick={() => setConfirmDelete(false)}>
                      <X size={11} />
                    </button>
                  </>
                ) : (
                  <button className={styles.deleteBtn} onClick={() => setConfirmDelete(true)} title="Eliminar nota">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              <div className={styles.agentBadge}>{selectedNode.agentKey}</div>
              {selectedNode.tags?.length > 0 && (
                <div className={styles.tagRow}>
                  {selectedNode.tags.map(t => <span key={t} className={styles.tag}>{t}</span>)}
                </div>
              )}
              <div className={styles.metaRow}>
                <span>Importancia: {selectedNode.importance ?? 5}/10</span>
                <span>Accesos: {selectedNode.accessCount ?? 0}</span>
              </div>
              <textarea
                className={styles.editorTextarea}
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                placeholder="Cargando contenido…"
              />
              <div className={styles.editorActions}>
                <button
                  className={styles.saveBtn}
                  onClick={handleSave}
                  disabled={saveFile.isPending}
                >
                  <Save size={13} />
                  {saveFile.isPending ? 'Guardando…' : 'Guardar'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
