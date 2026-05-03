import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  CommandPalette,
  KeybindingsPanel,
  SessionsSidebar,
  ReasoningSummary,
} from '../components/ux';
import { matchesCombo, formatCombo, DEFAULT_BINDINGS } from '../hooks/useKeybindings';

describe('CommandPalette (D.1)', () => {
  const commands = [
    { id: 'a', title: 'Ir a Agents', group: 'nav', action: vi.fn() },
    { id: 'm', title: 'Métricas', group: 'admin', hint: '/api/metrics', action: vi.fn() },
    { id: 's', title: 'Configurar Skills', group: 'features', action: vi.fn() },
  ];

  test('no renderiza cuando open=false', () => {
    const { container } = render(<CommandPalette commands={commands} open={false} onOpenChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  test('renderiza comandos cuando open=true', () => {
    render(<CommandPalette commands={commands} open={true} onOpenChange={() => {}} />);
    expect(screen.getByText('Ir a Agents')).toBeInTheDocument();
    expect(screen.getByText('Métricas')).toBeInTheDocument();
    expect(screen.getByText('Configurar Skills')).toBeInTheDocument();
  });

  test('fuzzy filtra y ordena por score', () => {
    render(<CommandPalette commands={commands} open={true} onOpenChange={() => {}} />);
    const input = screen.getByPlaceholderText(/Buscar/);
    fireEvent.change(input, { target: { value: 'metric' } });
    // Después de filtrar: "Métricas" debe estar; "Ir a Agents" no.
    // Los chars están wrapped en <mark>, así que buscamos el parent tag <mark> con "M"
    expect(screen.queryByText('Ir a Agents')).toBeNull();
    // El hint es texto plano sin highlight, lo usamos como probe
    expect(screen.getByText('/api/metrics')).toBeInTheDocument();
  });

  test('Escape cierra', () => {
    const onOpenChange = vi.fn();
    render(<CommandPalette commands={commands} open={true} onOpenChange={onOpenChange} />);
    const input = screen.getByPlaceholderText(/Buscar/);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('Enter ejecuta el primer resultado', async () => {
    const action = vi.fn();
    const cmds = [{ id: 'x', title: 'Hacer algo', action }];
    const onOpenChange = vi.fn();
    render(<CommandPalette commands={cmds} open={true} onOpenChange={onOpenChange} />);
    const input = screen.getByPlaceholderText(/Buscar/);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('KeybindingsPanel (D.2) + hook utils', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ value: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  });

  test('matchesCombo case-insensitive', () => {
    expect(matchesCombo('mod+k', 'MOD+K')).toBe(true);
    expect(matchesCombo('mod+shift+p', 'mod+shift+p')).toBe(true);
    expect(matchesCombo('mod+k', 'mod+j')).toBe(false);
  });

  test('formatCombo traduce', () => {
    const out = formatCombo('mod+shift+k');
    expect(out).toMatch(/K/);
  });

  test('DEFAULT_BINDINGS incluye openCommandPalette', () => {
    expect(DEFAULT_BINDINGS.openCommandPalette).toBeDefined();
    expect(DEFAULT_BINDINGS.openCommandPalette.combo).toBe('mod+k');
  });

  test('panel lista todos los bindings', async () => {
    render(<KeybindingsPanel accessToken="TOK" />);
    // Esperar a que cargue overrides (fetch mock)
    await waitFor(() => expect(screen.getByText('openCommandPalette')).toBeInTheDocument());
    expect(screen.getByText('newSession')).toBeInTheDocument();
    expect(screen.getByText(/Abrir Command Palette/)).toBeInTheDocument();
  });
});

describe('SessionsSidebar (D.3)', () => {
  test('renderiza 3 grupos colapsables', () => {
    render(<SessionsSidebar
      ptySessions={[{ id: 'p1', name: 'Terminal 1', cwd: '/home' }]}
      aiChats={[{ id: 'a1', agentKey: 'claude', provider: 'anthropic' }]}
      telegramChats={[]}
      activeId="p1"
      onSelect={() => {}}
      onClose={() => {}}
    />);
    expect(screen.getByText('PTY Sessions')).toBeInTheDocument();
    expect(screen.getByText('AI Chats')).toBeInTheDocument();
    expect(screen.getByText('Telegram')).toBeInTheDocument();
    expect(screen.getByText('Terminal 1')).toBeInTheDocument();
  });

  test('click sobre item dispara onSelect con id + type', () => {
    const onSelect = vi.fn();
    render(<SessionsSidebar
      ptySessions={[{ id: 'p1', name: 'Term' }]}
      onSelect={onSelect}
    />);
    fireEvent.click(screen.getByText('Term'));
    expect(onSelect).toHaveBeenCalledWith('p1', 'pty');
  });
});

describe('ReasoningSummary (D.5)', () => {
  test('colapsado por default', () => {
    render(<ReasoningSummary content="Pensando en el problema…" />);
    expect(screen.getByText('Razonamiento')).toBeInTheDocument();
    // Contenido no visible
    expect(screen.queryByText('Pensando en el problema…')).toBeNull();
    // Word count visible
    expect(screen.getByText(/palabras/)).toBeInTheDocument();
  });

  test('click expande', () => {
    render(<ReasoningSummary content="Pensamiento largo aquí" />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    expect(screen.getByText('Pensamiento largo aquí')).toBeInTheDocument();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  test('defaultOpen=true arranca abierto', () => {
    render(<ReasoningSummary content="Visible" defaultOpen />);
    expect(screen.getByText('Visible')).toBeInTheDocument();
  });
});
