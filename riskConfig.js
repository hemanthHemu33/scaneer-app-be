const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined; // preserves 0
};

const configuredDefaults = {
  // Core loss/risk caps
  maxDailyLoss: num(process.env.MAX_DAILY_LOSS),
  maxDailyRisk: num(process.env.MAX_DAILY_RISK),
  maxTradesPerDay: num(process.env.MAX_TRADES_PER_DAY),
  maxTradesPerInstrument: num(process.env.MAX_TRADES_PER_INSTRUMENT),
  maxTradesPerSector: num(process.env.MAX_TRADES_PER_SECTOR),
  maxLossStreak: num(process.env.MAX_LOSS_STREAK),
  maxOpenPositions: num(process.env.MAX_OPEN_POSITIONS),

  // Signals & throttles
  maxSignalsPerDay: num(process.env.MAX_SIGNALS_PER_DAY),
  signalFloodThreshold: num(process.env.SIGNAL_FLOOD_THRESHOLD),
  signalFloodThrottleMs: num(process.env.SIGNAL_FLOOD_THROTTLE_MS),
  volatilityThrottleMs: num(process.env.VOLATILITY_THROTTLE_MS),
  maxSimultaneousSignals: num(process.env.MAX_SIMULTANEOUS_SIGNALS),

  // Optional drawdown controls (0 disables)
  drawdownReduce25Pct: num(process.env.DD_REDUCE_25_PCT),
  drawdownReduce50Pct: num(process.env.DD_REDUCE_50_PCT),
  drawdownHaltPct: num(process.env.DD_HALT_PCT),
  equityDrawdownLimitPct: num(process.env.EQUITY_DRAWDOWN_LIMIT_PCT),
  maxDailyLossPct: num(process.env.MAX_DAILY_LOSS_PCT),
  maxCumulativeLoss: num(process.env.MAX_CUMULATIVE_LOSS),
  maxWeeklyDrawdown: num(process.env.MAX_WEEKLY_DRAWDOWN),
  maxMonthlyDrawdown: num(process.env.MAX_MONTHLY_DRAWDOWN),
  maxLossPerTradePct: num(process.env.MAX_LOSS_PER_TRADE_PCT),

  // Advanced (optional) – used by riskEngine if present
  duplicateWindowMs: num(process.env.DUPLICATE_WINDOW_MS),
  correlationWindowMs: num(process.env.CORRELATION_WINDOW_MS),
  timeBucketMs: num(process.env.TIME_BUCKET_MS),
  highVolatilityThresh: num(process.env.HIGH_VOLATILITY_THRESH),
  maxSpreadSLRatio: num(process.env.MAX_SPREAD_SL_RATIO),
  maxSLATR: num(process.env.MAX_SL_ATR),
  minRR: num(process.env.MIN_RR),
};

const prune = (obj = {}) =>
  Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));

const nestedDefaults = {
  market: {
    maxAtrMult: num(process.env.MARKET_MAX_ATR_MULT),
    maxLatencyMs: num(process.env.MARKET_MAX_LATENCY_MS),
  },
  sl: {
    minAtrMult: num(process.env.SL_MIN_ATR_MULT),
    maxAtrMult: num(process.env.SL_MAX_ATR_MULT),
  },
};

const flatDefaults = prune(configuredDefaults);

export const riskDefaults = Object.freeze({
  market: {
    maxAtrMult: 1.5,
    maxLatencyMs: 120_000,
    ...prune(nestedDefaults.market),
  },
  sl: {
    minAtrMult: 0.5,
    maxAtrMult: 3,
    ...prune(nestedDefaults.sl),
  },
  ...flatDefaults,
});

