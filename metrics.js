const DEFAULT_INTERVAL_MS = 60000;

export const metrics = {
  ticks: 0,
  candles1mFormed: 0,
  evalSymbols: 0,
  candidates: 0,
  emitted: 0,
  rejectedBy: {},
};

let reporterStarted = false;
let reporterTimer = null;
let loggerFn = console.log;

export function setLogger(fn) {
  if (typeof fn === "function") {
    loggerFn = fn;
  }
}

export function incrementMetric(name, value = 1) {
  if (!Object.prototype.hasOwnProperty.call(metrics, name)) {
    metrics[name] = 0;
  }
  const current = Number(metrics[name]) || 0;
  metrics[name] = current + value;
  return metrics[name];
}

export function setMetric(name, value) {
  metrics[name] = value;
  return metrics[name];
}

export function resetMetrics() {
  metrics.ticks = 0;
  metrics.candles1mFormed = 0;
  metrics.evalSymbols = 0;
  metrics.candidates = 0;
  metrics.emitted = 0;
  metrics.rejectedBy = {};
}

export function onReject(rule) {
  const key = String(rule || "unknown");
  if (!metrics.rejectedBy[key]) {
    metrics.rejectedBy[key] = 0;
  }
  metrics.rejectedBy[key] += 1;
  return metrics.rejectedBy[key];
}

function snapshotMetrics() {
  return {
    ts: new Date().toISOString(),
    ...metrics,
    rejectedBy: { ...metrics.rejectedBy },
  };
}

export function startMetricsReporter(options = {}) {
  const { intervalMs = DEFAULT_INTERVAL_MS, logger = loggerFn } = options;
  if (reporterStarted) return reporterTimer;
  reporterStarted = true;
  if (typeof logger === "function") {
    loggerFn = logger;
  }
  reporterTimer = setInterval(() => {
    try {
      const snapshot = snapshotMetrics();
      loggerFn(`[metrics] ${JSON.stringify(snapshot)}`);
    } catch (err) {
      console.error("[metrics] reporter error", err);
    } finally {
      metrics.ticks = 0;
      metrics.candles1mFormed = 0;
      metrics.evalSymbols = 0;
      metrics.candidates = 0;
      metrics.emitted = 0;
      for (const key of Object.keys(metrics.rejectedBy)) {
        metrics.rejectedBy[key] = 0;
      }
    }
  }, intervalMs);
  if (reporterTimer.unref) reporterTimer.unref();
  return reporterTimer;
}

export function stopMetricsReporter() {
  if (reporterTimer) {
    clearInterval(reporterTimer);
    reporterTimer = null;
  }
  reporterStarted = false;
}
