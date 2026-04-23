import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import {
  TasksPanel,
  SchedulerPanel,
  TypedMemoryPanel,
  SessionsPanel,
  SkillsPanel,
  McpOAuthWizard,
} from '../components/features';

function mockFetch(routes) {
  global.fetch = vi.fn(async (url, opts) => {
    const method = (opts?.method || 'GET').toUpperCase();
    const path = url.replace(/^http:\/\/[^/]+/, '').split('?')[0];
    const key = `${method} ${path}`;
    const handler = routes[key] || routes['*'];
    if (!handler) return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const data = typeof handler === 'function' ? handler(opts) : handler;
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('TasksPanel', () => {
  test('renderiza lista + form', async () => {
    mockFetch({
      'GET /api/tasks': [{ id: 1, title: 'Mi tarea', status: 'pending', agent_key: 'claude', created_at: Date.now() - 1000 }],
    });
    render(<TasksPanel accessToken="TOK" chatId="c1" />);
    await waitFor(() => expect(screen.getByText('Mi tarea')).toBeInTheDocument());
    expect(screen.getByText('Nueva task')).toBeInTheDocument();
  });
});

describe('SchedulerPanel', () => {
  test('renderiza reminders tab', async () => {
    mockFetch({
      'GET /api/reminders': [{ id: 'r1', text: 'Comprar pan', chatId: 123, triggerAt: Date.now() + 60000 }],
    });
    render(<SchedulerPanel accessToken="TOK" />);
    expect(screen.getByText('Scheduler')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Comprar pan')).toBeInTheDocument());
  });
});

describe('TypedMemoryPanel', () => {
  test('renderiza lista + filtros', async () => {
    mockFetch({
      'GET /api/typed-memory': [
        { id: 1, scope_type: 'user', scope_id: 'u1', kind: 'feedback', name: 'pref-1', body_path: 'x.md', description: 'testing' },
      ],
    });
    render(<TypedMemoryPanel accessToken="TOK" />);
    expect(screen.getByText('Memorias tipadas')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('pref-1')).toBeInTheDocument());
    expect(screen.getByText('testing')).toBeInTheDocument();
  });
});

describe('SessionsPanel', () => {
  test('renderiza tab activas', async () => {
    mockFetch({
      'GET /api/sessions': [{ id: 's_abc123', type: 'pty', cwd: '/home/user', createdAt: Date.now() - 30000 }],
      'GET /api/session-share': [],
    });
    render(<SessionsPanel accessToken="TOK" />);
    await waitFor(() => expect(screen.getByText('s_abc123')).toBeInTheDocument());
  });
});

describe('SkillsPanel', () => {
  test('renderiza installed', async () => {
    mockFetch({
      'GET /api/skills': [{ slug: 'resumen', name: 'resumen', description: 'Resume la conversación', scope: 'global' }],
    });
    render(<SkillsPanel accessToken="TOK" />);
    await waitFor(() => expect(screen.getAllByText(/resumen/).length).toBeGreaterThan(0));
    expect(screen.getByText('Resume la conversación')).toBeInTheDocument();
  });
});

describe('McpOAuthWizard', () => {
  test('renderiza providers', async () => {
    mockFetch({
      'GET /api/mcp-auth/providers': ['google', 'github'],
    });
    render(<McpOAuthWizard accessToken="TOK" />);
    expect(screen.getByText('MCP OAuth')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('google')).toBeInTheDocument());
    expect(screen.getByText('github')).toBeInTheDocument();
  });
});
