import dotenv from "dotenv";

dotenv.config();

export const SCALPING_MODE = "SCALPING";

export function loadScalpingConfig() {
  const mode = process.env.MODE || process.env.TRADING_MODE || "INTRADAY";
  const isScalping = mode.toUpperCase() === SCALPING_MODE;

  return {
    mode: isScalping ? SCALPING_MODE : mode,
    universe: (process.env.SCALPING_UNIVERSE || "NIFTY24FEBFUT,BANKNIFTY24FEBFUT")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxConcurrentPositions: Number(process.env.SCALPING_MAX_POSITIONS || 1),
    candleHistorySize: Number(process.env.SCALPING_CANDLE_HISTORY || 120),
    risk: {
      perTradeRisk: Number(process.env.SCALPING_RISK_PER_TRADE || 0.005),
      dailyLossLimit: Number(process.env.SCALPING_DAILY_LOSS || 0.02),
      maxTradesPerDay: Number(process.env.SCALPING_MAX_TRADES || 15),
    },
    executionServiceUrl:
      process.env.EXECUTION_SERVICE_URL || "http://localhost:4001/api/signals",
    simulation:
      (process.env.MODE || "").toUpperCase() === "SIMULATION" ||
      (process.env.TRADING_MODE || "").toUpperCase() === "SIMULATION",
  };
}
