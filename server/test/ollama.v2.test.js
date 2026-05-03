'use strict';

/**
 * Tests de ollama.js v2 (fase 2 del refactor).
 *
 * Foco: el nuevo gate `images + tools → error explícito` y los helpers internos.
 * Los paths de red (nativa, OpenAI-compat) se cubren en tests de integración
 * aparte (requieren un servidor Ollama real o mocks complejos); acá validamos
 * el routing y gating de forma unitaria.
 */

const ollama = require('../providers/ollama');

async function collect(asyncGen) {
  const out = [];
  for await (const ev of asyncGen) out.push(ev);
  return out;
}

describe('ollama._internal — detección de modelos con visión', () => {
  const { isVisionModel } = ollama._internal;

  test('minicpm-v → true', () => {
    expect(isVisionModel('minicpm-v')).toBe(true);
    expect(isVisionModel('minicpm-v:latest')).toBe(true);
  });
  test('llava variantes → true', () => {
    expect(isVisionModel('llava')).toBe(true);
    expect(isVisionModel('llava-llama3')).toBe(true);
    expect(isVisionModel('bakllava')).toBe(true);
  });
  test('qwen → false', () => {
    expect(isVisionModel('qwen2.5:7b')).toBe(false);
    expect(isVisionModel('llama3:8b')).toBe(false);
  });
  test('null/undefined → false', () => {
    expect(isVisionModel(null)).toBe(false);
    expect(isVisionModel(undefined)).toBe(false);
    expect(isVisionModel('')).toBe(false);
  });
});

describe('ollama.chat — gate de combinación no soportada', () => {
  test('images + tools + executeTool → done con error explícito (unsupported_combo)', async () => {
    // Stub: evitar fetch real a Ollama
    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: false });

    try {
      const events = await collect(ollama.chat({
        history: [{ role: 'user', content: 'qué ves?' }],
        images: [{ mediaType: 'image/png', base64: 'AAAA' }],
        executeTool: jest.fn(),  // combo con tools
      }));

      const done = events.find(e => e.type === 'done');
      expect(done.fullText).toMatch(/no soporta imágenes Y tools simultáneamente/i);
      // Importante: NO hay eventos `text` antes — aborta de entrada
      const texts = events.filter(e => e.type === 'text');
      expect(texts).toHaveLength(0);
    } finally {
      global.fetch = origFetch;
    }
  });

  test('images sin executeTool → permite rama visión (no error)', async () => {
    // No ejecutar realmente — solo verificar que no entra al path de error
    // El test de networking completo queda fuera (requiere servidor real o mock http)
    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'minicpm-v:latest' }] }),
    });

    try {
      // Como no hay servidor real, la iteración va a fallar en el http.request
      // pero el primer evento NO debe ser "no soporta imágenes Y tools"
      const gen = ollama.chat({
        history: [{ role: 'user', content: 'ver' }],
        images: [{ mediaType: 'image/png', base64: 'AAAA' }],
        // sin executeTool
      });
      const firstEvent = (await gen.next()).value;
      // El primer evento no debería ser el error de combo (porque no hay tools)
      if (firstEvent && firstEvent.type === 'done') {
        expect(firstEvent.fullText).not.toMatch(/no soporta imágenes Y tools/i);
      }
      // Cerrar el generador para no gastar tiempo esperando al http
      await gen.return();
    } finally {
      global.fetch = origFetch;
    }
  });
});

describe('ollama.chat — AbortSignal previo', () => {
  test('texto sin tools: signal abortado → done "Cancelado"', async () => {
    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'qwen2.5:7b' }] }),
    });

    try {
      const ac = new AbortController();
      ac.abort();
      const events = await collect(ollama.chat({
        history: [{ role: 'user', content: 'hi' }],
        signal: ac.signal,
      }));
      // Delega a openaiCompatChat — ese retorna done "Cancelado" cuando signal aborted
      const done = events.find(e => e.type === 'done');
      expect(done.fullText).toMatch(/Cancelado/);
    } finally {
      global.fetch = origFetch;
    }
  });
});
