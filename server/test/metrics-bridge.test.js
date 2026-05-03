'use strict';

const EventBus        = require('../core/EventBus');
const MetricsService  = require('../core/MetricsService');
const MetricsBridge   = require('../core/MetricsBridge');

function mkBridge() {
  const bus = new EventBus();
  const svc = new MetricsService({ enabled: true });
  const br = new MetricsBridge({ eventBus: bus, metricsService: svc, logger: { info: () => {}, warn: () => {}, error: () => {} } });
  br.install();
  return { bus, svc, br };
}

describe('MetricsBridge — construcción', () => {
  test('throw si faltan deps', () => {
    expect(() => new MetricsBridge({})).toThrow(/eventBus/);
    expect(() => new MetricsBridge({ eventBus: new EventBus() })).toThrow(/metricsService/);
  });
});

describe('MetricsBridge — loop events', () => {
  test('loop:start incrementa loop_started_total', () => {
    const { bus, svc } = mkBridge();
    bus.emit('loop:start', { chatId: 'c1', provider: 'anthropic', attempt: 0 });
    bus.emit('loop:start', { chatId: 'c2', provider: 'anthropic', attempt: 0 });
    const snap = svc.snapshot();
    const total = snap.loop_started_total.series.reduce((sum, s) => sum + s.value, 0);
    expect(total).toBe(2);
  });

  test('loop:tool_call label por tool', () => {
    const { bus, svc } = mkBridge();
    bus.emit('loop:tool_call', { name: 'grep', args: {} });
    bus.emit('loop:tool_call', { name: 'grep', args: {} });
    bus.emit('loop:tool_call', { name: 'bash', args: {} });
    const series = svc.snapshot().loop_tool_calls_total.series;
    const grep = series.find(s => s.labels.tool === 'grep');
    const bash = series.find(s => s.labels.tool === 'bash');
    expect(grep.value).toBe(2);
    expect(bash.value).toBe(1);
  });

  test('loop:retry label por reason', () => {
    const { bus, svc } = mkBridge();
    bus.emit('loop:retry', { attempt: 1, delayMs: 1000, reason: 'transient:rate_limit' });
    bus.emit('loop:retry', { attempt: 2, delayMs: 2000, reason: 'transient:timeout' });
    bus.emit('loop:retry', { attempt: 1, delayMs: 1000, reason: 'transient:rate_limit' });
    const series = svc.snapshot().loop_retries_total.series;
    expect(series.find(s => s.labels.reason === 'transient:rate_limit').value).toBe(2);
    expect(series.find(s => s.labels.reason === 'transient:timeout').value).toBe(1);
  });

  test('loop:cancel label por reason', () => {
    const { bus, svc } = mkBridge();
    bus.emit('loop:cancel', { reason: 'timeout' });
    bus.emit('loop:cancel', { reason: 'signal' });
    const series = svc.snapshot().loop_cancels_total.series;
    expect(series).toHaveLength(2);
  });

  test('loop:loop_detected incrementa con label por tool', () => {
    const { bus, svc } = mkBridge();
    bus.emit('loop:loop_detected', { toolName: 'grep', consecutiveCount: 3 });
    expect(svc.snapshot().loop_loop_detected_total.series[0].labels.tool).toBe('grep');
  });

  test('loop:callback_error incrementa con label por callback', () => {
    const { bus, svc } = mkBridge();
    bus.emit('loop:callback_error', { callback: 'onChunk', error: 'boom' });
    expect(svc.snapshot().loop_callback_errors_total.series[0].labels.callback).toBe('onChunk');
  });

  test('start → done mide duración en histograma', async () => {
    const { bus, svc } = mkBridge();
    bus.emit('loop:start', { chatId: 'c1', provider: 'anthropic', attempt: 0 });
    await new Promise(r => setTimeout(r, 30));
    bus.emit('loop:done', { chatId: 'c1', fullText: 'ok', stopReason: 'end_turn' });
    const series = svc.snapshot().loop_duration_seconds.series;
    expect(series).toHaveLength(1);
    expect(series[0].count).toBe(1);
    expect(series[0].sum).toBeGreaterThan(0.01);
  });

  test('loop:tool_result con durationMs observa histograma', () => {
    const { bus, svc } = mkBridge();
    bus.emit('loop:tool_result', { name: 'grep', result: 'x', durationMs: 150 });
    const series = svc.snapshot().loop_tool_duration_seconds.series;
    expect(series[0].count).toBe(1);
    expect(series[0].sum).toBeCloseTo(0.15);
  });
});

describe('MetricsBridge — orchestration events', () => {
  test('start → done mide duración', async () => {
    const { bus, svc } = mkBridge();
    bus.emit('orchestration:start', { workflowId: 'wf1', coordinator: 'coord' });
    await new Promise(r => setTimeout(r, 15));
    bus.emit('orchestration:done', { workflowId: 'wf1', taskCount: 2 });
    const dur = svc.snapshot().orchestration_workflow_duration_seconds.series;
    expect(dur).toHaveLength(1);
    expect(dur[0].count).toBe(1);
  });

  test('orchestration:task incrementa con labels status+agent', () => {
    const { bus, svc } = mkBridge();
    bus.emit('orchestration:task', { workflowId: 'wf1', taskId: 't1', agent: 'claude', status: 'running' });
    bus.emit('orchestration:task', { workflowId: 'wf1', taskId: 't1', agent: 'claude', status: 'done' });
    const series = svc.snapshot().orchestration_tasks_total.series;
    expect(series).toHaveLength(2);
    expect(series.find(s => s.labels.status === 'done').value).toBe(1);
  });
});

