'use strict';

/**
 * Tests de providers/
 *
 * - providers/index.js: list() + get()
 * - providers/claude-code.js: interfaz del provider
 * - providers/gemini.js: lógica del chat con GoogleGenAI mockeado
 */

// ── Helper: recolectar todos los yields de un async generator ─────────────────
async function collect(gen) {
  const events = [];
  for await (const item of gen) events.push(item);
  return events;
}

// ── providers/index.js ────────────────────────────────────────────────────────

describe('providers/index.js', () => {
  const providers = require('../providers');

  test('list() retorna un array de 6 providers', () => {
    const list = providers.list();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(6);
  });

  test('list() — cada provider tiene name, label, models', () => {
    for (const p of providers.list()) {
      expect(typeof p.name).toBe('string');
      expect(typeof p.label).toBe('string');
      expect(Array.isArray(p.models)).toBe(true);
    }
  });

  test('list() incluye claude-code, anthropic, gemini, openai, grok, ollama', () => {
    const names = providers.list().map(p => p.name);
    expect(names).toContain('claude-code');
    expect(names).toContain('anthropic');
    expect(names).toContain('gemini');
    expect(names).toContain('openai');
    expect(names).toContain('grok');
    expect(names).toContain('ollama');
  });

  test('get("gemini") retorna el provider de Gemini', () => {
    const p = providers.get('gemini');
    expect(p.name).toBe('gemini');
  });

  test('get("claude-code") retorna el provider claude-code', () => {
    const p = providers.get('claude-code');
    expect(p.name).toBe('claude-code');
  });

  test('get() con nombre desconocido hace fallback a anthropic', () => {
    const p = providers.get('proveedor-inexistente');
    expect(p.name).toBe('anthropic');
  });

  test('cada provider tiene una función chat()', () => {
    for (const p of providers.list()) {
      const impl = providers.get(p.name);
      expect(typeof impl.chat).toBe('function');
    }
  });
});

// ── providers/claude-code.js ──────────────────────────────────────────────────

describe('providers/claude-code.js', () => {
  const claudeCode = require('../providers/claude-code');

  test('tiene name, label, models, defaultModel', () => {
    expect(claudeCode.name).toBe('claude-code');
    expect(typeof claudeCode.label).toBe('string');
    expect(Array.isArray(claudeCode.models)).toBe(true);
    expect(claudeCode.defaultModel).toBeNull();
  });

  test('sin claudeSession yields error y termina', async () => {
    const events = await collect(claudeCode.chat({
      systemPrompt: '',
      history: [{ role: 'user', content: 'hola' }],
    }));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
    expect(events[0].fullText).toContain('claudeSession requerida');
  });

  test('con claudeSession mockeada yields el resultado', async () => {
    const mockSession = {
      messageCount: 1,
      sendMessage: jest.fn().mockResolvedValue('Respuesta del agente'),
    };

    const events = await collect(claudeCode.chat({
      systemPrompt: 'Sos un asistente',
      history: [{ role: 'user', content: 'hola' }],
      claudeSession: mockSession,
    }));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
    expect(events[0].fullText).toBe('Respuesta del agente');
    expect(mockSession.sendMessage).toHaveBeenCalledWith('hola', undefined);
  });

  test('en el primer mensaje (messageCount=0) con systemPrompt, lo prepende', async () => {
    const mockSession = {
      messageCount: 0,
      sendMessage: jest.fn().mockResolvedValue('ok'),
    };

    await collect(claudeCode.chat({
      systemPrompt: 'SYSTEM PROMPT',
      history: [{ role: 'user', content: 'mensaje del usuario' }],
      claudeSession: mockSession,
    }));

    const calledWith = mockSession.sendMessage.mock.calls[0][0];
    expect(calledWith).toContain('SYSTEM PROMPT');
    expect(calledWith).toContain('mensaje del usuario');
  });

  test('errores de claudeSession son capturados y devueltos como done', async () => {
    const mockSession = {
      messageCount: 1,
      sendMessage: jest.fn().mockRejectedValue(new Error('timeout de red')),
    };

    const events = await collect(claudeCode.chat({
      history: [{ role: 'user', content: 'hola' }],
      claudeSession: mockSession,
    }));

    expect(events[0].type).toBe('done');
    expect(events[0].fullText).toContain('timeout de red');
  });

  test('llama a onChunk cuando se provee', async () => {
    const chunks = [];
    const mockSession = {
      messageCount: 1,
      sendMessage: jest.fn().mockImplementation(async (text, onChunk) => {
        if (onChunk) onChunk('chunk1');
        return 'resultado final';
      }),
    };

    await collect(claudeCode.chat({
      history: [{ role: 'user', content: 'test' }],
      claudeSession: mockSession,
      onChunk: (c) => chunks.push(c),
    }));

    expect(chunks).toContain('chunk1');
  });
});

// ── providers/gemini.js ───────────────────────────────────────────────────────

// Mock de @google/genai antes de importar gemini.js
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn(),
}));

