import { describe, test, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCall, CodeBlock, DiffViewer, StatusBar, Kbd, Collapsible } from '../components/primitives';

describe('Collapsible', () => {
  test('renderiza trigger y contenido oculto por default', () => {
    render(
      <Collapsible trigger={<span>toggle me</span>}>
        <div>hidden content</div>
      </Collapsible>
    );
    expect(screen.getByText('toggle me')).toBeInTheDocument();
    expect(screen.getByText('hidden content')).toBeInTheDocument(); // sigue en DOM, solo colapsado
  });

  test('toggle cambia aria-expanded', () => {
    render(<Collapsible trigger={<span>t</span>}><p>x</p></Collapsible>);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  test('defaultOpen=true arranca abierto', () => {
    render(<Collapsible defaultOpen trigger={<span>t</span>}><p>x</p></Collapsible>);
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('ToolCall', () => {
  test('renderiza name y args preview', () => {
    render(<ToolCall name="read_file" args={{ path: '/tmp/x.txt' }} output="contenido" />);
    expect(screen.getByText('read_file')).toBeInTheDocument();
    expect(screen.getByText('/tmp/x.txt')).toBeInTheDocument();
  });

  test('status running muestra indicador "ejecutando"', () => {
    render(<ToolCall name="bash" args={{ command: 'ls' }} status="running" />);
    expect(screen.getByText(/ejecutando/)).toBeInTheDocument();
  });

  test('status error abre por default', () => {
    render(<ToolCall name="bash" args={{ command: 'x' }} status="error" output="command not found" />);
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
  });

  test('duration muestra en ms si < 1s', () => {
    render(<ToolCall name="read_file" args={{ path: '/x' }} duration={456} />);
    expect(screen.getByText(/456ms/)).toBeInTheDocument();
  });

  test('duration muestra en s si >= 1s', () => {
    render(<ToolCall name="read_file" args={{ path: '/x' }} duration={2300} />);
    expect(screen.getByText(/2\.3s/)).toBeInTheDocument();
  });
});

describe('CodeBlock', () => {
  test('renderiza code + lang label + copy button', () => {
    render(<CodeBlock code="const x = 1;" lang="js" />);
    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
    expect(screen.getByText('js')).toBeInTheDocument();
    expect(screen.getByLabelText('Copiar')).toBeInTheDocument();
  });

  test('showLineNumbers=true agrega números', () => {
    render(<CodeBlock code={'a\nb\nc'} lang="txt" showLineNumbers />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  test('copyable=false no muestra botón', () => {
    render(<CodeBlock code="x" lang="txt" copyable={false} />);
    expect(screen.queryByLabelText('Copiar')).not.toBeInTheDocument();
  });
});

describe('DiffViewer', () => {
  test('renderiza desde before/after con stats', () => {
    render(<DiffViewer before={'a\nb\nc'} after={'a\nB\nc'} path="x.js" />);
    expect(screen.getByText('x.js')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('−1')).toBeInTheDocument();
  });

  test('parsea unified diff', () => {
    const unified = [
      '@@ -1,3 +1,3 @@',
      ' context line',
      '-removed line',
      '+added line',
      ' tail',
    ].join('\n');
    render(<DiffViewer unified={unified} />);
    expect(screen.getByText('removed line')).toBeInTheDocument();
    expect(screen.getByText('added line')).toBeInTheDocument();
  });
});

describe('StatusBar', () => {
  test('renderiza props presentes y omite ausentes', () => {
    render(<StatusBar model="claude-opus-4-7" provider="anthropic" agent="claude" />);
    expect(screen.getByText(/agent:/)).toBeInTheDocument();
    expect(screen.getByText('claude')).toBeInTheDocument();
    expect(screen.getByText('anthropic')).toBeInTheDocument();
    expect(screen.queryByText(/ctx:/)).not.toBeInTheDocument(); // sin contextTokens
  });

  test('context % se calcula correctamente', () => {
    render(<StatusBar contextTokens={50000} contextLimit={200000} />);
    expect(screen.getByText('25%')).toBeInTheDocument();
  });

  test('data-status refleja prop', () => {
    const { container } = render(<StatusBar status="error" />);
    expect(container.querySelector('[data-status="error"]')).toBeInTheDocument();
  });
});

describe('Kbd', () => {
  test('parsea string con +', () => {
    render(<Kbd>Ctrl+K</Kbd>);
    // En Mac se traduce a ⌘K, en Linux queda CTRL K
    const root = screen.getByText(/K/);
    expect(root).toBeInTheDocument();
  });

  test('keys array explícito', () => {
    render(<Kbd keys={['Shift', 'P']} />);
    expect(screen.getByText('P')).toBeInTheDocument();
  });
});
