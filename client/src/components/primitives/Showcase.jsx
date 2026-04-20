import { ToolCall, CodeBlock, DiffViewer, StatusBar, Kbd, Collapsible } from './index.js';

/**
 * <PrimitivesShowcase /> — página de verificación visual de los primitives OC-2.
 *
 * Montable manualmente para smoke-test en browser antes de integrar a los panels
 * reales. Ejemplo: agregar temporalmente en App.jsx con
 *   import Showcase from './components/primitives/Showcase';
 *   return <Showcase />;
 *
 * Muestra los 6 primitives con ejemplos representativos de uso real.
 */
export default function PrimitivesShowcase() {
  return (
    <div style={{
      padding: 'var(--space-6, 24px)',
      maxWidth: 960,
      margin: '0 auto',
      background: 'var(--oc2-surface-base, var(--bg-primary))',
      minHeight: '100vh',
      color: 'var(--oc2-text-base, var(--text-secondary))',
      fontFamily: 'var(--font-ui)',
    }}>
      <header style={{ marginBottom: 'var(--space-8, 32px)' }}>
        <h1 style={{
          color: 'var(--oc2-text-strong, var(--text-primary))',
          fontSize: 'var(--font-2xl, 24px)',
          fontWeight: 'var(--weight-semibold, 600)',
          marginBottom: 'var(--space-2, 8px)',
        }}>Primitives — OC-2 showcase</h1>
        <p style={{ color: 'var(--oc2-text-weak, var(--text-muted))', fontSize: 'var(--font-md, 14px)' }}>
          Verificación visual de los 6 primitives introducidos en Fase A.
          Activar con <Kbd>VITE_FEATURE_NEW_UI=true</Kbd> en el build.
        </p>
      </header>

      <Section title="ToolCall">
        <Stack>
          <ToolCall
            name="read_file"
            args={{ path: 'server/index.js' }}
            output="line 1\nline 2\n..."
            status="completed"
            duration={234}
          />
          <ToolCall
            name="bash"
            args={{ command: 'npm test -- paths.test.js', session_id: 's1' }}
            output="Test Suites: 1 passed, 1 total\nTests: 6 passed, 6 total"
            status="completed"
            duration={1847}
          />
          <ToolCall
            name="websearch"
            args={{ query: 'Tauri sidecar Node.js' }}
            status="running"
          />
          <ToolCall
            name="edit_file"
            args={{ path: 'broken.js', old_string: 'bar', new_string: 'baz' }}
            status="error"
            output="Error: old_string not found in file"
          />
          <ToolCall
            name="delegate_task"
            args={{ subagent_type: 'code', task: 'implementar X' }}
            output="tarea completada en 4.2s"
            status="completed"
            duration={4200}
            defaultOpen
          />
        </Stack>
      </Section>

      <Section title="CodeBlock">
        <Stack>
          <CodeBlock lang="js" code={`function greet(name) {\n  return \`Hola \${name}\`;\n}\n\ngreet('mundo');`} />
          <CodeBlock lang="bash" code={`cd /opt/clawmint\nnpm install --production\nnpm start`} showLineNumbers />
          <CodeBlock lang="json" code={`{\n  "firstRun": false,\n  "version": "1.4.0"\n}`} />
        </Stack>
      </Section>

      <Section title="DiffViewer">
        <Stack>
          <DiffViewer
            path="server/paths.js"
            before={`const MEMORY_DIR = path.join(__dirname, 'memory');\nconst CONFIG = process.env.CONFIG;`}
            after={`const MEMORY_DIR = path.join(DATA_DIR, 'memory');\nconst CONFIG = process.env.CLAWMINT_CONFIG;\nconst LOGS = path.join(LOG_DIR, 'app.log');`}
          />
          <DiffViewer
            path="unified-example.txt"
            unified={[
              '@@ -1,4 +1,4 @@',
              ' line uno',
              '-line dos old',
              '+line dos NEW',
              ' line tres',
              ' line cuatro',
            ].join('\n')}
          />
        </Stack>
      </Section>

      <Section title="StatusBar">
        <Stack>
          <StatusBar
            model="claude-opus-4-7"
            provider="anthropic"
            contextTokens={45200}
            contextLimit={200000}
            agent="claude"
            sessionId="s_abc123def456"
            status="connected"
            latencyMs={487}
          />
          <StatusBar
            model="claude-sonnet-4-6"
            contextTokens={175000}
            contextLimit={200000}
            status="reconnecting"
          />
          <StatusBar
            provider="openai"
            model="gpt-5"
            status="error"
            contextTokens={198000}
            contextLimit={200000}
          />
        </Stack>
      </Section>

      <Section title="Kbd">
        <div style={{ display: 'flex', gap: 'var(--space-3, 12px)', flexWrap: 'wrap', alignItems: 'center' }}>
          <Kbd>Cmd+K</Kbd>
          <Kbd>Ctrl+Shift+P</Kbd>
          <Kbd>Escape</Kbd>
          <Kbd keys={['Alt', 'Enter']} />
          <Kbd>Up</Kbd>
          <Kbd>Tab</Kbd>
        </div>
      </Section>

      <Section title="Collapsible (primitive base)">
        <Collapsible
          trigger={<div style={{ padding: 12, background: 'var(--oc2-surface-raised, var(--bg-card))', borderRadius: 6, border: '1px solid var(--oc2-border-weak, var(--border-primary))' }}>Click para expandir ▸</div>}
        >
          <div style={{ padding: 16, marginTop: 8, background: 'var(--oc2-surface-raised, var(--bg-card))', borderRadius: 6, border: '1px solid var(--oc2-border-weaker, var(--border-subtle))' }}>
            Contenido revelado. Soporta cualquier JSX arbitrario — texto, componentes, otros Collapsibles anidados.
          </div>
        </Collapsible>
      </Section>

      <footer style={{
        marginTop: 'var(--space-12, 48px)',
        padding: 'var(--space-4, 16px) 0',
        borderTop: '1px solid var(--oc2-border-weak, var(--border-primary))',
        fontSize: 'var(--font-sm, 12px)',
        color: 'var(--oc2-text-weak, var(--text-muted))',
      }}>
        Primitives de Fase A — paleta OC-2 · fuente: <code>client/src/components/primitives/</code>
      </footer>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section style={{ marginBottom: 'var(--space-8, 32px)' }}>
      <h2 style={{
        color: 'var(--oc2-text-strong, var(--text-primary))',
        fontSize: 'var(--font-lg, 16px)',
        fontWeight: 'var(--weight-medium, 500)',
        marginBottom: 'var(--space-3, 12px)',
        textTransform: 'lowercase',
        letterSpacing: 'var(--tracking-wide, 0.02em)',
      }}>{title}</h2>
      {children}
    </section>
  );
}

function Stack({ children }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3, 12px)' }}>{children}</div>;
}