describe('MetricsBridge — skill events', () => {
  test('skill:invoked incrementa con label slug', () => {
    const { bus, svc } = mkBridge();
    bus.emit('skill:invoked', { slug: 'review' });
    bus.emit('skill:invoked', { slug: 'review' });
    bus.emit('skill:invoked', { slug: 'security' });
    const series = svc.snapshot().skills_invoked_total.series;
    expect(series.find(s => s.labels.slug === 'review').value).toBe(2);
    expect(series.find(s => s.labels.slug === 'security').value).toBe(1);
  });
});

describe('MetricsBridge — Fase 7.5.10 (token economy events)', () => {
  test('compact:applied incrementa compact_applied_total', () => {
    const { bus, svc } = mkBridge();
    bus.emit('compact:applied', { compactor: 'MicroCompactor', before: 50, after: 20 });
    bus.emit('compact:applied', { compactor: 'MicroCompactor' });
    const series = svc.snapshot().compact_applied_total.series;
    expect(series[0].value).toBe(2);
    expect(series[0].labels.compactor).toBe('MicroCompactor');
  });

  test('compact:circuit_open incrementa counter', () => {
    const { bus, svc } = mkBridge();
    bus.emit('compact:circuit_open', { chatId: 'cX' });
    expect(svc.snapshot().compact_circuit_open_total.series[0].value).toBe(1);
  });

  test('cache:miss label por provider', () => {
    const { bus, svc } = mkBridge();
    bus.emit('cache:miss', { provider: 'anthropic' });
    bus.emit('cache:miss', { provider: 'anthropic' });
    bus.emit('cache:miss', { provider: 'openai' });
    const series = svc.snapshot().cache_miss_total.series;
    expect(series.find(s => s.labels.provider === 'anthropic').value).toBe(2);
  });

  test('cache:stats con read observa histograma', () => {
    const { bus, svc } = mkBridge();
    bus.emit('cache:stats', { read: 5000 });
    expect(svc.snapshot().cache_read_tokens.series[0].count).toBe(1);
    expect(svc.snapshot().cache_read_tokens.series[0].sum).toBe(5000);
  });

  test('plan_mode:enter y plan_mode:exit (manual) + plan_mode:timeout', () => {
    const { bus, svc } = mkBridge();
    bus.emit('plan_mode:enter', { chatId: 'c1' });
    bus.emit('plan_mode:exit', { chatId: 'c1' });
    bus.emit('plan_mode:timeout', { chatId: 'c2' });
    expect(svc.snapshot().plan_mode_enter_total.series[0].value).toBe(1);
    const exitSeries = svc.snapshot().plan_mode_exit_total.series;
    expect(exitSeries.find(s => s.labels.reason === 'manual').value).toBe(1);
    expect(exitSeries.find(s => s.labels.reason === 'timeout').value).toBe(1);
  });

  test('notification:push counter con labels channel+urgent', () => {
    const { bus, svc } = mkBridge();
    bus.emit('notification:push', { channel: 'telegram', urgent: false });
    bus.emit('notification:push', { channel: 'telegram', urgent: true });
    const series = svc.snapshot().notifications_push_total.series;
    expect(series).toHaveLength(2);
    expect(series.find(s => s.labels.urgent === 'true').value).toBe(1);
  });
});

describe('MetricsBridge — robustez', () => {
  test('handler que throwea no propaga', () => {
    const bus = new EventBus();
    // Servicio defectuoso que throwea
    const brokenSvc = {
      enabled: true,
      registerCounter: () => {}, registerGauge: () => {}, registerHistogram: () => {},
      inc: () => { throw new Error('boom'); },
      set: () => {}, observe: () => {},
    };
    const br = new MetricsBridge({ eventBus: bus, metricsService: brokenSvc, logger: { info: () => {}, warn: () => {}, error: () => {} } });
    br.install();
    expect(() => bus.emit('loop:start', { chatId: 'c1' })).not.toThrow();
  });

  test('uninstall() remueve listeners', () => {
    const { bus, svc, br } = mkBridge();
    br.uninstall();
    bus.emit('loop:start', { chatId: 'c1', provider: 'x' });
    expect(svc.snapshot().loop_started_total.series).toHaveLength(0);
  });

  test('metrics.enabled=false → registros vacíos de series aunque los metrics estén declarados', () => {
    const bus = new EventBus();
    const svc = new MetricsService({ enabled: false });
    const br = new MetricsBridge({ eventBus: bus, metricsService: svc, logger: { info: () => {}, warn: () => {}, error: () => {} } });
    br.install();
    bus.emit('loop:start', { chatId: 'c1', provider: 'x' });
    // Metrics registradas con HELP/TYPE pero sin series (inc es no-op)
    const snap = svc.snapshot();
    expect(snap.loop_started_total).toBeDefined();
    expect(snap.loop_started_total.series).toHaveLength(0);
  });
});
