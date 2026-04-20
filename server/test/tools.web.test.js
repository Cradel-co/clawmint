'use strict';

/**
 * Tests de mcp/tools/web.js — webfetch + websearch.
 *
 * Usa stub global de fetch para no depender de red real.
 */

const tools = require('../mcp/tools/web');

function byName(n) { return tools.find(t => t.name === n); }

let originalFetch;

function mockFetch(response) {
  global.fetch = jest.fn(() => Promise.resolve(response));
}

function mockFetchError(err) {
  global.fetch = jest.fn(() => Promise.reject(err));
}

function htmlResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (k) => k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (k) => k.toLowerCase() === 'content-type' ? 'application/json' : null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

beforeEach(() => {
  originalFetch = global.fetch;
  // Limpiar rate limit state entre tests
  tools._internal._lastSearchByUser.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('webfetch', () => {
  test('error si no hay url', async () => {
    expect(await byName('webfetch').execute({})).toMatch(/url requerida/);
  });

  test('error si URL inválida', async () => {
    expect(await byName('webfetch').execute({ url: 'notaurl' })).toMatch(/URL inválida/);
  });

  test('error en hostname privado localhost', async () => {
    expect(await byName('webfetch').execute({ url: 'http://localhost/' })).toMatch(/host privado bloqueado/);
  });

  test('error en IP 127.0.0.1', async () => {
    expect(await byName('webfetch').execute({ url: 'http://127.0.0.1/' })).toMatch(/host privado bloqueado/);
  });

  test('error en IP 10.x', async () => {
    expect(await byName('webfetch').execute({ url: 'http://10.1.2.3/' })).toMatch(/host privado bloqueado.*10\./);
  });

  test('error en IP 192.168.x', async () => {
    expect(await byName('webfetch').execute({ url: 'http://192.168.1.1/' })).toMatch(/host privado bloqueado.*192\.168/);
  });

  test('error en protocolo ftp', async () => {
    expect(await byName('webfetch').execute({ url: 'ftp://example.com/' })).toMatch(/protocolo no soportado/);
  });

  test('error con extract inválido', async () => {
    mockFetch(htmlResponse('<p>x</p>'));
    expect(await byName('webfetch').execute({ url: 'https://example.com', extract: 'pdf' }))
      .toMatch(/extract debe ser/);
  });

  test('HTML → markdown elimina scripts y convierte headings', async () => {
    mockFetch(htmlResponse('<html><head><script>evil()</script></head><body><h1>Hola</h1><p>mundo</p></body></html>'));
    const out = await byName('webfetch').execute({ url: 'https://example.com', extract: 'markdown' });
    expect(out).toMatch(/# Hola/);
    expect(out).toMatch(/mundo/);
    expect(out).not.toMatch(/evil/);
  });

  test('HTML → text strippea tags', async () => {
    mockFetch(htmlResponse('<html><body><p>Hola <b>mundo</b></p></body></html>'));
    const out = await byName('webfetch').execute({ url: 'https://example.com', extract: 'text' });
    expect(out).toMatch(/Hola mundo/);
    expect(out).not.toMatch(/<p>/);
  });

  test('JSON se devuelve raw en modo markdown', async () => {
    mockFetch(jsonResponse({ foo: 'bar' }));
    const out = await byName('webfetch').execute({ url: 'https://example.com', extract: 'markdown' });
    expect(out).toMatch(/"foo":"bar"/);
  });

  test('MIME no soportado retorna error', async () => {
    mockFetch({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: (k) => k.toLowerCase() === 'content-type' ? 'application/octet-stream' : null },
      text: async () => 'bin',
    });
    const out = await byName('webfetch').execute({ url: 'https://example.com' });
    expect(out).toMatch(/MIME no soportado: application\/octet-stream/);
  });

  test('HTTP 404 retorna error', async () => {
    mockFetch(htmlResponse('not found', 404));
    const out = await byName('webfetch').execute({ url: 'https://example.com' });
    expect(out).toMatch(/HTTP 404/);
  });

  test('timeout fetch retorna mensaje específico', async () => {
    const err = new Error('timeout'); err.name = 'TimeoutError';
    mockFetchError(err);
    const out = await byName('webfetch').execute({ url: 'https://example.com' });
    expect(out).toMatch(/timeout fetch/);
  });

  test('truncado a 100KB', async () => {
    const big = 'x'.repeat(150_000);
    mockFetch({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => 'text/plain' },
      text: async () => big,
    });
    const out = await byName('webfetch').execute({ url: 'https://example.com', extract: 'text' });
    expect(out).toMatch(/truncado en 100KB/);
    expect(out.length).toBeLessThan(110_000);
  });
});

describe('websearch', () => {
  const origKey = process.env.BRAVE_SEARCH_API_KEY;
  afterAll(() => {
    if (origKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = origKey;
  });

  test('error instructivo sin API key', async () => {
    delete process.env.BRAVE_SEARCH_API_KEY;
    const out = await byName('websearch').execute({ query: 'test' });
    expect(out).toMatch(/BRAVE_SEARCH_API_KEY/);
    expect(out).toMatch(/api\.search\.brave\.com\/app\/keys/);
    expect(out).toMatch(/BSA/);
  });

  test('error si query vacía', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'BSA-test';
    const out = await byName('websearch').execute({});
    expect(out).toMatch(/query requerida/);
  });

  test('devuelve resultados formateados', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'BSA-test';
    mockFetch(jsonResponse({
      web: { results: [
        { title: 'Resultado 1', url: 'https://ex1.com', description: 'snippet 1' },
        { title: 'Resultado 2', url: 'https://ex2.com', description: 'snippet\n2' },
      ] },
    }));
    const out = await byName('websearch').execute({ query: 'node js', limit: 5 }, { userId: 'u1' });
    expect(out).toMatch(/1\. Resultado 1/);
    expect(out).toMatch(/https:\/\/ex1\.com/);
    expect(out).toMatch(/snippet 1/);
    expect(out).toMatch(/2\. Resultado 2/);
  });

  test('rate limit — segunda request inmediata falla', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'BSA-test';
    mockFetch(jsonResponse({ web: { results: [{ title: 't', url: 'u', description: 'd' }] } }));
    await byName('websearch').execute({ query: 'a' }, { userId: 'u1' });
    const out = await byName('websearch').execute({ query: 'b' }, { userId: 'u1' });
    expect(out).toMatch(/rate limit/);
  });

  test('HTTP error de Brave', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'BSA-test';
    mockFetch({
      ok: false, status: 429, statusText: 'Too Many Requests',
      headers: { get: () => 'application/json' },
      text: async () => '{"error":"quota"}',
    });
    const out = await byName('websearch').execute({ query: 'q' }, { userId: 'u1' });
    expect(out).toMatch(/429/);
  });

  test('sin resultados', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'BSA-test';
    mockFetch(jsonResponse({ web: { results: [] } }));
    const out = await byName('websearch').execute({ query: 'xyzzy' }, { userId: 'u1' });
    expect(out).toMatch(/\(sin resultados\)/);
  });
});
