'use strict';

/**
 * Cancellation — helpers para AbortSignal.
 *
 * `AbortController` / `AbortSignal` son nativos de Node 18+.
 * Se usan en LoopRunner para cancelar streams de providers cuando:
 *  - vence el timeout global
 *  - el caller cancela explícitamente (ej: usuario borra mensaje)
 *  - detectamos un loop infinito de tools
 */

/**
 * Linkea N signals: el controller interno se aborta si CUALQUIERA de los parent signals aborta.
 * Útil para combinar timeout + caller signal.
 * @param {...(AbortSignal|undefined)} signals
 * @returns {AbortController} controller cuyo signal está linkeado
 */
function linkSignals(...signals) {
  const controller = new AbortController();
  const onAbort = (reason) => {
    try { controller.abort(reason); } catch { /* ya abortado */ }
    cleanup();
  };
  const listeners = [];
  function cleanup() {
    for (const { sig, fn } of listeners) {
      try { sig.removeEventListener('abort', fn); } catch {}
    }
    listeners.length = 0;
  }

  for (const sig of signals) {
    if (!sig || typeof sig.addEventListener !== 'function') continue;
    if (sig.aborted) {
      onAbort(sig.reason);
      return controller;
    }
    const fn = () => onAbort(sig.reason);
    sig.addEventListener('abort', fn, { once: true });
    listeners.push({ sig, fn });
  }

  // Cleanup cuando el propio controller aborta (GC-friendly)
  controller.signal.addEventListener('abort', cleanup, { once: true });
  return controller;
}

/**
 * Crea un AbortController que se aborta automáticamente tras `ms` milisegundos.
 * Linkea también un parent signal si se provee.
 * @param {number} ms — timeout en ms; 0 o negativo = sin timeout
 * @param {AbortSignal} [parentSignal]
 * @returns {{ controller: AbortController, clear: () => void }}
 */
function withTimeout(ms, parentSignal) {
  const controller = linkSignals(parentSignal);
  let timer = null;
  if (ms && ms > 0) {
    timer = setTimeout(() => {
      try { controller.abort(new Error(`Timeout tras ${ms}ms`)); } catch {}
    }, ms);
    if (timer.unref) timer.unref();
  }
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  controller.signal.addEventListener('abort', clear, { once: true });
  return { controller, clear };
}

/**
 * Registra un callback que corre si/cuando el signal se aborta.
 * Si ya está abortado, invoca el callback de inmediato (async).
 * Retorna función de cleanup.
 */
function onAbort(signal, cb) {
  if (!signal) return () => {};
  if (signal.aborted) {
    queueMicrotask(() => { try { cb(signal.reason); } catch {} });
    return () => {};
  }
  const fn = () => { try { cb(signal.reason); } catch {} };
  signal.addEventListener('abort', fn, { once: true });
  return () => { try { signal.removeEventListener('abort', fn); } catch {} };
}

/** true si el signal (si existe) está abortado */
function isAborted(signal) {
  return !!(signal && signal.aborted);
}

module.exports = { linkSignals, withTimeout, onAbort, isAborted };
