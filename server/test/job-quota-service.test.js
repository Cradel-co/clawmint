'use strict';

const JobQuotaService = require('../core/JobQuotaService');

describe('JobQuotaService — canCreate', () => {
  test('userId requerido', () => {
    const s = new JobQuotaService();
    expect(s.canCreate({}).allowed).toBe(false);
  });

  test('cron válido intervalo >=60s permitido', () => {
    const s = new JobQuotaService({ getActiveCount: () => 0 });
    expect(s.canCreate({ userId: 'u1', cronExpr: '*/5 * * * *' }).allowed).toBe(true);
  });

  test('cron < 60s requiere admin', () => {
    const s = new JobQuotaService({ getActiveCount: () => 0 });
    const r = s.canCreate({ userId: 'u1', cronExpr: '*/30 * * * * *', isAdmin: false });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/admin/);
  });

  test('cron < 60s con admin permitido', () => {
    const s = new JobQuotaService({ getActiveCount: () => 0 });
    expect(s.canCreate({ userId: 'u1', cronExpr: '*/30 * * * * *', isAdmin: true }).allowed).toBe(true);
  });

  test('cuota de activos excedida', () => {
    const s = new JobQuotaService({ getActiveCount: () => 10 });
    const r = s.canCreate({ userId: 'u1', cronExpr: '0 * * * *' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/activos/);
  });

  test('cron expr malformado (pocos campos) — pasa (no se estima intervalo)', () => {
    const s = new JobQuotaService({ getActiveCount: () => 0 });
    expect(s.canCreate({ userId: 'u1', cronExpr: '* *' }).allowed).toBe(true);
  });
});

describe('JobQuotaService — recordInvocation', () => {
  test('dentro de cuota horaria', () => {
    const s = new JobQuotaService();
    for (let i = 0; i < 10; i++) {
      expect(s.recordInvocation('u1').allowed).toBe(true);
    }
    expect(s.getInvocationsLastHour('u1')).toBe(10);
  });

  test('excede cuota horaria', () => {
    const s = new JobQuotaService();
    // Por default max=60; saturar
    for (let i = 0; i < 60; i++) s.recordInvocation('u1');
    const r = s.recordInvocation('u1');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/cuota horaria/);
  });

  test('ventanas rolling por usuario', () => {
    const s = new JobQuotaService();
    s.recordInvocation('u1');
    s.recordInvocation('u2');
    expect(s.getInvocationsLastHour('u1')).toBe(1);
    expect(s.getInvocationsLastHour('u2')).toBe(1);
  });

  test('userId requerido', () => {
    const s = new JobQuotaService();
    expect(s.recordInvocation(null).allowed).toBe(false);
  });
});

describe('JobQuotaService — _estimateMinInterval', () => {
  test('5-field "* * * * *" → 60s', () => {
    expect(new JobQuotaService()._estimateMinInterval('* * * * *')).toBe(60);
  });

  test('5-field "*/5 * * * *" → 300s', () => {
    expect(new JobQuotaService()._estimateMinInterval('*/5 * * * *')).toBe(300);
  });

  test('6-field con segundos "* * * * * *" → 1s', () => {
    expect(new JobQuotaService()._estimateMinInterval('* * * * * *')).toBe(1);
  });

  test('6-field "*/30 * * * * *" → 30s', () => {
    expect(new JobQuotaService()._estimateMinInterval('*/30 * * * * *')).toBe(30);
  });

  test('hora específica "0 9 * * *" → null (no se puede estimar)', () => {
    expect(new JobQuotaService()._estimateMinInterval('0 9 * * *')).toBeNull();
  });
});
