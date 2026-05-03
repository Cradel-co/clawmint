import { useEffect, useRef, useState, useCallback } from 'react';
import { API_BASE } from '../config';

/**
 * useKeybindings — hook global de shortcuts del cliente.
 *
 * Los bindings por default están hardcoded. El user puede sobrescribir via el
 * KeybindingsPanel; overrides se persisten en `user_preferences` server-side
 * con key `keybindings`.
 *
 * Uso:
 *   useKeybindings(accessToken, {
 *     'openCommandPalette': () => openPalette(),
 *     'newSession':         () => newSession(),
 *     'toggleTheme':        () => toggleTheme(),
 *   });
 *
 * El hook engancha un único listener global de keydown, resuelve el binding
 * (default + override del user) y dispara la action registrada.
 */

export const DEFAULT_BINDINGS = {
  openCommandPalette: { combo: 'mod+k',    description: 'Abrir Command Palette' },
  newSession:         { combo: 'mod+n',    description: 'Nueva sesión' },
  toggleTheme:        { combo: 'mod+shift+t', description: 'Alternar tema light/dark' },
  focusSearch:        { combo: '/',        description: 'Focus en barra de búsqueda' },
  goTerminal:         { combo: 'mod+1',    description: 'Ir a Terminal' },
  goChat:             { combo: 'mod+2',    description: 'Ir a Chat' },
  goTelegram:         { combo: 'mod+3',    description: 'Ir a Telegram' },
  goContacts:         { combo: 'mod+4',    description: 'Ir a Contacts' },
  goConfig:           { combo: 'mod+,',    description: 'Ir a Config' },
};

export function useKeybindings(accessToken, actions = {}) {
  const [overrides, setOverrides] = useState({});
  const actionsRef = useRef(actions);
  useEffect(() => { actionsRef.current = actions; }, [actions]);

  // Cargar overrides persistidos
  useEffect(() => {
    if (!accessToken) return;
    fetch(`${API_BASE}/api/user-preferences/keybindings`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then(r => r.ok ? r.json() : null)
      .then(data => { if (data && data.value) setOverrides(data.value); })
      .catch(() => {});
  }, [accessToken]);

  // Listener global
  useEffect(() => {
    const handler = (e) => {
      const combo = eventToCombo(e);
      for (const [actionName, def] of Object.entries(DEFAULT_BINDINGS)) {
        const bound = overrides[actionName] || def.combo;
        if (matchesCombo(combo, bound)) {
          const action = actionsRef.current[actionName];
          if (action) {
            e.preventDefault();
            action(e);
          }
          return;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [overrides]);

  const saveOverride = useCallback(async (actionName, combo) => {
    const next = { ...overrides };
    if (combo === null || combo === undefined) delete next[actionName];
    else next[actionName] = combo;
    setOverrides(next);
    if (accessToken) {
      try {
        await fetch(`${API_BASE}/api/user-preferences/keybindings`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ value: next }),
        });
      } catch { /* silent */ }
    }
  }, [accessToken, overrides]);

  const resetAll = useCallback(async () => {
    setOverrides({});
    if (accessToken) {
      try {
        await fetch(`${API_BASE}/api/user-preferences/keybindings`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      } catch {}
    }
  }, [accessToken]);

  return { overrides, saveOverride, resetAll };
}

// ── combo parsing ──────────────────────────────────────────────────────────
function eventToCombo(e) {
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey)   parts.push('alt');
  const key = e.key.toLowerCase();
  // Ignorar teclas modifier solas
  if (['control', 'meta', 'shift', 'alt'].includes(key)) return '';
  parts.push(key);
  return parts.join('+');
}

export function matchesCombo(eventCombo, boundCombo) {
  if (!eventCombo || !boundCombo) return false;
  return eventCombo.toLowerCase() === boundCombo.toLowerCase();
}

export function formatCombo(combo) {
  if (!combo) return '';
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.platform);
  return combo.split('+').map(p => {
    const low = p.toLowerCase();
    if (low === 'mod')   return isMac ? '⌘' : 'Ctrl';
    if (low === 'shift') return isMac ? '⇧' : 'Shift';
    if (low === 'alt')   return isMac ? '⌥' : 'Alt';
    return p.length === 1 ? p.toUpperCase() : p;
  }).join(isMac ? '' : '+');
}

/** Captura el próximo keydown como string "mod+shift+k". Para el panel. */
export function recordNextKey() {
  return new Promise((resolve) => {
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = e.key.toLowerCase();
      if (['control', 'meta', 'shift', 'alt'].includes(key)) return; // aún no terminó el combo
      window.removeEventListener('keydown', handler, true);
      resolve(eventToCombo(e));
    };
    window.addEventListener('keydown', handler, true);
  });
}
