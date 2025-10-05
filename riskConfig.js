const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined; // preserves 0
};

// Percent-aware parser: allows "15" (=> 0.15) or "0.15" (=> 0.15).
// If a value is >1 and <=100 we treat it as a percentage.
const numPct = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return undefined;
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
  drawdownReduce25Pct: numPct(process.env.DD_REDUCE_25_PCT),
  drawdownReduce50Pct: numPct(process.env.DD_REDUCE_50_PCT),
  drawdownHaltPct: numPct(process.env.DD_HALT_PCT),
  equityDrawdownLimitPct: numPct(process.env.EQUITY_DRAWDOWN_LIMIT_PCT),
  maxDailyLossPct: numPct(process.env.MAX_DAILY_LOSS_PCT),
  maxCumulativeLoss: num(process.env.MAX_CUMULATIVE_LOSS),
  maxWeeklyDrawdown: numPct(process.env.MAX_WEEKLY_DRAWDOWN),
  maxMonthlyDrawdown: numPct(process.env.MAX_MONTHLY_DRAWDOWN),
  maxLossPerTradePct: numPct(process.env.MAX_LOSS_PER_TRADE_PCT),

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
    // NEW: guards consumed by validators/filters
    maxSpread: num(process.env.MARKET_MAX_SPREAD),
    maxSpreadPct: numPct(process.env.MARKET_MAX_SPREAD_PCT),
    maxSlippage: num(process.env.MARKET_MAX_SLIPPAGE),
    minATR: num(process.env.MARKET_MIN_ATR),
    maxATR: num(process.env.MARKET_MAX_ATR),
    maxDailySpikePct: numPct(process.env.MARKET_MAX_DAILY_SPIKE_PCT),
    consolidationRatio: numPct(process.env.MARKET_CONSOLIDATION_RATIO),
    wickLimitPct: numPct(process.env.MARKET_WICK_LIMIT_PCT),
  },
  sl: {
    minAtrMult: num(process.env.SL_MIN_ATR_MULT),
    maxAtrMult: num(process.env.SL_MAX_ATR_MULT),
  },
  frictions: {
    // used in RR & sizing when not explicitly provided
    costBuffer: num(process.env.COST_BUFFER),
    defaultSlippage: num(process.env.DEFAULT_SLIPPAGE),
  },
  sizing: {
    defaultRiskPercent: numPct(process.env.RISK_PER_TRADE_PCT),
    method: process.env.SIZING_METHOD, // 'fixed-percent' | 'fixed-rupee' | ... (optional)
  },
  exposure: {
    instrumentCapPct: numPct(process.env.EXPOSURE_INSTRUMENT_CAP_PCT),
    sectorDefaultCapPct: numPct(process.env.EXPOSURE_SECTOR_DEFAULT_CAP_PCT),
    // You can also inject per-sector envs and read them at runtime if needed.
  },
};

const flatDefaults = prune(configuredDefaults);

export const riskDefaults = Object.freeze({
  market: {
    maxAtrMult: 1.5,
    maxLatencyMs: 120_000,
    maxSpread: undefined,
    maxSpreadPct: 0.003, // 0.3% fallback if you want a hard cap
    maxSlippage: undefined, // set in env to enforce
    minATR: undefined,
    maxATR: undefined,
    maxDailySpikePct: 0.06, // 6% intraday range often considered high
    consolidationRatio: 0.3, // volume guard in validateVolatilitySlippage
    wickLimitPct: 0.6, // reject extreme wick noise
    ...prune(nestedDefaults.market),
  },
  sl: {
    minAtrMult: 0.5,
    maxAtrMult: 3,
    ...prune(nestedDefaults.sl),
  },
  frictions: {
    costBuffer: 1,
    defaultSlippage: 0,
    ...prune(nestedDefaults.frictions),
  },
  sizing: {
    defaultRiskPercent: 0.01,
    method: undefined,
    ...prune(nestedDefaults.sizing),
  },
  exposure: {
    instrumentCapPct: 0.1, // 10% per instrument
    sectorDefaultCapPct: 0.25, // 25% per sector unless overridden
    ...prune(nestedDefaults.exposure),
  },
  ...flatDefaults,
});

