'use strict';

const { createClawmintClient } = require('../sdk');

function fakeFetchOK(responseBody, contentType = 'application/json') {
  return async (url, opts) => ({
    ok: true,
    status: 200,
    headers: { get: () => contentType },
    json: async () => responseBody,
    text: async () => typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody),
  });
}

function fakeFetchErr(status, body = '') {
  return async () => ({
    ok: false, status,
    headers: { get: () => 'text/plain' },
    text: async () => body,
  });
}

describe('SDK createClawmintClient (Fase 12.1)', () => {
  test('throwea sin baseUrl', () => {
    expect(() => createClawmintClient({})).toThrow(/baseUrl/);
  });

  test('acepta fetchImpl custom', () => {
    const client = createClawmintClient({ baseUrl: 'http://x', fetchImpl: () => {} });
    expect(client.sessions).toBeDefined();
  });

  test('sessions.list llama al endpoint correcto con apiKey', async () => {
    let captured;
    const fetchImpl = async (url, opts) => {
      captured = { url, opts };
      return fakeFetchOK([{ id: 's1' }])();
    };
    const client = createClawmintClient({ baseUrl: 'http://srv', apiKey: 'k123', fetchImpl });
    const list = await client.sessions.list();
    expect(list).toEqual([{ id: 's1' }]);
    expect(captured.url).toBe('http://srv/api/sessions');
    expect(captured.opts.headers.Authorization).toBe('Bearer k123');
  });

  test('sessions.sendMessage envía body JSON', async () => {
    let captured;
    const fetchImpl = async (url, opts) => {
      captured = { url, opts };
      return fakeFetchOK({ ok: true })();
    };
    const client = createClawmintClient({ baseUrl: 'http://srv', fetchImpl });
    await client.sessions.sendMessage('s1', { text: 'hola' });
    expect(captured.url).toBe('http://srv/api/sessions/s1/message');
    expect(captured.opts.method).toBe('POST');
    expect(JSON.parse(captured.opts.body)).toEqual({ text: 'hola' });
  });

  test('sessions.share llama al endpoint /share', async () => {
    let captured;
    const fetchImpl = async (url, opts) => { captured = { url, opts }; return fakeFetchOK({ token: 't' })(); };
    const client = createClawmintClient({ baseUrl: 'http://srv', fetchImpl });
    const r = await client.sessions.share('s1', { ttlHours: 5 });
    expect(r).toEqual({ token: 't' });
    expect(captured.url).toBe('http://srv/api/sessions/s1/share');
    expect(JSON.parse(captured.opts.body)).toEqual({ ttlHours: 5, permissions: undefined });
  });

  test('preferences.set hace PUT con body', async () => {
    let captured;
    const fetchImpl = async (url, opts) => { captured = { url, opts }; return fakeFetchOK({ ok: true })(); };
    const client = createClawmintClient({ baseUrl: 'http://srv', fetchImpl });
    await client.preferences.set('keybindings', { cmd: 'x' });
    expect(captured.url).toBe('http://srv/api/user-preferences/keybindings');
    expect(captured.opts.method).toBe('PUT');
    expect(JSON.parse(captured.opts.body)).toEqual({ value: { cmd: 'x' } });
  });

  test('error HTTP se propaga como Error', async () => {
    const client = createClawmintClient({ baseUrl: 'http://srv', fetchImpl: fakeFetchErr(500, 'oops') });
    await expect(client.sessions.list()).rejects.toThrow(/500/);
  });

  test('subscribe produce async iterable con WebSocketImpl custom', () => {
    class NoopWS {
      addEventListener() {}
      send() {}
      close() {}
    }
    const client = createClawmintClient({
      baseUrl: 'http://srv', fetchImpl: fakeFetchOK({}), WebSocketImpl: NoopWS,
    });
    const it = client.sessions.subscribe('s1');
    expect(typeof it[Symbol.asyncIterator]).toBe('function');
    it.close();
  });

  test('subscribe con WebSocketImpl fake produce async iterable', async () => {
    class FakeWS {
      constructor() { this._listeners = {}; setImmediate(() => this._listeners.open && this._listeners.open()); }
      addEventListener(ev, fn) { this._listeners[ev] = fn; }
      send() {}
      close() { this._listeners.close && this._listeners.close(); }
    }
    const client = createClawmintClient({
      baseUrl: 'http://srv',
      fetchImpl: fakeFetchOK({}),
      WebSocketImpl: FakeWS,
    });
    const it = client.sessions.subscribe('s1');
    expect(typeof it.next).toBe('function');
    expect(typeof it.close).toBe('function');

    // simular un mensaje y close
    setTimeout(() => {
      const ws = it; // no exposed, use close
      it.close();
    }, 10);
    const r = await it.next();
    expect(r.done).toBe(true);
  });

  test('raw.request permite llamar endpoints no cubiertos', async () => {
    let captured;
    const fetchImpl = async (url, opts) => { captured = { url, opts }; return fakeFetchOK({ ok: true })(); };
    const client = createClawmintClient({ baseUrl: 'http://srv', fetchImpl });
    await client.raw.request('POST', '/api/custom', { x: 1 });
    expect(captured.url).toBe('http://srv/api/custom');
    expect(JSON.parse(captured.opts.body)).toEqual({ x: 1 });
  });
});
