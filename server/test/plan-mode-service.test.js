'use strict';

const EventBus = require('../core/EventBus');
const PlanModeService = require('../core/PlanModeService');
const planModeTools = require('../mcp/tools/planMode');

function byName(n) { return planModeTools.find(t => t.name === n); }

describe('PlanModeService', () => {
  test('enter/exit/isActive', () => {
    const svc = new PlanModeService();
    expect(svc.isActive('c1')).toBe(false);
    svc.enter('c1');
    expect(svc.isActive('c1')).toBe(true);
    expect(svc.exit('c1')).toBe(true);
    expect(svc.isActive('c1')).toBe(false);
    expect(svc.exit('c1')).toBe(false);
    svc.shutdown();
  });

  test('list devuelve chats activos', () => {
    const svc = new PlanModeService();
    svc.enter('c1', 'investigación');
    svc.enter('c2');
    const list = svc.list();
    expect(list).toHaveLength(2);
    const c1 = list.find(e => e.chatId === 'c1');
    expect(c1.reason).toBe('investigación');
    svc.shutdown();
  });

  test('enter renueva timer si ya estaba activo', () => {
    const svc = new PlanModeService();
    svc.enter('c1');
    const before = svc._active.get('c1').enteredAt;
    setTimeout(() => {
      svc.enter('c1');
      const after = svc._active.get('c1').enteredAt;
      expect(after).toBeGreaterThanOrEqual(before);
      svc.shutdown();
    }, 5);
  });

  test('auto-exit tras timeout + evento plan_mode:timeout', (done) => {
    const bus = new EventBus();
    const events = [];
    bus.on('plan_mode:timeout', (p) => events.push(p));
    const svc = new PlanModeService({ eventBus: bus, autoExitMs: 30, logger: { info: () => {} } });
    svc.enter('c1');
    setTimeout(() => {
      expect(svc.isActive('c1')).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0].chatId).toBe('c1');
      svc.shutdown();
      done();
    }, 50);
  });

  test('emite plan_mode:enter y plan_mode:exit', () => {
    const bus = new EventBus();
    const events = [];
    ['plan_mode:enter', 'plan_mode:exit'].forEach(e => bus.on(e, (p) => events.push({ name: e, p })));
    const svc = new PlanModeService({ eventBus: bus });
    svc.enter('c1', 'test');
    svc.exit('c1');
    expect(events).toHaveLength(2);
    expect(events[0].name).toBe('plan_mode:enter');
    expect(events[1].name).toBe('plan_mode:exit');
    expect(events[1].p.durationMs).toBeGreaterThanOrEqual(0);
    svc.shutdown();
  });

  test('touch extiende el timeout', () => {
    const svc = new PlanModeService({ autoExitMs: 50 });
    svc.enter('c1');
    expect(svc.touch('c1')).toBe(true);
    expect(svc.touch('c_inexistente')).toBe(false);
    svc.shutdown();
  });
});

describe('enter_plan_mode tool', () => {
  test('sin planModeService → error', () => {
    expect(byName('enter_plan_mode').execute({}, { chatId: 'c1' })).toMatch(/no disponible/);
  });

  test('sin chatId → error', () => {
    const svc = new PlanModeService();
    expect(byName('enter_plan_mode').execute({}, { planModeService: svc })).toMatch(/chatId/);
    svc.shutdown();
  });

  test('activa plan mode con chatId', () => {
    const svc = new PlanModeService();
    const out = byName('enter_plan_mode').execute({ reason: 'test' }, { planModeService: svc, chatId: 'c1' });
    expect(out).toMatch(/Plan mode activo/);
    expect(svc.isActive('c1')).toBe(true);
    svc.shutdown();
  });
});

describe('exit_plan_mode tool', () => {
  test('desactiva plan mode', () => {
    const svc = new PlanModeService();
    svc.enter('c1');
    const out = byName('exit_plan_mode').execute({}, { planModeService: svc, chatId: 'c1' });
    expect(out).toMatch(/desactivado/);
    expect(svc.isActive('c1')).toBe(false);
    svc.shutdown();
  });

  test('si no estaba activo devuelve mensaje neutro', () => {
    const svc = new PlanModeService();
    const out = byName('exit_plan_mode').execute({}, { planModeService: svc, chatId: 'c1' });
    expect(out).toMatch(/No estaba/);
    svc.shutdown();
  });
});
