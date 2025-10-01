export const riskDefaults = Object.freeze({
  maxDailyLoss: Number(process.env.MAX_DAILY_LOSS) || 5000,
  maxDailyRisk: Number(process.env.MAX_DAILY_RISK) || 10000,
  maxTradesPerDay: Number(process.env.MAX_TRADES_PER_DAY) || 20,
  maxTradesPerInstrument: Number(process.env.MAX_TRADES_PER_INSTRUMENT) || 3,
  maxTradesPerSector: Number(process.env.MAX_TRADES_PER_SECTOR) || 10,
  maxLossStreak: Number(process.env.MAX_LOSS_STREAK) || 3,
  // Signals & throttles
  maxSignalsPerDay: isFinite(Number(process.env.MAX_SIGNALS_PER_DAY))
    ? Number(process.env.MAX_SIGNALS_PER_DAY)
    : 300,
  signalFloodThreshold: Number(process.env.SIGNAL_FLOOD_THRESHOLD) || 0,
  volatilityThrottleMs: Number(process.env.VOLATILITY_THROTTLE_MS) || 0,
  maxSimultaneousSignals: Number(process.env.MAX_SIMULTANEOUS_SIGNALS) || 0,

  // Optional drawdown controls (0 disables)
  equityDrawdownLimitPct: Number(process.env.EQUITY_DRAWDOWN_LIMIT_PCT) || 0,
  maxDailyLossPct: Number(process.env.MAX_DAILY_LOSS_PCT) || 0,
  maxCumulativeLoss: Number(process.env.MAX_CUMULATIVE_LOSS) || 0,
  maxWeeklyDrawdown: Number(process.env.MAX_WEEKLY_DRAWDOWN) || 0,
  maxMonthlyDrawdown: Number(process.env.MAX_MONTHLY_DRAWDOWN) || 0,
  maxLossPerTradePct: Number(process.env.MAX_LOSS_PER_TRADE_PCT) || 0,
  maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS) || 0,
});

