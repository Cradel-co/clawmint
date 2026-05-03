'use strict';

const tools = require('../mcp/tools/cron');
const JobQuotaService = require('../core/JobQuotaService');
function byName(n) { return tools.find(t => t.name === n); }

function mkCtx(opts = {}) {
  const actions = new Map();
  let nextId = 1;
  const actionsRepo = {
    create: (a) => { const id = String(nextId++); const row = { id, ...a, status: 'active' }; actions.set(id, row); return row; },
    listByCreator: (userId) => Array.from(actions.values()).filter(r => r.creator_id === userId),
    getById: (id) => actions.get(String(id)) || null,
    remove: (id) => actions.delete(String(id)),
  };
  return {
    scheduler: { _actionsRepo: actionsRepo },
    jobQuotaService: new JobQuotaService({ getActiveCount: () => opts.activeCount || 0 }),
    usersRepo: {
      findByIdentity: () => opts.user ? { id: opts.user.id } : null,
      getById: (id) => opts.user && id === opts.user.id ? opts.user : null,
    },
    userId: opts.user ? opts.user.id : null,
    chatId: 'c1', channel: 'telegram', agentKey: 'claude',
    actions,
  };
}

describe('cron_create', () => {
  test('sin scheduler → error', () => {
    expect(byName('cron_create').execute({ cron_expr: '0 * * * *', label: 'x' }, {})).toMatch(/scheduler/);
  });

  test('cron_expr requerido', () => {
    const ctx = mkCtx({ user: { id: 'u1', role: 'user' } });
    expect(byName('cron_create').execute({ label: 'x' }, ctx)).toMatch(/cron_expr requerido/);
  });

  test('label requerido', () => {
    const ctx = mkCtx({ user: { id: 'u1', role: 'user' } });
    expect(byName('cron_create').execute({ cron_expr: '0 * * * *' }, ctx)).toMatch(/label requerido/);
  });

  test('userId no resuelto → error', () => {
    const ctx = mkCtx({});
    expect(byName('cron_create').execute({ cron_expr: '0 * * * *', label: 'x' }, ctx)).toMatch(/userId/);
  });

  test('cron < 60s sin admin → error por JobQuota', () => {
    const ctx = mkCtx({ user: { id: 'u1', role: 'user' } });
    const out = byName('cron_create').execute({ cron_expr: '*/30 * * * * *', label: 'x' }, ctx);
    expect(out).toMatch(/admin/);
  });

  test('cron válido crea entrada', () => {
    const ctx = mkCtx({ user: { id: 'u1', role: 'user' } });
    const out = byName('cron_create').execute({ cron_expr: '*/5 * * * *', label: 'mi cron' }, ctx);
    expect(out).toMatch(/Cron creado/);
    expect(ctx.actions.size).toBe(1);
  });

  test('cron < 60s con admin permitido', () => {
    const ctx = mkCtx({ user: { id: 'u1', role: 'admin' } });
    const out = byName('cron_create').execute({ cron_expr: '*/30 * * * * *', label: 'rápido' }, ctx);
    expect(out).toMatch(/Cron creado/);
  });
});

describe('cron_list', () => {
  test('sin crones → "(sin crons)"', () => {
    const ctx = mkCtx({ user: { id: 'u1', role: 'user' } });
    expect(byName('cron_list').execute({}, ctx)).toBe('(sin crons)');
  });

  test('lista crones del usuario', () => {
    const ctx = mkCtx({ user: { id: 'u1', role: 'user' } });
    byName('cron_create').execute({ cron_expr: '*/5 * * * *', label: 'A' }, ctx);
    byName('cron_create').execute({ cron_expr: '*/10 * * * *', label: 'B' }, ctx);
    const out = byName('cron_list').execute({}, ctx);
    expect(out).toMatch(/A/);
    expect(out).toMatch(/B/);
  });
});

describe('cron_delete', () => {
  test('id requerido', () => {
    const ctx = mkCtx({ user: { id: 'u1', role: 'user' } });
    expect(byName('cron_delete').execute({}, ctx)).toMatch(/id requerido/);
  });

  test('cron de otro usuario → rechazo', () => {
    const ctxOwner = mkCtx({ user: { id: 'owner', role: 'user' } });
    byName('cron_create').execute({ cron_expr: '*/5 * * * *', label: 'A' }, ctxOwner);
    const cronId = Array.from(ctxOwner.actions.keys())[0];

    const ctxIntruder = {
      scheduler: ctxOwner.scheduler,
      jobQuotaService: ctxOwner.jobQuotaService,
      usersRepo: { findByIdentity: () => ({ id: 'other' }), getById: () => ({ id: 'other', role: 'user' }) },
      userId: 'other', chatId: 'c2', channel: 'telegram',
    };
    expect(byName('cron_delete').execute({ id: cronId }, ctxIntruder)).toMatch(/no sos dueño/);
  });

  test('dueño puede eliminar', () => {
    const ctx = mkCtx({ user: { id: 'u1', role: 'user' } });
    byName('cron_create').execute({ cron_expr: '*/5 * * * *', label: 'A' }, ctx);
    const cronId = Array.from(ctx.actions.keys())[0];
    expect(byName('cron_delete').execute({ id: cronId }, ctx)).toMatch(/Eliminado/);
    expect(ctx.actions.size).toBe(0);
  });

  test('admin puede eliminar crones ajenos', () => {
    const ctxOwner = mkCtx({ user: { id: 'owner', role: 'user' } });
    byName('cron_create').execute({ cron_expr: '*/5 * * * *', label: 'A' }, ctxOwner);
    const cronId = Array.from(ctxOwner.actions.keys())[0];

    const ctxAdmin = {
      scheduler: ctxOwner.scheduler,
      jobQuotaService: ctxOwner.jobQuotaService,
      usersRepo: { findByIdentity: () => ({ id: 'admin1' }), getById: () => ({ id: 'admin1', role: 'admin' }) },
      userId: 'admin1', chatId: 'c3', channel: 'telegram',
    };
    expect(byName('cron_delete').execute({ id: cronId }, ctxAdmin)).toMatch(/Eliminado/);
  });
});