describe('providers/gemini.js', () => {
  const { GoogleGenAI } = require('@google/genai');
  const gemini = require('../providers/gemini');

  const BASE_HISTORY = [
    { role: 'user', content: 'hola gemini' },
  ];

  function makeAI(candidates) {
    return {
      models: {
        generateContent: jest.fn().mockResolvedValue({
          candidates,
        }),
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('tiene name, label, models, defaultModel', () => {
    expect(gemini.name).toBe('gemini');
    expect(typeof gemini.label).toBe('string');
    expect(Array.isArray(gemini.models)).toBe(true);
    expect(typeof gemini.defaultModel).toBe('string');
  });

  test('sin apiKey yields error done inmediatamente', async () => {
    const events = await collect(gemini.chat({
      systemPrompt: '',
      history: BASE_HISTORY,
      apiKey: '',
      model: 'gemini-2.0-flash',
    }));

    expect(events[0].type).toBe('done');
    expect(events[0].fullText).toContain('API key de Gemini no configurada');
  });

  test('respuesta simple de texto → yields text + done', async () => {
    const mockAI = makeAI([{
      content: {
        parts: [{ text: 'Hola! Soy Gemini.' }],
      },
    }]);
    GoogleGenAI.mockImplementation(() => mockAI);

    const events = await collect(gemini.chat({
      systemPrompt: '',
      history: BASE_HISTORY,
      apiKey: 'test-key',
      model: 'gemini-2.0-flash',
    }));

    const textEvent = events.find(e => e.type === 'text');
    const doneEvent = events.find(e => e.type === 'done');
    expect(textEvent.text).toBe('Hola! Soy Gemini.');
    expect(doneEvent.fullText).toBe('Hola! Soy Gemini.');
  });

  test('respuesta sin partes de texto → yields usage + done', async () => {
    const mockAI = makeAI([{
      content: { parts: [] },
    }]);
    GoogleGenAI.mockImplementation(() => mockAI);

    const events = await collect(gemini.chat({
      history: BASE_HISTORY,
      apiKey: 'test-key',
    }));

    const types = events.map(e => e.type);
    expect(types).toContain('done');
    expect(types.every(t => t === 'done' || t === 'usage')).toBe(true);
  });

  test('function call → yields tool_call + tool_result + done', async () => {
    const mockAI = {
      models: {
        generateContent: jest.fn()
          // Primera respuesta: contiene una función
          .mockResolvedValueOnce({
            candidates: [{
              content: {
                parts: [{
                  functionCall: {
                    name: 'bash',
                    args: { command: 'echo test' },
                  },
                }],
              },
            }],
          })
          // Segunda respuesta (con resultado de la herramienta): texto final
          .mockResolvedValueOnce({
            candidates: [{
              content: {
                parts: [{ text: 'El comando retornó: test' }],
              },
            }],
          }),
      },
    };
    GoogleGenAI.mockImplementation(() => mockAI);

    const execTool = jest.fn().mockResolvedValue('test');

    const events = await collect(gemini.chat({
      history: BASE_HISTORY,
      apiKey: 'test-key',
      executeTool: execTool,
    }));

    const toolCall   = events.find(e => e.type === 'tool_call');
    const toolResult = events.find(e => e.type === 'tool_result');
    const done       = events.find(e => e.type === 'done');

    expect(toolCall).toBeTruthy();
    expect(toolCall.name).toBe('bash');
    expect(toolCall.args.command).toBe('echo test');

    expect(toolResult).toBeTruthy();
    expect(toolResult.result).toBe('test');

    expect(done).toBeTruthy();
    expect(done.fullText).toContain('El comando retornó');

    expect(execTool).toHaveBeenCalledWith('bash', { command: 'echo test' });
  });

  test('error de la API → yields done con mensaje de error', async () => {
    const mockAI = {
      models: {
        generateContent: jest.fn().mockRejectedValue(new Error('API rate limit')),
      },
    };
    GoogleGenAI.mockImplementation(() => mockAI);

    const events = await collect(gemini.chat({
      history: BASE_HISTORY,
      apiKey: 'test-key',
    }));

    expect(events[0].type).toBe('done');
    expect(events[0].fullText).toContain('API rate limit');
  });

  test('respuesta vacía (candidates=[]) → yields done con fullText vacío', async () => {
    const mockAI = makeAI([]);
    GoogleGenAI.mockImplementation(() => mockAI);

    const events = await collect(gemini.chat({
      history: BASE_HISTORY,
      apiKey: 'test-key',
    }));

    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent).toBeTruthy();
  });

  test('usa executeTool inyectado si se provee', async () => {
    const mockAI = {
      models: {
        generateContent: jest.fn()
          .mockResolvedValueOnce({
            candidates: [{
              content: { parts: [{ functionCall: { name: 'bash', args: { command: 'pwd' } } }] },
            }],
          })
          .mockResolvedValueOnce({
            candidates: [{ content: { parts: [{ text: 'done' }] } }],
          }),
      },
    };
    GoogleGenAI.mockImplementation(() => mockAI);

    const injectedExec = jest.fn().mockResolvedValue('/home/user');

    await collect(gemini.chat({
      history: BASE_HISTORY,
      apiKey: 'test-key',
      executeTool: injectedExec,
    }));

    expect(injectedExec).toHaveBeenCalledWith('bash', { command: 'pwd' });
  });

  test('history con múltiples turnos se convierte correctamente', async () => {
    const mockAI = makeAI([{
      content: { parts: [{ text: 'ok' }] },
    }]);
    GoogleGenAI.mockImplementation(() => mockAI);

    const history = [
      { role: 'user',      content: 'pregunta 1' },
      { role: 'assistant', content: 'respuesta 1' },
      { role: 'user',      content: 'pregunta 2' },
    ];

    await collect(gemini.chat({ history, apiKey: 'test-key' }));

    const callArgs = mockAI.models.generateContent.mock.calls[0][0];
    // Debe pasar los primeros mensajes como "contents" y el último como parte del body
    expect(callArgs.contents.some(c => c.role === 'model')).toBe(true);
  });
});
