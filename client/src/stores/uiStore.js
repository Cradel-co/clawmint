import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useUIStore = create(
  persist(
    (set, get) => ({
      // Sección
      section: 'dashboard',
      mounted: { dashboard: true },
      /**
       * Cambia la sección activa.
       * @param {string} key — 'dashboard' | 'terminal' | 'chat' | ... | 'config'
       * @param {{ configTab?: string }} [opts] — opcional: si key==='config', tab a abrir.
       */
      setSection: (key, opts = {}) => {
        const { mounted } = get();
        set({
          section: key,
          mounted: mounted[key] ? mounted : { ...mounted, [key]: true },
          ...(opts.configTab ? { configTab: opts.configTab, configTabNonce: Date.now() } : {}),
          ...(key === 'chat' ? { chatBadge: 0 } : {}),
          ...(key === 'telegram' ? { telegramBadge: 0 } : {}),
        });
      },

      // Config tab deep-linking. Incrementa configTabNonce en cada nav para
      // disparar el useEffect en ConfigSection incluso si el tab es igual.
      configTab: 'agents',
      configTabNonce: 0,
      setConfigTab: (tab) => set({ configTab: tab, configTabNonce: Date.now() }),

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
      // Default false: no asumimos conexión hasta que el listenerWs confirme onopen.
      // Evita mostrar "Health OK" engañoso durante el bootstrap.
      wsConnected: false,
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
