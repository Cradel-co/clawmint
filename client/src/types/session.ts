export interface Session {
  id: number;
  title: string;
  command: string | null;
  type: 'pty' | 'ai';
  httpSessionId: string | null;
  provider: string | null;
}
