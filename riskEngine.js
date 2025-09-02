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
  isSLInvalid,
} from "./riskValidator.js";
import { calculateStdDev, calculateZScore } from "./util.js";
import { resolveSignalConflicts } from "./portfolioContext.js";
import { riskDefaults } from "./riskConfig.js";

function getWeekNumber(d = new Date()) {
  const oneJan = new Date(d.getFullYear(), 0, 1);
  return Math.floor((d - oneJan) / (7 * 24 * 60 * 60 * 1000));
}

class RiskState {
  constructor(config = {}) {
    this.config = config;
    this.duplicateMap = new Map();
    this.correlationMap = new Map();
    this.watchList = new Set();
    this.timeBuckets = new Map();
    this.strategyFailMap = new Map();
    this.reset();
  }

  reset() {
    Object.assign(this, {
      // PnL tracking
      dailyLoss: 0,
      weeklyLoss: 0,
      monthlyLoss: 0,
      dailyRisk: 0,
      // Limits
      maxDailyLoss: this.config.maxDailyLoss,
      maxDailyLossPct: 0,
      maxCumulativeLoss: 0,
      maxWeeklyDrawdown: 0,
      maxMonthlyDrawdown: 0,
      maxLossPerTradePct: 0,
      maxDailyRisk: this.config.maxDailyRisk,
      equity: 0,
      equityPeak: 0,
      equityDrawdownLimitPct: 0,
      // Trade tracking
      tradeCount: 0,
      maxTradesPerDay: this.config.maxTradesPerDay,
      tradesPerInstrument: new Map(),
      tradesPerSector: new Map(),
      maxTradesPerInstrument: this.config.maxTradesPerInstrument,
      maxTradesPerSector: this.config.maxTradesPerSector,
      consecutiveLosses: 0,
      maxLossStreak: this.config.maxLossStreak,
      lastTradeWasLoss: false,
      lastTradeTime: 0,
      systemPaused: false,
      signalCount: 0,
      maxSignalsPerDay: this.config.maxSignalsPerDay,
      signalFloodThreshold: this.config.signalFloodThreshold,
      volatilityThrottleMs: this.config.volatilityThrottleMs,
      lastResetDay: new Date().getDate(),
      lastResetWeek: getWeekNumber(),
      lastResetMonth: new Date().getMonth(),
    });
    this.duplicateMap.clear();
    this.correlationMap.clear();
    this.watchList.clear();
    this.timeBuckets.clear();
    this.strategyFailMap.clear();
  }
}

export const riskState = new RiskState(riskDefaults);

export function resetRiskState() {
  riskState.reset();
}

export function recordTradeResult({ pnl = 0, risk = 0, symbol, sector, strategy }) {
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
  riskState.lastTradeTime = Date.now();
  if (pnl < 0 && symbol && strategy) {
    riskState.strategyFailMap.set(`${symbol}-${strategy}`, Date.now());
  }
  if (
    riskState.dailyLoss >= riskState.maxDailyLoss ||
    (riskState.equityPeak > 0 &&
      riskState.equity < riskState.equityPeak * (1 - riskState.equityDrawdownLimitPct))
  ) {
    riskState.systemPaused = true;
  }
}

