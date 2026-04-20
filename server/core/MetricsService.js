'use strict';

/**
 * MetricsService — agregador de métricas in-memory con exportación Prometheus text format.
 *
 * Soporta counters, gauges e histograms con labels arbitrarios. No tiene side effects
 * (no escribe a disco, no abre sockets). Exportación via `renderPrometheus()` retorna
 * string listo para servir en `/api/metrics`.
 *
 * Flag `METRICS_ENABLED=false` (default) → métodos son no-op (counters no suben).
 * Permite mergear la fase con cero cambio observable; activable por env.
 *
 * Diseño consciente: sin dependencias externas (`prom-client` es 400KB). Los tipos
 * que usamos (counter + gauge + histogram simple) no justifican la dep.
 */

const DEFAULT_HISTOGRAM_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

function _labelKey(labels) {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  if (!keys.length) return '';
  return keys.map(k => `${k}="${_escape(String(labels[k]))}"`).join(',');
}

function _escape(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function _sanitize(name) {
  // Prometheus metric names: [a-zA-Z_:][a-zA-Z0-9_:]*
  return String(name).replace(/[^a-zA-Z0-9_:]/g, '_');
}

class MetricsService {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.enabled]              — default: lee METRICS_ENABLED env
   * @param {number[]} [opts.defaultBuckets]      — override de buckets default
   */
  constructor(opts = {}) {
    this._enabled = typeof opts.enabled === 'boolean'
      ? opts.enabled
      : process.env.METRICS_ENABLED !== 'false'; // default ON para instrumentación, OFF si se desea
    this._defaultBuckets = Array.isArray(opts.defaultBuckets) ? opts.defaultBuckets : DEFAULT_HISTOGRAM_BUCKETS;

    // metric name → { type, help, series: Map<labelKey, state> }
    this._metrics = new Map();

    this._startedAt = Date.now();
  }

  get enabled() { return this._enabled; }

  // ── Registro de metrics (help opcional) ────────────────────────────────

  registerCounter(name, help = '') {
    const m = _sanitize(name);
    if (!this._metrics.has(m)) {
      this._metrics.set(m, { type: 'counter', help, series: new Map() });
    }
  }

  registerGauge(name, help = '') {
    const m = _sanitize(name);
    if (!this._metrics.has(m)) {
      this._metrics.set(m, { type: 'gauge', help, series: new Map() });
    }
  }

  registerHistogram(name, help = '', buckets = null) {
    const m = _sanitize(name);
    if (!this._metrics.has(m)) {
      this._metrics.set(m, {
        type: 'histogram',
        help,
        buckets: Array.isArray(buckets) && buckets.length ? buckets : this._defaultBuckets,
        series: new Map(),
      });
    }
  }

  // ── Operaciones ────────────────────────────────────────────────────────

  /** Incrementa counter. Auto-registra si no existe. */
  inc(name, labels = null, value = 1) {
    if (!this._enabled) return;
    const m = _sanitize(name);
    if (!this._metrics.has(m)) this.registerCounter(m);
    const metric = this._metrics.get(m);
    if (metric.type !== 'counter') {
      // ignorar silenciosamente — en prod no queremos crashear por un inc mal tipado
      return;
    }
    const key = _labelKey(labels);
    const cur = metric.series.get(key) || { labels: labels || {}, value: 0 };
    cur.value += value;
    metric.series.set(key, cur);
  }

  /** Setea gauge. Auto-registra. */
  set(name, value, labels = null) {
    if (!this._enabled) return;
    const m = _sanitize(name);
    if (!this._metrics.has(m)) this.registerGauge(m);
    const metric = this._metrics.get(m);
    if (metric.type !== 'gauge') return;
    const key = _labelKey(labels);
    metric.series.set(key, { labels: labels || {}, value });
  }

  /** Observa valor en histograma. Auto-registra. */
  observe(name, value, labels = null) {
    if (!this._enabled) return;
    const m = _sanitize(name);
    if (!this._metrics.has(m)) this.registerHistogram(m);
    const metric = this._metrics.get(m);
    if (metric.type !== 'histogram') return;
    const key = _labelKey(labels);
    let state = metric.series.get(key);
    if (!state) {
      state = {
        labels: labels || {},
        count: 0,
        sum: 0,
        buckets: metric.buckets.map(b => ({ le: b, count: 0 })),
      };
      metric.series.set(key, state);
    }
    state.count++;
    state.sum += value;
    for (const b of state.buckets) {
      if (value <= b.le) b.count++;
    }
  }

  /** Timer helper: retorna fn que al llamarse observa la diferencia en segundos. */
  startTimer(name, labels = null) {
    if (!this._enabled) return () => {};
    const start = process.hrtime.bigint();
    return () => {
      const durationNs = Number(process.hrtime.bigint() - start);
      this.observe(name, durationNs / 1e9, labels);
    };
  }

  // ── Introspección ──────────────────────────────────────────────────────

  /** Snapshot JSON de todas las métricas (útil para tests y debug). */
  snapshot() {
    const out = {};
    for (const [name, m] of this._metrics) {
      out[name] = {
        type: m.type,
        help: m.help,
        ...(m.type === 'histogram' ? { buckets: m.buckets } : {}),
        series: Array.from(m.series.values()),
      };
    }
    return out;
  }

  reset() { this._metrics.clear(); }

  // ── Exportación Prometheus text format ─────────────────────────────────

  renderPrometheus() {
    const lines = [];
    for (const [name, m] of this._metrics) {
      if (m.help) lines.push(`# HELP ${name} ${m.help}`);
      lines.push(`# TYPE ${name} ${m.type}`);

      for (const state of m.series.values()) {
        const lblKey = _labelKey(state.labels);
        const lblPart = lblKey ? `{${lblKey}}` : '';
        if (m.type === 'counter' || m.type === 'gauge') {
          lines.push(`${name}${lblPart} ${state.value}`);
        } else if (m.type === 'histogram') {
          for (const b of state.buckets) {
            const bucketLabels = { ...state.labels, le: b.le };
            lines.push(`${name}_bucket{${_labelKey(bucketLabels)}} ${b.count}`);
          }
          const infLabels = { ...state.labels, le: '+Inf' };
          lines.push(`${name}_bucket{${_labelKey(infLabels)}} ${state.count}`);
          lines.push(`${name}_sum${lblPart} ${state.sum}`);
          lines.push(`${name}_count${lblPart} ${state.count}`);
        }
      }
    }
    // Uptime built-in
    lines.push('# HELP terminal_live_uptime_seconds Uptime del server en segundos');
    lines.push('# TYPE terminal_live_uptime_seconds gauge');
    lines.push(`terminal_live_uptime_seconds ${(Date.now() - this._startedAt) / 1000}`);
    return lines.join('\n') + '\n';
  }
}

MetricsService._internal = { _labelKey, _sanitize };
module.exports = MetricsService;
