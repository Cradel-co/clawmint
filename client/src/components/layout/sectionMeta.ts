import { Terminal, MessageCircle, Send, BookUser, Settings, Plug, Bot, Volume2, Network, FileText, Mic, Bell, UserCircle, Brain } from 'lucide-react';

export const SECTION_META: Record<string, { Icon: typeof Terminal; label: string }> = {
  terminal: { Icon: Terminal,      label: 'Terminal'       },
  chat:     { Icon: MessageCircle, label: 'Chat IA'        },
  telegram: { Icon: Send,          label: 'Telegram'       },
  contacts: { Icon: BookUser,      label: 'Contactos'      },
  config:   { Icon: Settings,      label: 'Configuración'  },
};

export const NAV_TOP = ['terminal', 'chat'] as const;
export const NAV_MID = ['telegram', 'contacts'] as const;

export const CONFIG_TABS = [
  { key: 'agents',    Icon: Bot,      label: 'Agentes'  },
  { key: 'providers', Icon: Settings, label: 'Providers' },
  { key: 'mcps',      Icon: Plug,     label: 'MCPs'     },
  { key: 'voice',       Icon: Volume2,    label: 'TTS'      },
  { key: 'transcriber', Icon: Mic,        label: 'STT'      },
  { key: 'nodriza',     Icon: Network,    label: 'P2P'      },
  { key: 'reminders',   Icon: Bell,       label: 'Alarmas'  },
  { key: 'memory',      Icon: Brain,      label: 'Memoria'  },
  { key: 'logs',        Icon: FileText,   label: 'Logs'     },
  { key: 'profile',     Icon: UserCircle, label: 'Perfil'   },
] as const;
