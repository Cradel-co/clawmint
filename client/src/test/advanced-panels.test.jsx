import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import {
  CompactionSettingsPanel,
  ModelTiersPanel,
  ToolsFilterPanel,
  LSPStatusPanel,
  OrchestrationPanel,
} from '../components/advanced';

function mockFetch(routes) {
  global.fetch = vi.fn(async (url, opts) => {
    const method = (opts?.method || 'GET').toUpperCase();
    const path = url.replace(/^http:\/\/[^/]+/, '').split('?')[0];
    const key = `${method} ${path}`;
    const handler = routes[key] || routes['*'];
    if (!handler) return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const data = typeof handler === 'function' ? handler(opts) : handler;
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('CompactionSettingsPanel (E.1)', () => {
  test('renderiza current + toggles + tuning', async () => {
    mockFetch({
      'GET /api/config/compaction': {
        current: { reactive_enabled: true, micro_enabled: false, microcompact_every_turns: 15, microcompact_keep_last_k: 4, autocompact_buffer_tokens: 13000, max_consecutive_compact_failures: 3 },
        defaults: { reactive_enabled: false, micro_enabled: false, microcompact_every_turns: 10, microcompact_keep_last_k: 4, autocompact_buffer_tokens: 13000, max_consecutive_compact_failures: 3 },
        overridden: true,
      },
    });
    render(<CompactionSettingsPanel accessToken="TOK" />);
    await waitFor(() => expect(screen.getByText('Context compaction')).toBeInTheDocument());
    expect(screen.getByText('Tuning')).toBeInTheDocument();
    expect(screen.getByText('Reactive compactor')).toBeInTheDocument();
  });
});

describe('ModelTiersPanel (E.2)', () => {
  test('renderiza matriz provider × tier', async () => {
    mockFetch({
      'GET /api/config/model-tiers': {
        current: {
          anthropic: { cheap: 'claude-haiku-4-5', balanced: 'claude-sonnet-4-6', premium: 'claude-opus-4-7' },
          openai:    { cheap: 'gpt-4o-mini', balanced: 'gpt-4o', premium: 'gpt-5' },
        },
        defaults: {
          anthropic: { cheap: 'claude-haiku-4-5', balanced: 'claude-sonnet-4-6', premium: 'claude-opus-4-7' },
          openai:    { cheap: 'gpt-4o-mini', balanced: 'gpt-4o', premium: 'gpt-5' },
        },
        overridden: false,
      },
    });
    render(<ModelTiersPanel accessToken="TOK" />);
    await waitFor(() => expect(screen.getByText('Model tiers')).toBeInTheDocument());
    expect(screen.getByText('anthropic')).toBeInTheDocument();
    expect(screen.getByText('openai')).toBeInTheDocument();
    expect(screen.getByDisplayValue('claude-opus-4-7')).toBeInTheDocument();
  });
});

describe('ToolsFilterPanel (E.3)', () => {
  test('renderiza lista con filtros', async () => {
    mockFetch({
      'GET /api/tools/all': {
        tools: [
          { name: 'bash', category: 'shell', source: 'core', adminOnly: true, description: 'Execute bash', disabled_user: false, disabled_env: false },
          { name: 'read_file', category: 'files', source: 'core', description: 'Read a file', disabled_user: false, disabled_env: false },
        ],
        env_disabled: [],
        user_disabled: [],
      },
    });
    render(<ToolsFilterPanel accessToken="TOK" />);
    await waitFor(() => expect(screen.getByText('Tools filter')).toBeInTheDocument());
    expect(screen.getByText('bash')).toBeInTheDocument();
    expect(screen.getByText('read_file')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument(); // adminOnly flag
  });
});

describe('LSPStatusPanel (E.4)', () => {
  test('renderiza servers con availability', async () => {
    mockFetch({
      'GET /api/lsp/status': {
        enabled: true,
        servers: [
          { language: 'ts', command: 'typescript-language-server', extensions: ['.ts', '.tsx'], available: true },
          { language: 'py', command: 'pylsp', extensions: ['.py'], available: false },
        ],
        active: [],
      },
    });
    render(<LSPStatusPanel accessToken="TOK" />);
    await waitFor(() => expect(screen.getByText('LSP status')).toBeInTheDocument());
    expect(screen.getByText('typescript-language-server')).toBeInTheDocument();
    expect(screen.getByText('disponible')).toBeInTheDocument();
    expect(screen.getByText('no instalado')).toBeInTheDocument();
    expect(screen.getByText(/pip install/)).toBeInTheDocument();
  });
});

describe('OrchestrationPanel (E.5)', () => {
  test('renderiza workflows con tasks', async () => {
    mockFetch({
      'GET /api/orchestration/workflows': [
        {
          id: 'wf_abc',
          chatId: 'c1',
          coordinator: 'claude',
          channel: 'telegram',
          status: 'active',
          delegationCount: 2,
          createdAt: Date.now() - 30000,
          tasks: [
            { id: 't_1', agent: 'claude', subagentType: 'explore', description: 'Buscar X', status: 'done', startedAt: Date.now() - 20000, completedAt: Date.now() - 5000, resultPreview: 'Encontré 3 archivos' },
            { id: 't_2', agent: 'claude', subagentType: 'code', description: 'Implementar Y', status: 'running', startedAt: Date.now() - 2000, completedAt: null, resultPreview: null },
          ],
        },
      ],
    });
    render(<OrchestrationPanel accessToken="TOK" />);
    expect(screen.getByText('Orchestration')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('wf_abc')).toBeInTheDocument());
    expect(screen.getByText('explore')).toBeInTheDocument();
    expect(screen.getByText('code')).toBeInTheDocument();
    expect(screen.getByText('Encontré 3 archivos')).toBeInTheDocument();
  });
});
