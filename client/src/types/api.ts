export interface Provider {
  name: string;
  label: string;
  models: string[];
  defaultModel: string | null;
  configured: boolean;
  currentModel: string | null;
}

export interface ProvidersResponse {
  providers: Provider[];
  default: string;
}

export interface Agent {
  key: string;
  command?: string;
  description: string;
  prompt?: string;
  role?: string;
}

export interface Contact {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  telegram_user_id?: number;
  telegram_username?: string;
  notes?: string;
  created_at?: string;
  updated_at?: string;
}

export interface TelegramBot {
  key: string;
  label: string;
  username?: string;
  chats: TelegramChat[];
}

export interface TelegramChat {
  chatId: string | number;
  title?: string;
  type?: string;
  sessionId?: string;
}

export interface McpServer {
  name: string;
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface HealthResponse {
  ok: boolean;
  uptime: number;
  startedAt: string;
  pid: number;
  node: string;
}
