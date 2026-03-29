import { create } from 'zustand';
import type { Session } from '../types/session';

let nextId = 0;

function createSession(
  command: string | null = null,
  type: 'pty' | 'ai' = 'pty',
  httpSessionId: string | null = null,
  provider: string | null = null,
): Session {
  const id = ++nextId;
  let title: string;
  if (provider === 'gemini')                              title = `Gemini ${id}`;
  else if (provider === 'openai')                         title = `GPT ${id}`;
  else if (provider === 'anthropic' || type === ('claude' as any)) title = `Claude ${id}`;
  else if (command && command.startsWith('claude'))        title = `CC ${id}`;
  else title = command ? command.split(' ')[0] : `bash ${id}`;
  return { id, title, command, type, httpSessionId, provider };
}

interface SessionState {
  sessions: Session[];
  activeId: number;
  httpIdToTabId: Map<string, number>;

  openNew: (command?: string | null, type?: 'pty' | 'ai', httpSessionId?: string | null, provider?: string | null) => Session;
  closeSession: (id: number) => void;
  setActiveId: (id: number) => void;
  handleSessionId: (frontendTabId: number, httpId: string) => void;
  handleOpenSession: (httpSessionId: string) => number | null;
  addTelegramSession: (sessionId: string, from: string) => void;
}

const initialSession = createSession();

export const useSessionStore = create<SessionState>()((set, get) => ({
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
      set({ activeId: httpIdToTabId.get(sessionId)! });
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
