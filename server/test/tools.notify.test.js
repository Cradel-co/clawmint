'use strict';

const EventBus = require('../core/EventBus');
const tools = require('../mcp/tools/notify');
const { _isQuietHour } = tools._internal;

function byName(n) { return tools.find(t => t.name === n); }

describe('push_notification', () => {
  test('title requerido', () => {
    const bus = new EventBus();
    expect(byName('push_notification').execute({ body: 'x' }, { eventBus: bus })).toMatch(/title requerido/);
  });

  test('body requerido', () => {
    const bus = new EventBus();
    expect(byName('push_notification').execute({ title: 'x' }, { eventBus: bus })).toMatch(/body requerido/);
  });

  test('sin eventBus → error', () => {
    expect(byName('push_notification').execute({ title: 'x', body: 'y' }, {})).toMatch(/eventBus/);
  });

  test('urgent=true emite evento', () => {
    const bus = new EventBus();
    const events = [];
    bus.on('notification:push', (p) => events.push(p));
    const out = byName('push_notification').execute(
      { title: 'Alerta', body: 'detalle', urgent: true },
      { eventBus: bus, chatId: 'c1', agentKey: 'claude' }
    );
    expect(out).toMatch(/Notificación enviada/);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Alerta');
    expect(events[0].urgent).toBe(true);
  });

  test('trunca title a 200 y body a 2000', () => {
    const bus = new EventBus();
    const events = [];
    bus.on('notification:push', (p) => events.push(p));
    byName('push_notification').execute(
      { title: 'x'.repeat(500), body: 'y'.repeat(5000), urgent: true },
      { eventBus: bus }
    );
    expect(events[0].title.length).toBe(200);
    expect(events[0].body.length).toBe(2000);
  });

  test('_isQuietHour detecta rango wrap 22-8', () => {
    expect(_isQuietHour(new Date('2026-04-18T23:00:00'))).toBe(true);
    expect(_isQuietHour(new Date('2026-04-18T07:00:00'))).toBe(true);
    expect(_isQuietHour(new Date('2026-04-18T12:00:00'))).toBe(false);
  });
});
