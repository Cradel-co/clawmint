# @clawmint/sdk

Cliente oficial para integrar con el server de [Clawmint](https://github.com/bpadilla/clawmint).

```bash
npm install @clawmint/sdk
```

## Uso

```js
const { createClawmintClient } = require('@clawmint/sdk');

const client = createClawmintClient({
  baseUrl: 'http://localhost:3001',
  apiKey:  process.env.CLAWMINT_API_KEY,   // JWT emitido por /api/auth
});

// Crear sesión + mandar mensaje
const session = await client.sessions.create({ agentKey: 'claude' });
await client.sessions.sendMessage(session.id, { text: 'hola' });

// Stream de eventos (WebSocket)
for await (const event of client.sessions.subscribe(session.id)) {
  console.log(event);
}
```

## Entornos soportados

- Node >= 18 (fetch global y WebSocket global vía [undici](https://github.com/nodejs/undici)).
- Browsers modernos (fetch + WebSocket nativos).
- Node 16/17 requiere polyfills: pasarlos via `fetchImpl` y `WebSocketImpl`.

```js
const { createClawmintClient } = require('@clawmint/sdk');
const { fetch } = require('undici');
const WebSocket = require('ws');

const client = createClawmintClient({
  baseUrl: 'http://localhost:3001',
  apiKey:  'xyz',
  fetchImpl: fetch,
  WebSocketImpl: WebSocket,
});
```

## API

### sessions

```ts
client.sessions.create({ agentKey, userId? })  // → Session
client.sessions.get(id)                         // → Session
client.sessions.list()                          // → Session[]
client.sessions.remove(id)                      // → ok
client.sessions.sendMessage(id, { text })       // → ok
client.sessions.subscribe(id)                   // → AsyncIterable<Event>, `.close()` para detener

// Session sharing multi-device (Fase 12.4)
client.sessions.share(id, { ttlHours?, permissions? })  // → { token, expires_at, ... }
client.sessions.getShare(token)                         // → { session_id, permissions, ... }
client.sessions.revokeShare(token)                      // → ok
client.sessions.listShares()                            // → SessionShare[]
```

### agents

```ts
client.agents.list()    // → Agent[]
client.agents.get(key)  // → Agent
```

### memory

```ts
client.memory.list({ scope, scope_id })         // → MemoryEntry[]
client.memory.save({ content, scope, scope_id }) // → MemoryEntry
```

### preferences (per-user)

```ts
client.preferences.list()                       // → all prefs
client.preferences.get('keybindings')           // → { key, value }
client.preferences.set('keybindings', {...})    // → { key, value }
client.preferences.remove('keybindings')        // → ok
```

### Escape hatch

```ts
client.raw.request('POST', '/api/custom', { body })
```

## Tipos

El paquete incluye `index.d.ts` con tipos completos para TypeScript.

## Licencia

MIT
