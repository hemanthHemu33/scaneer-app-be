// riskEngine.js
// Central risk validation engine for trading signals
import { validateRR, checkMarketConditions } from './riskValidator.js';

const defaultState = {
  dailyLoss: 0,
  maxDailyLoss: 5000,
  tradeCount: 0,
  maxTradesPerDay: 20,
  lastResetDay: new Date().getDate(),
};

const riskState = { ...defaultState };
const duplicateMap = new Map();
const correlationMap = new Map();

export function resetRiskState() {
  Object.assign(riskState, defaultState, { lastResetDay: new Date().getDate() });
  duplicateMap.clear();
  correlationMap.clear();
}

export function recordTradeResult({ pnl = 0 }) {
  riskState.tradeCount += 1;
  riskState.dailyLoss += pnl < 0 ? Math.abs(pnl) : 0;
}

export function isSignalValid(signal, ctx = {}) {
  const now = Date.now();
  const today = new Date().getDate();
  if (riskState.lastResetDay !== today) resetRiskState();

  const maxLoss = ctx.maxDailyLoss ?? riskState.maxDailyLoss;
  if (riskState.dailyLoss >= maxLoss) return false;
  const maxTrades = ctx.maxTradesPerDay ?? riskState.maxTradesPerDay;
  if (riskState.tradeCount >= maxTrades) return false;

  const rr = validateRR({
    strategy: signal.algoSignal?.strategy || signal.pattern,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    target: signal.target2 ?? signal.target,
    winrate: ctx.winrate || 0,
  });
  if (!rr.valid) return false;

  if (typeof ctx.minATR === 'number' && signal.atr < ctx.minATR) return false;
  if (typeof ctx.maxATR === 'number' && signal.atr > ctx.maxATR) return false;

  const slDist = Math.abs(signal.entry - signal.stopLoss);
  if (
    typeof signal.spread === 'number' &&
    slDist > 0 &&
    signal.spread / slDist > (ctx.maxSpreadSLRatio ?? 0.3)
  )
    return false;

  const marketOk = checkMarketConditions({
    atr: signal.atr,
    avgAtr: ctx.avgAtr,
    indexTrend: ctx.indexTrend,
    signalDirection: signal.direction === 'Long' ? 'up' : 'down',
    timeSinceSignal: ctx.timeSinceSignal ?? 0,
    volume: signal.liquidity ?? ctx.volume,
    spread: signal.spread,
    newsImpact: ctx.newsImpact,
    eventActive: ctx.eventActive,
  });
  if (!marketOk) return false;

  const key = `${signal.stock || signal.symbol}-${signal.direction}-${signal.pattern || signal.algoSignal?.strategy}`;
  const dupWindow = ctx.duplicateWindowMs || 5 * 60 * 1000;
  if (duplicateMap.has(key) && now - duplicateMap.get(key) < dupWindow) return false;
  duplicateMap.set(key, now);

  if (ctx.marketRegime) {
    if (ctx.marketRegime === 'bullish' && signal.direction === 'Short') return false;
    if (ctx.marketRegime === 'bearish' && signal.direction === 'Long') return false;
  }

  const group = signal.correlationGroup || signal.sector;
  const corrWindow = ctx.correlationWindowMs || 5 * 60 * 1000;
  if (group) {
    if (correlationMap.has(group) && now - correlationMap.get(group) < corrWindow)
      return false;
    correlationMap.set(group, now);
  }

  return true;
}

export { riskState };
