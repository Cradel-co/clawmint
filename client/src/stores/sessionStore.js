import { create } from 'zustand';

let nextId = 0;

function createSession(command = null, type = 'pty', httpSessionId = null, provider = null) {
  const id = ++nextId;
  let title;
  if (provider === 'gemini')                              title = `Gemini ${id}`;
  else if (provider === 'openai')                         title = `GPT ${id}`;
  else if (provider === 'anthropic' || type === 'claude') title = `Claude ${id}`;
  else if (command && command.startsWith('claude'))        title = `CC ${id}`;
  else title = command ? command.split(' ')[0] : `bash ${id}`;
  return { id, title, command, type, httpSessionId, provider };
}

const initialSession = createSession();

export const useSessionStore = create((set, get) => ({
  sessions: [initialSession],
  activeId: initialSession.id,
  httpIdToTabId: new Map(),

  openNew: (command = null, type = 'pty', httpSessionId = null, provider = null) => {
    const s = createSession(command, type, httpSessionId, provider);
    set((state) => ({
      sessions: [...state.sessions, s],
      activeId: s.id,
    }));
    return s;
  },

  closeSession: (id) => {
    set((state) => {
      const next = state.sessions.filter((s) => s.id !== id);
      const map = state.httpIdToTabId;
      for (const [httpId, tabId] of map) {
        if (tabId === id) { map.delete(httpId); break; }
      }
      if (next.length === 0) {
        const s = createSession();
        return { sessions: [s], activeId: s.id, httpIdToTabId: map };
      }
      const newActiveId = state.activeId === id ? next[next.length - 1].id : state.activeId;
      return { sessions: next, activeId: newActiveId, httpIdToTabId: map };
    });
  },

  setActiveId: (id) => set({ activeId: id }),

  handleSessionId: (frontendTabId, httpId) => {
    get().httpIdToTabId.set(httpId, frontendTabId);
  },

  handleOpenSession: (httpSessionId) => {
    const { httpIdToTabId, openNew } = get();
    const tabId = httpIdToTabId.get(httpSessionId);
    if (tabId) {
      set({ activeId: tabId });
      return tabId;
    }
    const s = openNew(null, 'pty', httpSessionId);
    return s.id;
  },

  addTelegramSession: (sessionId, from) => {
    const { httpIdToTabId } = get();
    if (httpIdToTabId.has(sessionId)) {
      set({ activeId: httpIdToTabId.get(sessionId) });
      return;
    }
    const s = createSession(null, 'pty', sessionId);
    s.title = `TG: ${from}`;
    set((state) => ({
      sessions: [...state.sessions, s],
      activeId: s.id,
    }));
  },
}));
