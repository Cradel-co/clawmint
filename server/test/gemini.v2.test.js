'use strict';

/**
 * Tests de gemini.js v2 (fase 2 del refactor).
 * Mockea `@google/genai` para controlar streaming determinista.
 */

jest.mock('@google/genai', () => {
  const mock = { GoogleGenAI: jest.fn() };
  return mock;
});

const { GoogleGenAI } = require('@google/genai');
const gemini = require('../providers/gemini');

async function collect(asyncGen) {
  const out = [];
  for await (const ev of asyncGen) out.push(ev);
  return out;
}

/** Crea un mock stream AsyncIterable */
function mockStream(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function makeAI(streamImpl) {
  return {
    models: {
      generateContentStream: jest.fn().mockImplementation(streamImpl),
    },
  };
}

function textChunk(text, finishReason = null) {
  const chunk = { candidates: [{ content: { parts: [{ text }] } }] };
  if (finishReason) chunk.candidates[0].finishReason = finishReason;
  return chunk;
}

function usageChunk(prompt, completion) {
  return { usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: completion } };
}

function functionCallChunk(name, args) {
  return { candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] };
}

describe('gemini.chat — streaming v2', () => {
  beforeEach(() => GoogleGenAI.mockClear());

  test('sin apiKey → done con error', async () => {
    const events = await collect(gemini.chat({ history: [], apiKey: '' }));
    expect(events[0].type).toBe('done');
    expect(events[0].fullText).toMatch(/API key/);
    expect(GoogleGenAI).not.toHaveBeenCalled();
  });

  test('emite text por cada chunk con part.text', async () => {
    const chunks = [
      textChunk('Hola'),
      textChunk(', '),
      textChunk('mundo', 'STOP'),
      usageChunk(10, 3),
    ];
    GoogleGenAI.mockImplementation(() => makeAI(() => mockStream(chunks)));

    const events = await collect(gemini.chat({
      history: [{ role: 'user', content: 'hi' }], apiKey: 'k',
    }));

    const texts = events.filter(e => e.type === 'text');
    expect(texts.map(t => t.text)).toEqual(['Hola', ', ', 'mundo']);
    const done = events.find(e => e.type === 'done');
    expect(done.fullText).toBe('Hola, mundo');
  });

  test('usage extraído de usageMetadata', async () => {
    const chunks = [textChunk('ok', 'STOP'), usageChunk(50, 20)];
    GoogleGenAI.mockImplementation(() => makeAI(() => mockStream(chunks)));

    const events = await collect(gemini.chat({
      history: [{ role: 'user', content: 'hi' }], apiKey: 'k',
    }));
    const usage = events.find(e => e.type === 'usage');
    expect(usage.promptTokens).toBe(50);
    expect(usage.completionTokens).toBe(20);
  });

  test('functionCall → executeTool → functionResponse round trip', async () => {
    // Turno 1: modelo pide `bash`
    const turn1 = [functionCallChunk('bash', { command: 'ls' })];
    // Turno 2: responde con texto
    const turn2 = [textChunk('listo', 'STOP'), usageChunk(10, 5)];

    let call = 0;
    GoogleGenAI.mockImplementation(() => makeAI(() => {
      call++;
      return mockStream(call === 1 ? turn1 : turn2);
    }));

    const execTool = jest.fn().mockResolvedValue('file1\nfile2');
    const events = await collect(gemini.chat({
      history: [{ role: 'user', content: 'hi' }], apiKey: 'k', executeTool: execTool,
    }));

    expect(execTool).toHaveBeenCalledWith('bash', { command: 'ls' });
    const toolCall = events.find(e => e.type === 'tool_call');
    expect(toolCall.name).toBe('bash');
    expect(toolCall.args).toEqual({ command: 'ls' });
    const toolResult = events.find(e => e.type === 'tool_result');
    expect(toolResult.result).toBe('file1\nfile2');
  });

  test('AbortSignal previo → done "Cancelado", sin llamar al SDK', async () => {
    GoogleGenAI.mockImplementation(() => makeAI(() => mockStream([])));
    const ac = new AbortController();
    ac.abort();

    const events = await collect(gemini.chat({
      history: [{ role: 'user', content: 'hi' }], apiKey: 'k', signal: ac.signal,
    }));

    const done = events.find(e => e.type === 'done');
    expect(done.fullText).toMatch(/Cancelado/);
  });

  test('signal se propaga al SDK como config.abortSignal', async () => {
    let capturedConfig;
    const aiObj = {
      models: {
        generateContentStream: jest.fn().mockImplementation(async (opts) => {
          capturedConfig = opts.config;
          return mockStream([textChunk('ok', 'STOP'), usageChunk(1, 1)]);
        }),
      },
    };
    GoogleGenAI.mockImplementation(() => aiObj);

    const ac = new AbortController();
    await collect(gemini.chat({
      history: [{ role: 'user', content: 'hi' }], apiKey: 'k', signal: ac.signal,
    }));

    expect(capturedConfig.abortSignal).toBe(ac.signal);
  });

  test('imágenes se inyectan como inlineData en el último user turn', async () => {
    let capturedContents;
    const aiObj = {
      models: {
        generateContentStream: jest.fn().mockImplementation(async (opts) => {
          capturedContents = opts.contents;
          return mockStream([textChunk('ok', 'STOP'), usageChunk(1, 1)]);
        }),
      },
    };
    GoogleGenAI.mockImplementation(() => aiObj);

    await collect(gemini.chat({
      history: [{ role: 'user', content: '¿qué es esto?' }],
      apiKey: 'k',
      images: [{ mediaType: 'image/png', base64: 'AAAA' }],
    }));

    const lastContent = capturedContents[capturedContents.length - 1];
    expect(lastContent.role).toBe('user');
    const inlineParts = lastContent.parts.filter(p => p.inlineData);
    expect(inlineParts).toHaveLength(1);
    expect(inlineParts[0].inlineData.mimeType).toBe('image/png');
    expect(inlineParts[0].inlineData.data).toBe('AAAA');
  });

  test('systemPrompt se pasa en config.systemInstruction, no como message', async () => {
    let capturedOpts;
    const aiObj = {
      models: {
        generateContentStream: jest.fn().mockImplementation(async (opts) => {
          capturedOpts = opts;
          return mockStream([textChunk('ok', 'STOP'), usageChunk(1, 1)]);
        }),
      },
    };
    GoogleGenAI.mockImplementation(() => aiObj);

    await collect(gemini.chat({
      history: [{ role: 'user', content: 'hola' }], apiKey: 'k',
      systemPrompt: 'Sos un asistente útil.',
    }));

    expect(capturedOpts.config.systemInstruction).toBe('Sos un asistente útil.');
    // Verificar que NO se inyectó como mensaje
    for (const c of capturedOpts.contents) {
      expect(c.role).not.toBe('system');
    }
  });

  test('error del SDK se traduce a done con mensaje', async () => {
    GoogleGenAI.mockImplementation(() => ({
      models: {
        generateContentStream: async () => { throw new Error('quota exceeded'); },
      },
    }));

    const events = await collect(gemini.chat({
      history: [{ role: 'user', content: 'hi' }], apiKey: 'k',
    }));

    const done = events.find(e => e.type === 'done');
    expect(done.fullText).toMatch(/Error Gemini: quota exceeded/);
  });
});
