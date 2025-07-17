// riskEngine.js
// Central risk validation engine for trading signals
import {
  validateRR,
  checkMarketConditions,
  checkTimingFilters,
  validateATRStopLoss,
  validateSupportResistance,
  validateVolumeSpike,
  validateVolatilitySlippage,
} from './riskValidator.js';

function getWeekNumber(d = new Date()) {
  const oneJan = new Date(d.getFullYear(), 0, 1);
  return Math.floor((d - oneJan) / (7 * 24 * 60 * 60 * 1000));
}

const defaultState = {
  // PnL tracking
  dailyLoss: 0,
  weeklyLoss: 0,
  monthlyLoss: 0,
  dailyRisk: 0,
  // Limits
  maxDailyLoss: 5000,
  maxDailyLossPct: 0,
  maxCumulativeLoss: 0,
  maxWeeklyDrawdown: 0,
  maxMonthlyDrawdown: 0,
  maxLossPerTradePct: 0,
  maxDailyRisk: 10000,
  equity: 0,
  equityPeak: 0,
  equityDrawdownLimitPct: 0,
  // Trade tracking
  tradeCount: 0,
  maxTradesPerDay: 20,
  tradesPerInstrument: new Map(),
  tradesPerSector: new Map(),
  maxTradesPerInstrument: 3,
  maxTradesPerSector: 10,
  consecutiveLosses: 0,
  maxLossStreak: 3,
  lastTradeWasLoss: false,
  lastResetDay: new Date().getDate(),
  lastResetWeek: getWeekNumber(),
  lastResetMonth: new Date().getMonth(),
};

const riskState = {
  ...defaultState,
  tradesPerInstrument: new Map(),
  tradesPerSector: new Map(),
};
const duplicateMap = new Map();
const correlationMap = new Map();

export function resetRiskState() {
  Object.assign(riskState, defaultState, {
    lastResetDay: new Date().getDate(),
    lastResetWeek: getWeekNumber(),
    lastResetMonth: new Date().getMonth(),
  });
  riskState.tradesPerInstrument = new Map();
  riskState.tradesPerSector = new Map();
  duplicateMap.clear();
  correlationMap.clear();
}

export function recordTradeResult({ pnl = 0, risk = 0, symbol, sector }) {
  recordTradeExecution({ symbol, sector });
  const loss = pnl < 0 ? Math.abs(pnl) : 0;
  riskState.dailyLoss += loss;
  riskState.weeklyLoss += loss;
  riskState.monthlyLoss += loss;
  riskState.dailyRisk += risk;
  riskState.equity += pnl;
  if (riskState.equity > riskState.equityPeak) riskState.equityPeak = riskState.equity;
  riskState.lastTradeWasLoss = pnl < 0;
  if (pnl < 0) riskState.consecutiveLosses += 1;
  else riskState.consecutiveLosses = 0;
}

export function recordTradeExecution({ symbol, sector }) {
  riskState.tradeCount += 1;
  if (symbol) {
    const c = riskState.tradesPerInstrument.get(symbol) || 0;
    riskState.tradesPerInstrument.set(symbol, c + 1);
  }
  const sec = sector || 'GEN';
  const sc = riskState.tradesPerSector.get(sec) || 0;
  riskState.tradesPerSector.set(sec, sc + 1);
}

