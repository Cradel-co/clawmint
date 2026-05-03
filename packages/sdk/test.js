'use strict';

/**
 * Smoke test básico — se corre vía `npm test` y `npm publish` (prepublishOnly).
 * Usa sólo primitivos Node, sin jest, para no exigir deps al consumer.
 */

const assert = require('assert');
const { createClawmintClient } = require('./index');

function fakeFetchOK(body, contentType = 'application/json') {
  return async () => ({
    ok: true, status: 200,
    headers: { get: () => contentType },
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function run() {
  // 1) Factory throwea sin baseUrl
  try { createClawmintClient({}); assert.fail('should throw'); }
  catch (err) { assert.match(err.message, /baseUrl/); }

  // 2) Client básico funciona con fetch mock
  const client = createClawmintClient({
    baseUrl: 'http://srv', apiKey: 'k123',
    fetchImpl: fakeFetchOK([{ id: 's1' }]),
  });
  const list = await client.sessions.list();
  assert.deepStrictEqual(list, [{ id: 's1' }]);

  // 3) Build correcto de path + body
  let captured;
  const spyFetch = async (url, opts) => { captured = { url, opts }; return (await fakeFetchOK({ ok: true })()); };
  const c2 = createClawmintClient({ baseUrl: 'http://srv', fetchImpl: spyFetch });
  await c2.sessions.sendMessage('s1', { text: 'hola' });
  assert.strictEqual(captured.url, 'http://srv/api/sessions/s1/message');
  assert.strictEqual(captured.opts.method, 'POST');

  // 4) Session sharing
  await c2.sessions.share('s1', { ttlHours: 2 });
  assert.strictEqual(captured.url, 'http://srv/api/sessions/s1/share');

  // 5) Preferences
  await c2.preferences.set('keybindings', { cmd: 'x' });
  assert.strictEqual(captured.url, 'http://srv/api/user-preferences/keybindings');
  assert.strictEqual(captured.opts.method, 'PUT');

  console.log('✓ @clawmint/sdk smoke tests pasaron');
}

run().catch(err => { console.error('✗', err); process.exit(1); });
