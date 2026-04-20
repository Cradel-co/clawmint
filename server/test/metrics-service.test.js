'use strict';

const MetricsService = require('../core/MetricsService');

describe('MetricsService — flag enabled', () => {
  test('enabled=false → inc/set/observe son no-op', () => {
    const m = new MetricsService({ enabled: false });
    m.inc('foo', { bar: 1 });
    m.set('baz', 42);
    m.observe('qux', 0.5);
    const snap = m.snapshot();
    expect(Object.keys(snap)).toEqual([]);
  });

  test('enabled=true → operations funcionan', () => {
    const m = new MetricsService({ enabled: true });
    m.inc('foo');
    expect(m.snapshot().foo.series[0].value).toBe(1);
  });

  test('lee METRICS_ENABLED env por default', () => {
    const orig = process.env.METRICS_ENABLED;
    process.env.METRICS_ENABLED = 'false';
    const m = new MetricsService();
    expect(m.enabled).toBe(false);
    if (orig === undefined) delete process.env.METRICS_ENABLED;
    else process.env.METRICS_ENABLED = orig;
  });
});

describe('MetricsService — counters', () => {
  let m;
  beforeEach(() => { m = new MetricsService({ enabled: true }); });

  test('inc sin labels incrementa 1 por default', () => {
    m.inc('requests');
    m.inc('requests');
    m.inc('requests');
    expect(m.snapshot().requests.series[0].value).toBe(3);
  });

  test('inc con labels mantiene series separadas', () => {
    m.inc('requests', { method: 'GET' });
    m.inc('requests', { method: 'GET' });
    m.inc('requests', { method: 'POST' });
    const series = m.snapshot().requests.series;
    expect(series).toHaveLength(2);
    const get = series.find(s => s.labels.method === 'GET');
    const post = series.find(s => s.labels.method === 'POST');
    expect(get.value).toBe(2);
    expect(post.value).toBe(1);
  });

  test('inc con value custom', () => {
    m.inc('bytes', null, 1024);
    m.inc('bytes', null, 512);
    expect(m.snapshot().bytes.series[0].value).toBe(1536);
  });

  test('sanitiza nombre con caracteres inválidos', () => {
    m.inc('req-per.sec');
    expect(m.snapshot()['req_per_sec']).toBeDefined();
  });
});

describe('MetricsService — gauges', () => {
  test('set reemplaza el valor anterior (no acumula)', () => {
    const m = new MetricsService({ enabled: true });
    m.set('active_connections', 10);
    m.set('active_connections', 7);
    expect(m.snapshot().active_connections.series[0].value).toBe(7);
  });
});

describe('MetricsService — histograms', () => {
  test('observe acumula count, sum y buckets', () => {
    const m = new MetricsService({ enabled: true });
    m.registerHistogram('latency_s', 'latency', [0.1, 1, 10]);
    m.observe('latency_s', 0.05);
    m.observe('latency_s', 0.5);
    m.observe('latency_s', 5);
    const s = m.snapshot().latency_s.series[0];
    expect(s.count).toBe(3);
    expect(s.sum).toBeCloseTo(5.55);
    expect(s.buckets).toEqual([
      { le: 0.1, count: 1 },
      { le: 1,   count: 2 },
      { le: 10,  count: 3 },
    ]);
  });
});

describe('MetricsService — startTimer', () => {
  test('timer mide duración observada', async () => {
    const m = new MetricsService({ enabled: true });
    m.registerHistogram('op_duration_s', '', [0.001, 0.01, 0.1, 1]);
    const end = m.startTimer('op_duration_s', { op: 'test' });
    await new Promise(r => setTimeout(r, 20));
    end();
    const s = m.snapshot().op_duration_s.series[0];
    expect(s.count).toBe(1);
    expect(s.sum).toBeGreaterThan(0.01);
    expect(s.sum).toBeLessThan(0.5);
  });

  test('startTimer con metrics disabled → noop', () => {
    const m = new MetricsService({ enabled: false });
    const end = m.startTimer('x');
    expect(typeof end).toBe('function');
    end();
    expect(m.snapshot()).toEqual({});
  });
});

describe('MetricsService — renderPrometheus', () => {
  test('incluye HELP, TYPE, y series con labels', () => {
    const m = new MetricsService({ enabled: true });
    m.registerCounter('http_requests_total', 'Total HTTP requests');
    m.inc('http_requests_total', { method: 'GET', status: '200' });
    m.inc('http_requests_total', { method: 'GET', status: '200' });
    m.inc('http_requests_total', { method: 'POST', status: '500' });

    const out = m.renderPrometheus();
    expect(out).toMatch(/# HELP http_requests_total Total HTTP requests/);
    expect(out).toMatch(/# TYPE http_requests_total counter/);
    expect(out).toMatch(/http_requests_total\{method="GET",status="200"\} 2/);
    expect(out).toMatch(/http_requests_total\{method="POST",status="500"\} 1/);
  });

  test('histograma exporta buckets + sum + count', () => {
    const m = new MetricsService({ enabled: true });
    m.registerHistogram('dur', 'dur', [0.1, 1]);
    m.observe('dur', 0.5);
    const out = m.renderPrometheus();
    expect(out).toMatch(/dur_bucket\{le="0.1"\} 0/);
    expect(out).toMatch(/dur_bucket\{le="1"\} 1/);
    expect(out).toMatch(/dur_bucket\{le="\+Inf"\} 1/);
    expect(out).toMatch(/dur_sum 0\.5/);
    expect(out).toMatch(/dur_count 1/);
  });

  test('siempre incluye uptime built-in', () => {
    const m = new MetricsService({ enabled: true });
    const out = m.renderPrometheus();
    expect(out).toMatch(/terminal_live_uptime_seconds/);
  });

  test('escapa comillas y backslashes en labels', () => {
    const m = new MetricsService({ enabled: true });
    m.inc('x', { err: 'he said "hi"' });
    const out = m.renderPrometheus();
    expect(out).toMatch(/err="he said \\"hi\\""/);
  });
});

describe('MetricsService — reset', () => {
  test('reset() limpia todo', () => {
    const m = new MetricsService({ enabled: true });
    m.inc('x');
    m.set('y', 5);
    m.reset();
    expect(m.snapshot()).toEqual({});
  });
});