export function isSignalValid(signal, ctx = {}) {
  const now = Date.now();
  const today = new Date().getDate();
  const week = getWeekNumber();
  const month = new Date().getMonth();
  if (riskState.lastResetDay !== today) resetRiskState();
  if (riskState.lastResetWeek !== week) {
    riskState.weeklyLoss = 0;
    riskState.lastResetWeek = week;
  }
  if (riskState.lastResetMonth !== month) {
    riskState.monthlyLoss = 0;
    riskState.lastResetMonth = month;
  }

  const maxLoss = ctx.maxDailyLoss ?? riskState.maxDailyLoss;
  if (riskState.dailyLoss >= maxLoss) return false;
  const maxLossPct = ctx.maxDailyLossPct ?? riskState.maxDailyLossPct;
  if (
    maxLossPct > 0 &&
    riskState.equityPeak > 0 &&
    riskState.dailyLoss / riskState.equityPeak >= maxLossPct
  )
    return false;
  const maxCum = ctx.maxCumulativeLoss ?? riskState.maxCumulativeLoss;
  if (maxCum > 0 && riskState.dailyLoss >= maxCum) return false;
  const maxWeekly = ctx.maxWeeklyDrawdown ?? riskState.maxWeeklyDrawdown;
  if (maxWeekly > 0 && riskState.weeklyLoss >= maxWeekly) return false;
  const maxMonthly = ctx.maxMonthlyDrawdown ?? riskState.maxMonthlyDrawdown;
  if (maxMonthly > 0 && riskState.monthlyLoss >= maxMonthly) return false;
  const drawdownLimit =
    ctx.equityDrawdownLimitPct ?? riskState.equityDrawdownLimitPct;
  if (
    drawdownLimit > 0 &&
    riskState.equityPeak > 0 &&
    riskState.equity < riskState.equityPeak * (1 - drawdownLimit)
  )
    return false;
  const maxRisk = ctx.maxDailyRisk ?? riskState.maxDailyRisk;
  if (riskState.dailyRisk >= maxRisk) return false;
  const maxTrades = ctx.maxTradesPerDay ?? riskState.maxTradesPerDay;
  if (riskState.tradeCount >= maxTrades) return false;
  const maxStreak = ctx.maxLossStreak ?? riskState.maxLossStreak;
  if (riskState.consecutiveLosses >= maxStreak) return false;
  if (ctx.cooloffAfterLoss && riskState.lastTradeWasLoss) return false;
  if (
    typeof ctx.maxOpenPositions === 'number' &&
    typeof ctx.openPositionsCount === 'number' &&
    ctx.openPositionsCount >= ctx.maxOpenPositions
  )
    return false;
  if (ctx.preventOverlap && Array.isArray(ctx.openSymbols)) {
    if (ctx.openSymbols.includes(signal.stock || signal.symbol)) return false;
  }
  if (ctx.openPositionsMap instanceof Map) {
    const existing = ctx.openPositionsMap.get(signal.stock || signal.symbol);
    const dir = signal.direction === 'Long' ? 'long' : 'short';
    if (existing && existing.side && existing.side.toLowerCase() !== dir)
      return false;
  }

  const inst = signal.stock || signal.symbol;
  const instCount = riskState.tradesPerInstrument.get(inst) || 0;
  const maxPerInst = ctx.maxTradesPerInstrument ?? riskState.maxTradesPerInstrument;
  if (instCount >= maxPerInst) return false;

  const sec = signal.sector || 'GEN';
  const secCount = riskState.tradesPerSector.get(sec) || 0;
  const maxPerSec = ctx.maxTradesPerSector ?? riskState.maxTradesPerSector;
  if (secCount >= maxPerSec) return false;

  if (
    typeof ctx.minTradeValue === 'number' &&
    typeof ctx.tradeValue === 'number' &&
    ctx.tradeValue < ctx.minTradeValue
  )
    return false;
  if (
    typeof ctx.maxTradeValue === 'number' &&
    typeof ctx.tradeValue === 'number' &&
    ctx.tradeValue > ctx.maxTradeValue
  )
    return false;
  if (
    typeof ctx.volatilityFilter === 'number' &&
    typeof signal.atr === 'number' &&
    signal.atr > ctx.volatilityFilter
  )
    return false;
  if (ctx.allowPyramiding === false && ctx.hasPositionForSymbol) return false;

  if (signal.expiresAt && now > new Date(signal.expiresAt).getTime()) return false;

  const rr = validateRR({
    strategy: signal.algoSignal?.strategy || signal.pattern,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    target: signal.target2 ?? signal.target,
    winrate: ctx.winrate || 0,
  });
  if (!rr.valid) return false;
  if (typeof ctx.minRR === 'number' && rr.rr < ctx.minRR) return false;

  if (
    !validateATRStopLoss({ entry: signal.entry, stopLoss: signal.stopLoss, atr: signal.atr })
  )
    return false;

  if (
    !validateSupportResistance({
      entry: signal.entry,
      direction: signal.direction,
      support: signal.support,
      resistance: signal.resistance,
      atr: signal.atr,
    })
  )
    return false;

  if (
    !validateVolumeSpike({
      volume: signal.volume ?? ctx.volume,
      avgVolume: ctx.avgVolume,
    })
  )
    return false;

  if (
    typeof ctx.minLiquidity === 'number' &&
    typeof (signal.liquidity ?? ctx.volume) === 'number' &&
    (signal.liquidity ?? ctx.volume) < ctx.minLiquidity
  )
    return false;

  if (
    typeof ctx.minVolumeRatio === 'number' &&
    typeof ctx.avgVolume === 'number' &&
    typeof (signal.liquidity ?? ctx.volume) === 'number' &&
    (signal.liquidity ?? ctx.volume) < ctx.avgVolume * ctx.minVolumeRatio
  )
    return false;

  if (
    !validateVolatilitySlippage({
      atr: signal.atr,
      minATR: ctx.minVolatility,
      maxATR: ctx.maxVolatility,
      dailyRangePct: ctx.dailyRangePct,
      maxDailySpikePct: ctx.rangeSpikeThreshold,
      wickPct: ctx.wickPct,
      volume: signal.liquidity ?? ctx.volume,
      avgVolume: ctx.avgVolume,
      consolidationRatio: ctx.consolidationVolumeRatio,
      slippage: ctx.slippage,
      maxSlippage: ctx.maxSlippage,
      spread: signal.spread,
      maxSpreadPct: ctx.maxSpreadPct,
    })
  )
    return false;

  if (typeof ctx.minATR === 'number' && signal.atr < ctx.minATR) return false;
  if (typeof ctx.maxATR === 'number' && signal.atr > ctx.maxATR) return false;

  const slDist = Math.abs(signal.entry - signal.stopLoss);
  const lossPct = slDist / signal.entry;
  const maxPerTrade = ctx.maxLossPerTradePct ?? riskState.maxLossPerTradePct;
  if (maxPerTrade > 0 && lossPct > maxPerTrade) return false;
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

  const timingOk = checkTimingFilters({
    now: ctx.now,
    minutesBeforeClose: ctx.blockMinutesBeforeClose,
    minutesAfterOpen: ctx.blockMinutesAfterOpen,
    holidays: ctx.holidays,
    specialSessions: ctx.specialSessions,
    eventActive: ctx.majorEventActive,
    earningsCalendar: ctx.earningsCalendar,
    symbol: signal.stock || signal.symbol,
    indexRebalanceDays: ctx.indexRebalanceDays,
    expiryDates: ctx.expiryDates,
  });
  if (!timingOk) return false;

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
