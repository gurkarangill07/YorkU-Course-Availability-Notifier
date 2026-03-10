const DEFAULT_HISTOGRAM_BUCKETS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000
];

function sanitizeMetricName(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return normalized || "metric";
}

function sanitizeHelp(value) {
  return String(value || "").trim() || "No help provided.";
}

function coerceFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

class MetricsRegistry {
  constructor({ prefix = "coursenotif" } = {}) {
    this.prefix = sanitizeMetricName(prefix);
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
  }

  buildMetricName(name) {
    return `${this.prefix}_${sanitizeMetricName(name)}`;
  }

  increment(name, value = 1, help = "Counter metric.") {
    const metricName = this.buildMetricName(name);
    const delta = coerceFiniteNumber(value, 0);
    const existing = this.counters.get(metricName) || {
      help: sanitizeHelp(help),
      value: 0
    };
    existing.value += delta;
    this.counters.set(metricName, existing);
    return existing.value;
  }

  setGauge(name, value, help = "Gauge metric.") {
    const metricName = this.buildMetricName(name);
    const numericValue = coerceFiniteNumber(value, 0);
    this.gauges.set(metricName, {
      help: sanitizeHelp(help),
      value: numericValue
    });
    return numericValue;
  }

  observeHistogram(
    name,
    value,
    { help = "Histogram metric.", buckets = DEFAULT_HISTOGRAM_BUCKETS } = {}
  ) {
    const metricName = this.buildMetricName(name);
    const numericValue = coerceFiniteNumber(value, NaN);
    if (!Number.isFinite(numericValue)) {
      return null;
    }

    const sortedBuckets = Array.from(
      new Set(
        (Array.isArray(buckets) ? buckets : DEFAULT_HISTOGRAM_BUCKETS)
          .map((entry) => coerceFiniteNumber(entry, NaN))
          .filter((entry) => Number.isFinite(entry) && entry > 0)
      )
    ).sort((left, right) => left - right);

    const existing = this.histograms.get(metricName) || {
      help: sanitizeHelp(help),
      buckets: sortedBuckets,
      bucketCounts: new Array(sortedBuckets.length).fill(0),
      count: 0,
      sum: 0
    };

    if (existing.buckets.join(",") !== sortedBuckets.join(",")) {
      existing.buckets = sortedBuckets;
      existing.bucketCounts = new Array(sortedBuckets.length).fill(0);
      existing.count = 0;
      existing.sum = 0;
    }

    existing.count += 1;
    existing.sum += numericValue;

    for (let idx = 0; idx < existing.buckets.length; idx += 1) {
      if (numericValue <= existing.buckets[idx]) {
        existing.bucketCounts[idx] += 1;
      }
    }

    this.histograms.set(metricName, existing);
    return {
      count: existing.count,
      sum: existing.sum
    };
  }

  snapshot() {
    const counters = {};
    for (const [name, metric] of this.counters.entries()) {
      counters[name] = metric.value;
    }

    const gauges = {};
    for (const [name, metric] of this.gauges.entries()) {
      gauges[name] = metric.value;
    }

    const histograms = {};
    for (const [name, metric] of this.histograms.entries()) {
      histograms[name] = {
        count: metric.count,
        sum: metric.sum,
        buckets: metric.buckets.map((bucket, index) => ({
          le: bucket,
          value: metric.bucketCounts[index]
        }))
      };
    }

    return {
      counters,
      gauges,
      histograms
    };
  }

  renderPrometheus() {
    const lines = [];

    for (const [name, metric] of this.counters.entries()) {
      lines.push(`# HELP ${name} ${metric.help}`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${metric.value}`);
    }

    for (const [name, metric] of this.gauges.entries()) {
      lines.push(`# HELP ${name} ${metric.help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${metric.value}`);
    }

    for (const [name, metric] of this.histograms.entries()) {
      lines.push(`# HELP ${name} ${metric.help}`);
      lines.push(`# TYPE ${name} histogram`);

      for (let idx = 0; idx < metric.buckets.length; idx += 1) {
        lines.push(
          `${name}_bucket{le="${metric.buckets[idx]}"} ${metric.bucketCounts[idx]}`
        );
      }
      lines.push(`${name}_bucket{le="+Inf"} ${metric.count}`);
      lines.push(`${name}_sum ${metric.sum}`);
      lines.push(`${name}_count ${metric.count}`);
    }

    return `${lines.join("\n")}\n`;
  }

  reset() {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

const metrics = new MetricsRegistry();

module.exports = {
  MetricsRegistry,
  metrics
};
