export const riskDefaults = {
  maxDailyLoss: Number(process.env.MAX_DAILY_LOSS) || 5000,
  maxDailyRisk: Number(process.env.MAX_DAILY_RISK) || 10000,
  maxTradesPerDay: Number(process.env.MAX_TRADES_PER_DAY) || 20,
  maxTradesPerInstrument: Number(process.env.MAX_TRADES_PER_INSTRUMENT) || 3,
  maxTradesPerSector: Number(process.env.MAX_TRADES_PER_SECTOR) || 10,
  maxLossStreak: Number(process.env.MAX_LOSS_STREAK) || 3,
  maxSignalsPerDay: Number(process.env.MAX_SIGNALS_PER_DAY) || Infinity,
  signalFloodThreshold: Number(process.env.SIGNAL_FLOOD_THRESHOLD) || 0,
  volatilityThrottleMs: Number(process.env.VOLATILITY_THROTTLE_MS) || 0,
};

