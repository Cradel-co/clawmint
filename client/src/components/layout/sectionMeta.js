import {
  LayoutDashboard, Terminal, MessageCircle, Send, BookUser, Settings, Plug, Bot, Volume2, Network, FileText, Mic, Bell,
  UserCircle, Brain, Gauge,
  // Fase B (admin)
  Shield, Zap, Activity, Users as UsersIcon, Cpu,
  // Fase C (features)
  CheckSquare, Clock, Archive, Monitor, Sparkles, Key,
  // Fase D (UX)
  Keyboard, ScrollText,
  // Fase E (advanced)
  Compass, Layers, Filter, Code2, GitBranch,
  // Roadmap integrations
  Link2, Home, Music,
} from 'lucide-react';

export const SECTION_META = {
  dashboard:    { Icon: LayoutDashboard, label: 'Dashboard'       },
  terminal:     { Icon: Terminal,        label: 'Terminal'        },
  chat:         { Icon: MessageCircle,   label: 'Chat IA'         },
  telegram:     { Icon: Send,            label: 'Telegram'        },
  contacts:     { Icon: BookUser,        label: 'Contactos'       },
  household:    { Icon: Bell,            label: 'Hogar'           },
  tasks:        { Icon: CheckSquare,     label: 'Tareas'          },
  scheduler:    { Icon: Clock,           label: 'Scheduler'       },
  skills:       { Icon: Sparkles,        label: 'Skills'          },
  integrations: { Icon: Plug,            label: 'Integraciones'   },
  devices:      { Icon: Cpu,             label: 'Dispositivos'    },
  music:        { Icon: Volume2,         label: 'Música'          },
  config:       { Icon: Settings,        label: 'Configuración'   },
};

/**
 * Grupos visibles en el sidebar. Cada grupo tiene un label en uppercase
 * (se muestra cuando el sidebar está expandido) y la lista de keys.
 *
 * Algunas keys son gated por feature flags — si el flag está apagado no se
 * renderizan. El Sidebar los filtra via SECTION_FLAGS.
 */
export const NAV_GROUPS = [
  { label: 'Overview',      keys: ['dashboard'] },
  { label: 'Control',       keys: ['terminal', 'chat'] },
  { label: 'Comms',         keys: ['telegram', 'contacts'] },
  { label: 'Familia',       keys: ['household'] },
  { label: 'Productividad', keys: ['tasks', 'scheduler', 'skills'] },
  { label: 'Servicios',     keys: ['integrations', 'devices', 'music'] },
  { label: 'Settings',      keys: ['config'] },
];

/**
 * Mapeo section key → feature flag que la activa. Si no está mapeada, siempre visible.
 */
export const SECTION_FLAGS = {
  tasks:        'TASKS_PANEL',
  scheduler:    'SCHEDULER_PANEL',
  skills:       'SKILLS_PANEL',
  integrations: 'INTEGRATIONS_PANEL',
  devices:      'DEVICES_PANEL',
  music:        'MUSIC_PANEL',
};

// Legacy export (sin grupos) — retenido por si algo externo lo usa.
export const NAV_TOP = ['dashboard', 'terminal', 'chat'];
export const NAV_MID = ['telegram', 'contacts'];

export const CONFIG_TABS = [
  { key: 'agents',      Icon: Bot,        label: 'Agentes'  },
  { key: 'providers',   Icon: Settings,   label: 'Providers' },
  { key: 'mcps',        Icon: Plug,       label: 'MCPs'     },
  { key: 'limits',      Icon: Gauge,      label: 'Límites'  },
  { key: 'voice',       Icon: Volume2,    label: 'TTS'      },
  { key: 'transcriber', Icon: Mic,        label: 'STT'      },
  { key: 'nodriza',     Icon: Network,    label: 'P2P'      },
  { key: 'reminders',   Icon: Bell,       label: 'Alarmas'  },
  { key: 'memory',      Icon: Brain,      label: 'Memoria'  },
  { key: 'logs',        Icon: FileText,   label: 'Logs'     },
  { key: 'profile',     Icon: UserCircle, label: 'Perfil'   },
];

/**
 * Tabs extras gated por feature flags. Se concatenan al final del menú
 * cuando la flag `VITE_FEATURE_<FLAG>=true` está activa.
 *
 * `group` agrupa visualmente (admin/features/ux/advanced) para que el menú
 * mantenga el orden de fases del roadmap aun con muchos tabs activos.
 *
 * `requiresAdmin` se respeta client-side para ocultar el tab a users normales
 * (server lo bloquea con 403 de todos modos).
 */
export const EXTRA_CONFIG_TABS = [
  // Fase B — Admin
  { key: 'permissions',   Icon: Shield,      label: 'Permisos',     flag: 'PERMISSIONS_PANEL',   group: 'admin', requiresAdmin: true },
  { key: 'hooks',         Icon: Zap,         label: 'Hooks',        flag: 'HOOKS_PANEL',         group: 'admin', requiresAdmin: true },
  { key: 'metrics',       Icon: Activity,    label: 'Métricas',     flag: 'METRICS_DASHBOARD',   group: 'admin', requiresAdmin: true },
  { key: 'users',         Icon: UsersIcon,   label: 'Usuarios',     flag: 'USERS_PANEL',         group: 'admin', requiresAdmin: true },
  { key: 'oauthCreds',    Icon: Key,         label: 'OAuth Creds',  flag: 'USERS_PANEL',         group: 'admin', requiresAdmin: true },
  { key: 'workspaces',    Icon: Cpu,         label: 'Workspaces',   flag: 'WORKSPACES_PANEL',    group: 'admin', requiresAdmin: true },
  // Fase C — Features que quedan en Config
  { key: 'typedMemory',   Icon: Archive,     label: 'Mem. tipada',  flag: 'TYPED_MEMORY_PANEL',  group: 'features' },
  { key: 'sessions',      Icon: Monitor,     label: 'Sesiones',     flag: 'SESSION_SHARING_UI',  group: 'features' },
  { key: 'mcpOAuth',      Icon: Key,         label: 'MCP OAuth',    flag: 'MCP_OAUTH_WIZARD',    group: 'features' },
  // NOTE: tasks/scheduler/skills/integrations/devices/music fueron elevados
  // a secciones de primer nivel en el sidebar — ya no aparecen acá.
  // Fase D — UX
  { key: 'keybindings',   Icon: Keyboard,    label: 'Shortcuts',    flag: 'KEYBINDINGS_PANEL',   group: 'ux' },
  { key: 'logsStream',    Icon: ScrollText,  label: 'Logs live',    flag: 'LOGS_STREAMING',      group: 'ux',       requiresAdmin: true },
  // Fase E — Advanced
  { key: 'compaction',    Icon: Compass,     label: 'Compaction',   flag: 'COMPACTION_PANEL',    group: 'advanced', requiresAdmin: true },
  { key: 'modelTiers',    Icon: Layers,      label: 'Model tiers',  flag: 'MODEL_TIERS_PANEL',   group: 'advanced', requiresAdmin: true },
  { key: 'toolsFilter',   Icon: Filter,      label: 'Tools',        flag: 'TOOLS_FILTER_PANEL',  group: 'advanced', requiresAdmin: true },
  { key: 'lsp',           Icon: Code2,       label: 'LSP',          flag: 'LSP_PANEL',           group: 'advanced', requiresAdmin: true },
  { key: 'orchestration', Icon: GitBranch,   label: 'Orchestration', flag: 'ORCHESTRATION_PANEL', group: 'advanced', requiresAdmin: true },
];