export function recordTradeExecution({ symbol, sector }) {
  riskState.tradeCount += 1;
  if (symbol) {
    const c = riskState.tradesPerInstrument.get(symbol) || 0;
    riskState.tradesPerInstrument.set(symbol, c + 1);
    riskState.watchList.add(symbol);
  }
  const sec = sector || 'GEN';
  const sc = riskState.tradesPerSector.get(sec) || 0;
  riskState.tradesPerSector.set(sec, sc + 1);
  riskState.lastTradeTime = Date.now();
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

  riskState.signalCount += 1;
  if (riskState.systemPaused) return false;
  const bucketMs = ctx.timeBucketMs || 60 * 1000;
  const bucket = Math.floor(now / bucketMs);
  const count = riskState.timeBuckets.get(bucket) || 0;
  if (
    typeof ctx.maxSimultaneousSignals === 'number' &&
    count >= ctx.maxSimultaneousSignals
  )
    return false;
  riskState.timeBuckets.set(bucket, count + 1);
  if (riskState.timeBuckets.size > 10) {
    for (const [k] of riskState.timeBuckets) {
      if (k < bucket - 10) riskState.timeBuckets.delete(k);
    }
  }
  const maxSignals = ctx.maxSignalsPerDay ?? riskState.maxSignalsPerDay;
  if (riskState.signalCount > maxSignals) return false;
  if (
    typeof ctx.highVolatilityThresh === 'number' &&
    typeof ctx.volatility === 'number' &&
    ctx.volatility > ctx.highVolatilityThresh
  ) {
    const interval = (ctx.throttleMs ?? riskState.volatilityThrottleMs) || 60000;
    if (now - riskState.lastTradeTime < interval) return false;
  }
  if (
    typeof ctx.signalFloodThreshold === 'number' &&
    riskState.signalCount > ctx.signalFloodThreshold
  ) {
    const interval = ctx.signalFloodThrottleMs || 60000;
    if (now - riskState.lastTradeTime < interval) return false;
  }

  if (
    typeof ctx.indexVolatility === 'number' &&
    typeof ctx.maxIndexVolatility === 'number' &&
    ctx.indexVolatility > ctx.maxIndexVolatility
  )
    return false;
  if (
    typeof ctx.vwapParticipation === 'number' &&
    typeof ctx.minVwapParticipation === 'number' &&
    ctx.vwapParticipation < ctx.minVwapParticipation
  )
    return false;
  if (ctx.negativeNews) return false;
  if (
    ctx.maxSignalAgeMinutes &&
    signal.generatedAt &&
    now - new Date(signal.generatedAt).getTime() > ctx.maxSignalAgeMinutes * 60 * 1000
  )
    return false;

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
  const dir = signal.direction === 'Long' ? 'long' : 'short';
  if (ctx.openPositionsMap instanceof Map) {
    const existing = ctx.openPositionsMap.get(signal.stock || signal.symbol);
    if (existing && existing.side && existing.side.toLowerCase() !== dir)
      return false;
  }
  if (
    ctx.resolveConflicts &&
    !resolveSignalConflicts({
      symbol: signal.stock || signal.symbol,
      side: dir,
      strategy: signal.algoSignal?.strategy || signal.pattern,
    })
  )
    return false;

  const inst = signal.stock || signal.symbol;
  if (ctx.blockWatchlist && riskState.watchList.has(inst)) return false;
  const stratKey = `${inst}-${signal.algoSignal?.strategy || signal.pattern}`;
  if (
    ctx.strategyFailWindowMs &&
    riskState.strategyFailMap.has(stratKey) &&
    now - riskState.strategyFailMap.get(stratKey) < ctx.strategyFailWindowMs
  )
    return false;
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

  const conf = signal.confidence ?? signal.confidenceScore ?? 0;
  const aiOverride =
    typeof ctx.aiOverrideThreshold === 'number' &&
    typeof ctx.mlConfidence === 'number' &&
    ctx.mlConfidence >= ctx.aiOverrideThreshold;
  if (typeof ctx.minConfidence === 'number' && conf < ctx.minConfidence && !aiOverride)
    return false;
  if (ctx.entryStdDev === undefined && Array.isArray(ctx.prices)) {
    ctx.entryStdDev = calculateStdDev(
      ctx.prices,
      ctx.stdLookback || Math.min(5, ctx.prices.length)
    );
  }
  if (ctx.zScore === undefined && Array.isArray(ctx.prices)) {
    ctx.zScore = calculateZScore(
      ctx.prices,
      ctx.zLookback || Math.min(20, ctx.prices.length)
    );
  }
  if (
    typeof ctx.minMlConfidence === 'number' &&
    typeof ctx.mlConfidence === 'number' &&
    ctx.mlConfidence < ctx.minMlConfidence
  )
    return false;
  if (
    typeof ctx.minBacktestWinRate === 'number' &&
    typeof ctx.backtestWinRate === 'number' &&
    ctx.backtestWinRate < ctx.minBacktestWinRate
  )
    return false;
  if (
    typeof ctx.minRecentAccuracy === 'number' &&
    typeof ctx.recentAccuracy === 'number' &&
    ctx.recentAccuracy < ctx.minRecentAccuracy
  )
    return false;
  if (
    typeof ctx.maxEntryStdDev === 'number' &&
    typeof ctx.entryStdDev === 'number' &&
    ctx.entryStdDev > ctx.maxEntryStdDev
  )
    return false;
  if (
    typeof ctx.minZScoreAbs === 'number' &&
    typeof ctx.zScore === 'number' &&
    Math.abs(ctx.zScore) < ctx.minZScoreAbs
  )
    return false;
  if (
    typeof ctx.maxRiskScore === 'number' &&
    typeof signal.riskScore === 'number' &&
    signal.riskScore > ctx.maxRiskScore
  )
    return false;

  const upper = signal.upperCircuit ?? ctx.upperCircuit;
  const lower = signal.lowerCircuit ?? ctx.lowerCircuit;
  if (typeof upper === 'number' && signal.entry >= upper * 0.99) return false;
  if (typeof lower === 'number' && signal.entry <= lower * 1.01) return false;
  if (signal.inGapZone || ctx.inGapZone) return false;

  if (signal.expiresAt && now > new Date(signal.expiresAt).getTime()) return false;

  const rr = validateRR({
    strategy: signal.algoSignal?.strategy || signal.pattern,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    target: signal.target2 ?? signal.target,
    winrate: ctx.winrate || 0,
  });
  if (!rr.valid) return false;
  const minRR = ctx.minRR ?? 2;
  if (rr.rr < minRR) return false;

  if (
    signal.atr &&
    Math.abs(signal.entry - signal.stopLoss) > (ctx.maxSLATR ?? 2) * signal.atr
  )
    return false;

  if (
    !validateATRStopLoss({ entry: signal.entry, stopLoss: signal.stopLoss, atr: signal.atr })
  )
    return false;

  if (
    isSLInvalid({
      price: ctx.currentPrice ?? signal.entry,
      stopLoss: signal.stopLoss,
      atr: signal.atr,
      structureBreak: ctx.structureBreak,
    })
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
    ctx.requireMomentum &&
    typeof ctx.rsi === 'number' &&
    ((signal.direction === 'Long' && ctx.rsi < (ctx.minRsi ?? 55)) ||
      (signal.direction === 'Short' && ctx.rsi > (ctx.maxRsi ?? 45)))
  )
    return false;
  if (ctx.requireMomentum && typeof ctx.adx === 'number' && ctx.adx < (ctx.minAdx ?? 20))
    return false;
  if (
    typeof ctx.minRvol === 'number' &&
    typeof (signal.rvol ?? ctx.rvol) === 'number' &&
    (signal.rvol ?? ctx.rvol) < ctx.minRvol
  )
    return false;

  if (
    typeof ctx.minLiquidity === 'number' &&
    typeof (signal.liquidity ?? ctx.volume) === 'number' &&
    (signal.liquidity ?? ctx.volume) < ctx.minLiquidity
  )
    return false;

  if (
    typeof ctx.minVolume === 'number' &&
    typeof (signal.liquidity ?? ctx.volume) === 'number' &&
    (signal.liquidity ?? ctx.volume) < ctx.minVolume
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

  if (
    typeof ctx.minSLDistancePct === 'number' &&
    Math.abs(signal.entry - signal.stopLoss) / signal.entry < ctx.minSLDistancePct
  )
    return false;

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
  if (
    riskState.duplicateMap.has(key) &&
    now - riskState.duplicateMap.get(key) < dupWindow
  )
    return false;
  riskState.duplicateMap.set(key, now);

  if (ctx.marketRegime) {
    if (ctx.marketRegime === 'bullish' && signal.direction === 'Short') return false;
    if (ctx.marketRegime === 'bearish' && signal.direction === 'Long') return false;
  }

  const group = signal.correlationGroup || signal.sector;
  const corrWindow = ctx.correlationWindowMs || 5 * 60 * 1000;
  if (group) {
    if (
      riskState.correlationMap.has(group) &&
      now - riskState.correlationMap.get(group) < corrWindow
    )
      return false;
    riskState.correlationMap.set(group, now);
  }

  if (ctx.addToWatchlist) riskState.watchList.add(inst);
  return true;
}
