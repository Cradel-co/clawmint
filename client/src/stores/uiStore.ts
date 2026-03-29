import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type SectionKey = 'terminal' | 'chat' | 'telegram' | 'contacts' | 'config';

interface SplitChatState {
  cwd: string;
  provider: string;
}

interface UIState {
  // Sección activa y montaje lazy
  section: SectionKey;
  mounted: Record<string, boolean>;
  setSection: (key: SectionKey) => void;

  // Sidebar
  sidebarExpanded: boolean;
  toggleSidebar: () => void;

  // Split mode
  splitMode: boolean;
  splitRatio: number;
  splitChatState: SplitChatState;
  toggleSplit: () => void;
  setSplitMode: (v: boolean) => void;
  setSplitRatio: (ratio: number) => void;
  setSplitChatState: (update: Partial<SplitChatState>) => void;

  // Badges
  chatBadge: number;
  telegramBadge: number;
  incrementChatBadge: () => void;
  resetChatBadge: () => void;
  incrementTelegramBadge: () => void;
  resetTelegramBadge: () => void;

  // Conexión WS global
  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      // Sección
      section: 'terminal',
      mounted: { terminal: true },
      setSection: (key) => {
        const { mounted } = get();
        set({
          section: key,
          mounted: mounted[key] ? mounted : { ...mounted, [key]: true },
          ...(key === 'chat' ? { chatBadge: 0 } : {}),
          ...(key === 'telegram' ? { telegramBadge: 0 } : {}),
        });
      },

      // Sidebar
      sidebarExpanded: false,
      toggleSidebar: () => set((s) => ({ sidebarExpanded: !s.sidebarExpanded })),

      // Split mode
      splitMode: false,
      splitRatio: 55,
      splitChatState: { cwd: '~', provider: 'anthropic' },
      toggleSplit: () => set((s) => ({ splitMode: !s.splitMode })),
      setSplitMode: (v) => set({ splitMode: v }),
      setSplitRatio: (ratio) => set({ splitRatio: ratio }),
      setSplitChatState: (update) =>
        set((s) => ({ splitChatState: { ...s.splitChatState, ...update } })),

      // Badges
      chatBadge: 0,
      telegramBadge: 0,
      incrementChatBadge: () => set((s) => ({ chatBadge: s.chatBadge + 1 })),
      resetChatBadge: () => set({ chatBadge: 0 }),
      incrementTelegramBadge: () => set((s) => ({ telegramBadge: s.telegramBadge + 1 })),
      resetTelegramBadge: () => set({ telegramBadge: 0 }),

      // WS
      wsConnected: true,
      setWsConnected: (v) => set({ wsConnected: v }),
    }),
    {
      name: 'clawmint-ui',
      partialize: (state) => ({
        sidebarExpanded: state.sidebarExpanded,
        splitMode: state.splitMode,
        splitRatio: state.splitRatio,
      }),
    },
  ),
);
