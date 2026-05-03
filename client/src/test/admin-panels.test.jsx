import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import {
  PermissionsPanel,
  HooksPanel,
  MetricsDashboard,
  UsersPanel,
  WorkspacesPanel,
} from '../components/admin';

/**
 * Smoke tests para los 5 paneles admin-only. No montan backend real; usamos
 * fetch mocks que retornan fixtures esperables. Verifican que los paneles
 * renderizan sin crash y muestran los fixtures mínimos.
 */

function mockFetch(routes) {
  global.fetch = vi.fn(async (url, opts) => {
    const method = (opts?.method || 'GET').toUpperCase();
    const key = `${method} ${url.replace(/^http:\/\/[^/]+/, '')}`;
    const handler = routes[key] || routes['*'];
    if (!handler) {
      return new Response(JSON.stringify({ error: `no mock para ${key}` }), { status: 404 });
    }
    const data = typeof handler === 'function' ? handler(opts) : handler;
    return new Response(JSON.stringify(data), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

describe('PermissionsPanel', () => {
  test('renderiza lista y form', async () => {
    mockFetch({
      'GET /api/permissions': [{ id: 1, scope_type: 'chat', scope_id: 'c1', tool_pattern: 'bash', action: 'deny', reason: 'test' }],
      'GET /api/permissions/status': { enabled: true },
    });
    render(<PermissionsPanel accessToken="TOK" />);
    expect(screen.getByText('Permisos (RBAC)')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('bash')).toBeInTheDocument());
    // "deny" aparece en el <select> y como tag de la regla — usar getAllByText
    expect(screen.getAllByText('deny').length).toBeGreaterThan(0);
    expect(screen.getByText('Crear regla')).toBeInTheDocument();
  });

  test('muestra tag "activo" cuando status.enabled=true', async () => {
    mockFetch({
      'GET /api/permissions': [],
      'GET /api/permissions/status': { enabled: true },
    });
    render(<PermissionsPanel accessToken="TOK" />);
    await waitFor(() => expect(screen.getByText('activo')).toBeInTheDocument());
  });
});

describe('HooksPanel', () => {
  test('renderiza lista y form', async () => {
    mockFetch({
      'GET /api/hooks': [{ id: 'h1', event: 'pre_tool_call', type: 'js', handler: 'audit_log', enabled: true, builtin: true }],
      'GET /api/hooks/status': { enabled: true },
    });
    render(<HooksPanel accessToken="TOK" />);
    expect(screen.getByText('Hooks')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('audit_log')).toBeInTheDocument());
    expect(screen.getByText('built-in')).toBeInTheDocument();
  });
});

describe('MetricsDashboard', () => {
  test('renderiza counters + gauges', async () => {
    mockFetch({
      'GET /api/metrics/json': {
        counters: { 'http.requests': 1234, 'tool.calls': 42 },
        gauges:   { 'active.sessions': 3 },
        histograms: {},
      },
    });
    render(<MetricsDashboard accessToken="TOK" />);
    await waitFor(() => expect(screen.getByText('http.requests')).toBeInTheDocument());
    expect(screen.getByText('tool.calls')).toBeInTheDocument();
    expect(screen.getByText('active.sessions')).toBeInTheDocument();
  });
});

describe('UsersPanel', () => {
  test('renderiza usuarios con role selector', async () => {
    mockFetch({
      'GET /api/auth/admin/users': [
        { id: 'u1', name: 'Admin User', email: 'a@x.com', role: 'admin', identities: [{ channel: 'telegram', identifier: '123' }] },
        { id: 'u2', name: 'Normal User', email: 'b@x.com', role: 'user', identities: [] },
      ],
    });
    render(<UsersPanel accessToken="TOK" currentUserId="u1" />);
    await waitFor(() => expect(screen.getByText('Admin User')).toBeInTheDocument());
    expect(screen.getByText('Normal User')).toBeInTheDocument();
    expect(screen.getByText('tú')).toBeInTheDocument();
    expect(screen.getByText(/telegram:/)).toBeInTheDocument();
  });
});

describe('WorkspacesPanel', () => {
  test('renderiza providers con workspaces', async () => {
    mockFetch({
      'GET /api/workspaces': {
        'null': { enabled: true, workspaces: [] },
        'git-worktree': {
          enabled: true,
          workspaces: [{ id: 'w1', path: '/tmp/a', branch: 'sub/a', createdAt: Date.now() - 60_000, lastAccessAt: Date.now() }],
        },
        'docker': { enabled: false, workspaces: [] },
      },
    });
    render(<WorkspacesPanel accessToken="TOK" />);
    await waitFor(() => expect(screen.getByText('git-worktree')).toBeInTheDocument());
    expect(screen.getByText('w1')).toBeInTheDocument();
    expect(screen.getByText(/branch=sub\/a/)).toBeInTheDocument();
    expect(screen.getByText('deshabilitado')).toBeInTheDocument();
  });
});
