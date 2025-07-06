// scanner.js simplified orchestrator

import { computeFeatures } from "./featureEngine.js";
import { evaluateAllStrategies } from "./strategyEngine.js";
import { getSupportResistanceLevels } from "./kite.js";
import { detectAllPatterns } from "./util.js";
import { isSignalValid } from "./riskEngine.js";
import { selectTopSignal } from "./signalRanker.js";
import { sendToExecution } from "./orderExecution.js";

const signalHistory = {};

export async function analyzeCandles(
  candles,
  symbol,
  depth = null,
  totalBuy = 0,
  totalSell = 0,
  slippage = 0,
  spread = 0,
  liquidity = 0,
  liveTick = null,
  overrideFilters = {}
) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const features = computeFeatures(candles);
  if (!features) return null;

  const context = {
    symbol,
    candles,
    features,
    depth,
    totalBuy,
    totalSell,
    tick: liveTick,
    spread,
    liquidity,
    filters: overrideFilters,
  };

  const strategySignals = evaluateAllStrategies(context);
  const patterns = detectAllPatterns(candles, features.atr) || [];
  for (const p of patterns) {
    const entry = p.breakout ?? candles.at(-1).close;
    const stop =
      p.stopLoss ?? (p.direction === 'Long' ? candles.at(-1).low : candles.at(-1).high);
    const risk = Math.abs(entry - stop);
    strategySignals.push({
      entry,
      stopLoss: stop,
      target1: p.direction === 'Long' ? entry + risk : entry - risk,
      target2: p.direction === 'Long' ? entry + risk * 2 : entry - risk * 2,
      direction: p.direction,
      strategy: p.type,
      confidence: p.confidence || 'Medium',
    });
  }
  if (!Array.isArray(strategySignals) || strategySignals.length === 0) return null;

  const { support, resistance } = getSupportResistanceLevels(symbol);
  const timestamp = candles.at(-1)?.timestamp || Date.now();

  const prepared = strategySignals.map((s) => ({
    ...s,
    stock: symbol,
    symbol,
    pattern: s.strategy,
    signalId: `${symbol}-${s.strategy}-${timestamp}`,
    support,
    resistance,
    atr: features.atr,
    rsi: features.rsi,
    ema9: features.ema9,
    ema21: features.ema21,
    spread,
    liquidity,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  }));

  const valid = prepared.filter((sig) => isSignalValid(sig, { avgAtr: features.atr }));
  if (valid.length === 0) return null;

  const top = selectTopSignal(valid);
  if (!top) return null;

  if (!signalHistory[symbol]) signalHistory[symbol] = [];
  signalHistory[symbol].push({ timestamp: Date.now(), direction: top.direction });

  await sendToExecution(top);
  return top;
}

export function getSignalHistory() {
  return signalHistory;
}

export async function rankAndExecute(signals = []) {
  const top = selectTopSignal(signals);
  if (top) {
    await sendToExecution(top);
  }
  return top;
}
