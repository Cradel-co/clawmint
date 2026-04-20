/**
 * @clawmint/sdk — TypeScript type declarations.
 */

export interface ClawmintClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: any;
}

export interface Session {
  id: string;
  agentKey?: string;
  userId?: string;
  createdAt?: number;
  [k: string]: unknown;
}

export interface Agent {
  key: string;
  name: string;
  provider?: string;
  model?: string;
  [k: string]: unknown;
}

export interface MemoryEntry {
  id?: number;
  content: string;
  scope?: 'global' | 'user' | 'chat' | 'agent';
  scope_id?: string;
  [k: string]: unknown;
}

export interface SessionShare {
  token: string;
  session_id: string;
  owner_id: string;
  permissions: { read?: boolean; write?: boolean; allowedUserIds?: string[] };
  expires_at?: number | null;
}

export interface SessionSubscriber extends AsyncIterableIterator<unknown> {
  close(): void;
}

export interface ClawmintClient {
  sessions: {
    create(params: Partial<Session>): Promise<Session>;
    get(id: string): Promise<Session>;
    list(): Promise<Session[]>;
    remove(id: string): Promise<unknown>;
    sendMessage(id: string, msg: { text: string }): Promise<unknown>;
    subscribe(id: string): SessionSubscriber;
    share(id: string, opts?: { ttlHours?: number; permissions?: SessionShare['permissions'] }): Promise<SessionShare>;
    getShare(token: string): Promise<Partial<SessionShare>>;
    revokeShare(token: string): Promise<unknown>;
    listShares(): Promise<SessionShare[]>;
  };
  agents: {
    list(): Promise<Agent[]>;
    get(key: string): Promise<Agent>;
  };
  memory: {
    list(params?: Record<string, string | number>): Promise<MemoryEntry[]>;
    save(entry: MemoryEntry): Promise<MemoryEntry>;
  };
  preferences: {
    list(): Promise<Array<{ key: string; value: unknown; updated_at: number }>>;
    get(key: string): Promise<{ key: string; value: unknown }>;
    set(key: string, value: unknown): Promise<{ key: string; value: unknown }>;
    remove(key: string): Promise<unknown>;
  };
  raw: {
    request(method: string, path: string, body?: unknown): Promise<unknown>;
  };
}

export function createClawmintClient(options: ClawmintClientOptions): ClawmintClient;
