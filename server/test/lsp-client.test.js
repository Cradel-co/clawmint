'use strict';

const EventEmitter = require('events');

const LSPClient = require('../services/LSPClient');

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdin = { write: jest.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

/** Arranca un LSPClient y hace el handshake initialize usando un fake child. */
async function startFakeClient(opts = {}) {
  const child = makeFakeChild();
  const silent = { info: () => {}, warn: () => {}, debug: () => {} };
  const c = new LSPClient({
    command: 'fake-ls', cwd: '/tmp',
    spawnImpl: () => child,
    logger: silent,
    timeoutMs: opts.timeoutMs || 500,
    ...opts,
  });
  const startP = c.start();
  await new Promise(r => setImmediate(r));
  // Responder al initialize (id=1)
  child.stdout.emit('data', frame({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
  await startP;
  return { client: c, child };
}

describe('LSPClient (Fase 10)', () => {
  test('throwea sin command', () => {
    expect(() => new LSPClient({})).toThrow(/command/);
  });

  test('start() envía initialize + initialized', async () => {
    const { child } = await startFakeClient();
    const allWrites = child.stdin.write.mock.calls.map(call => call[0].toString('utf8'));
    expect(allWrites[0]).toContain('"method":"initialize"');
    expect(allWrites.some(w => w.includes('"method":"initialized"'))).toBe(true);
  });

  test('request() resuelve con response id correcto', async () => {
    const { client, child } = await startFakeClient();
    const p = client.request('textDocument/hover', { x: 1 });
    await new Promise(r => setImmediate(r));
    // Próximo id es 2 (initialize usó 1)
    child.stdout.emit('data', frame({ jsonrpc: '2.0', id: 2, result: { contents: 'hola' } }));
    const result = await p;
    expect(result.contents).toBe('hola');
  });

  test('request() rechaza con timeout', async () => {
    const { client } = await startFakeClient({ timeoutMs: 30 });
    await expect(client.request('anything', {})).rejects.toThrow(/timeout/);
  });

  test('request() rechaza si response contiene error', async () => {
    const { client, child } = await startFakeClient();
    const p = client.request('x', {});
    await new Promise(r => setImmediate(r));
    child.stdout.emit('data', frame({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found' } }));
    await expect(p).rejects.toThrow(/Method not found/);
  });

  test('framing tolera múltiples mensajes en un chunk', async () => {
    const { client, child } = await startFakeClient();
    const p1 = client.request('a', {});
    const p2 = client.request('b', {});
    await new Promise(r => setImmediate(r));
    const combined = Buffer.concat([
      frame({ jsonrpc: '2.0', id: 2, result: 'R1' }),
      frame({ jsonrpc: '2.0', id: 3, result: 'R2' }),
    ]);
    child.stdout.emit('data', combined);
    expect(await p1).toBe('R1');
    expect(await p2).toBe('R2');
  });

  test('notify() escribe mensaje sin campo top-level id', async () => {
    const { client, child } = await startFakeClient();
    const callsBefore = child.stdin.write.mock.calls.length;
    client.notify('$/cancelRequest', { id: 99 });
    const write = child.stdin.write.mock.calls[callsBefore][0].toString('utf8');
    expect(write).toContain('"method":"$/cancelRequest"');
    // id sólo dentro de params, no top-level
    const bodyMatch = write.match(/\r\n\r\n(.+)$/s);
    const parsed = JSON.parse(bodyMatch[1]);
    expect(parsed.id).toBeUndefined();
    expect(parsed.params.id).toBe(99);
  });

  test('shutdown() envía shutdown + exit y mata el proceso', async () => {
    const { client, child } = await startFakeClient();
    const p = client.shutdown();
    await new Promise(r => setImmediate(r));
    child.stdout.emit('data', frame({ jsonrpc: '2.0', id: 2, result: null }));
    await p;
    expect(child.kill).toHaveBeenCalled();
    expect(client._child).toBeNull();
  });

  test('child exit rechaza pendientes', async () => {
    const { client, child } = await startFakeClient();
    const p = client.request('a', {});
    child.emit('exit', 1);
    await expect(p).rejects.toThrow(/exited|shutdown/);
  });

  test('didOpen es idempotente por URI', async () => {
    const { client, child } = await startFakeClient();
    const before = child.stdin.write.mock.calls.length;
    client.didOpen('file:///x.ts', 'typescript', 'content');
    client.didOpen('file:///x.ts', 'typescript', 'content');
    const after = child.stdin.write.mock.calls.length;
    expect(after - before).toBe(1);
  });
});
