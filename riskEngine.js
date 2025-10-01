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

const riskDebug = process.env.RISK_DEBUG === "true";

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

export function recordTradeResult({
  pnl = 0,
  risk = 0,
  symbol,
  sector,
  strategy,
}) {
  recordTradeExecution({ symbol, sector });
  const loss = pnl < 0 ? Math.abs(pnl) : 0;
  riskState.dailyLoss += loss;
  riskState.weeklyLoss += loss;
  riskState.monthlyLoss += loss;
  riskState.dailyRisk += risk;
  riskState.equity += pnl;
  if (riskState.equity > riskState.equityPeak)
    riskState.equityPeak = riskState.equity;
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
      riskState.equity <
        riskState.equityPeak * (1 - riskState.equityDrawdownLimitPct))
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
  const sec = sector || "GEN";
  const sc = riskState.tradesPerSector.get(sec) || 0;
  riskState.tradesPerSector.set(sec, sc + 1);
  riskState.lastTradeTime = Date.now();
}

export function isSignalValid(signal, ctx = {}) {
  const now = Date.now();
  const today = new Date().getDate();
  const week = getWeekNumber();
  const month = new Date().getMonth();
  const debugTrace = Array.isArray(ctx.debugTrace)
    ? ctx.debugTrace
    : riskDebug
    ? []
    : null;
  const symbol = signal.stock || signal.symbol || "UNKNOWN";
  const recordRejection = (code, details = {}) => {
    if (debugTrace) {
      debugTrace.push(
        Object.keys(details).length ? { code, details } : { code }
      );
    }
    if (riskDebug) {
      try {
        const info = Object.keys(details).length
          ? ` ${JSON.stringify(details)}`
          : "";
        console.log(`[RISK][${symbol}] ${code}${info}`);
      } catch (err) {
        console.log(`[RISK][${symbol}] ${code}`);
      }
    }
    return debugTrace
      ? { ok: false, reason: code, trace: debugTrace }
      : false;
  };
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
  if (riskState.systemPaused) return recordRejection("systemPaused");
  const bucketMs = ctx.timeBucketMs || 60 * 1000;
  const bucket = Math.floor(now / bucketMs);
  const count = riskState.timeBuckets.get(bucket) || 0;
  if (
    typeof ctx.maxSimultaneousSignals === "number" &&
    count >= ctx.maxSimultaneousSignals
  )
    return recordRejection("tooManySimultaneousSignals", {
      max: ctx.maxSimultaneousSignals,
    });
  riskState.timeBuckets.set(bucket, count + 1);
  if (riskState.timeBuckets.size > 10) {
    for (const [k] of riskState.timeBuckets) {
      if (k < bucket - 10) riskState.timeBuckets.delete(k);
    }
  }
  const maxSignals = ctx.maxSignalsPerDay ?? riskState.maxSignalsPerDay;
  if (riskState.signalCount > maxSignals)
    return recordRejection("maxSignalsPerDay", {
      max: maxSignals,
      count: riskState.signalCount,
    });
  if (
    typeof ctx.highVolatilityThresh === "number" &&
    typeof ctx.volatility === "number" &&
    ctx.volatility > ctx.highVolatilityThresh
  ) {
    const interval =
      (ctx.throttleMs ?? riskState.volatilityThrottleMs) || 60000;
    if (now - riskState.lastTradeTime < interval)
      return recordRejection("volatilityThrottle", {
        interval,
        lastTradeTime: riskState.lastTradeTime,
      });
  }
  if (
    typeof ctx.signalFloodThreshold === "number" &&
    riskState.signalCount > ctx.signalFloodThreshold
  ) {
    const interval = ctx.signalFloodThrottleMs || 60000;
    if (now - riskState.lastTradeTime < interval)
      return recordRejection("signalFloodThrottle", {
        interval,
        lastTradeTime: riskState.lastTradeTime,
      });
  }

  if (
    typeof ctx.indexVolatility === "number" &&
    typeof ctx.maxIndexVolatility === "number" &&
    ctx.indexVolatility > ctx.maxIndexVolatility
  )
    return recordRejection("indexVolatility", {
      max: ctx.maxIndexVolatility,
      value: ctx.indexVolatility,
    });
  if (
    typeof ctx.vwapParticipation === "number" &&
    typeof ctx.minVwapParticipation === "number" &&
    ctx.vwapParticipation < ctx.minVwapParticipation
  )
    return recordRejection("vwapParticipation", {
      min: ctx.minVwapParticipation,
      value: ctx.vwapParticipation,
    });
  if (ctx.negativeNews) return recordRejection("negativeNews");
  if (
    ctx.maxSignalAgeMinutes &&
    signal.generatedAt &&
    now - new Date(signal.generatedAt).getTime() >
      ctx.maxSignalAgeMinutes * 60 * 1000
  )
    return recordRejection("signalTooOld", {
      maxMinutes: ctx.maxSignalAgeMinutes,
    });

  const maxLoss = ctx.maxDailyLoss ?? riskState.maxDailyLoss;
  if (riskState.dailyLoss >= maxLoss)
    return recordRejection("maxDailyLoss", {
      loss: riskState.dailyLoss,
      max: maxLoss,
    });
  const maxLossPct = ctx.maxDailyLossPct ?? riskState.maxDailyLossPct;
  if (
    maxLossPct > 0 &&
    riskState.equityPeak > 0 &&
    riskState.dailyLoss / riskState.equityPeak >= maxLossPct
  )
    return recordRejection("maxDailyLossPct", {
      loss: riskState.dailyLoss,
      peak: riskState.equityPeak,
      maxPct: maxLossPct,
    });
  const maxCum = ctx.maxCumulativeLoss ?? riskState.maxCumulativeLoss;
  if (maxCum > 0 && riskState.dailyLoss >= maxCum)
    return recordRejection("maxCumulativeLoss", {
      loss: riskState.dailyLoss,
      max: maxCum,
    });
  const maxWeekly = ctx.maxWeeklyDrawdown ?? riskState.maxWeeklyDrawdown;
  if (maxWeekly > 0 && riskState.weeklyLoss >= maxWeekly)
    return recordRejection("maxWeeklyDrawdown", {
      loss: riskState.weeklyLoss,
      max: maxWeekly,
    });
  const maxMonthly = ctx.maxMonthlyDrawdown ?? riskState.maxMonthlyDrawdown;
  if (maxMonthly > 0 && riskState.monthlyLoss >= maxMonthly)
    return recordRejection("maxMonthlyDrawdown", {
      loss: riskState.monthlyLoss,
      max: maxMonthly,
    });
  const drawdownLimit =
    ctx.equityDrawdownLimitPct ?? riskState.equityDrawdownLimitPct;
  if (
    drawdownLimit > 0 &&
    riskState.equityPeak > 0 &&
    riskState.equity < riskState.equityPeak * (1 - drawdownLimit)
  )
    return recordRejection("equityDrawdown", {
      equity: riskState.equity,
      peak: riskState.equityPeak,
      limitPct: drawdownLimit,
    });
  const maxRisk = ctx.maxDailyRisk ?? riskState.maxDailyRisk;
  if (riskState.dailyRisk >= maxRisk)
    return recordRejection("maxDailyRisk", {
      risk: riskState.dailyRisk,
      max: maxRisk,
    });
  const maxTrades = ctx.maxTradesPerDay ?? riskState.maxTradesPerDay;
  if (riskState.tradeCount >= maxTrades)
    return recordRejection("maxTradesPerDay", {
      trades: riskState.tradeCount,
      max: maxTrades,
    });
  const maxStreak = ctx.maxLossStreak ?? riskState.maxLossStreak;
  if (riskState.consecutiveLosses >= maxStreak)
    return recordRejection("maxLossStreak", {
      losses: riskState.consecutiveLosses,
      max: maxStreak,
    });
  if (ctx.cooloffAfterLoss && riskState.lastTradeWasLoss)
    return recordRejection("cooloffAfterLoss");
  if (
    typeof ctx.maxOpenPositions === "number" &&
    typeof ctx.openPositionsCount === "number" &&
    ctx.openPositionsCount >= ctx.maxOpenPositions
  )
    return recordRejection("maxOpenPositions", {
      count: ctx.openPositionsCount,
      max: ctx.maxOpenPositions,
    });
  if (ctx.preventOverlap && Array.isArray(ctx.openSymbols)) {
    if (ctx.openSymbols.includes(signal.stock || signal.symbol))
      return recordRejection("preventOverlap", {
        symbol: signal.stock || signal.symbol,
      });
  }
  const dir = signal.direction === "Long" ? "long" : "short";
  if (ctx.openPositionsMap instanceof Map) {
    const existing = ctx.openPositionsMap.get(signal.stock || signal.symbol);
    if (existing && existing.side && existing.side.toLowerCase() !== dir)
      return recordRejection("positionConflict", {
        existing: existing.side,
        requested: dir,
      });
  }
  if (
    ctx.resolveConflicts &&
    !resolveSignalConflicts({
      symbol: signal.stock || signal.symbol,
      side: dir,
      strategy:
        signal.algoSignal?.strategy || signal.pattern || signal.strategy,
    })
  )
    return recordRejection("resolveConflictBlocked");

  const inst = signal.stock || signal.symbol;
  if (ctx.blockWatchlist && riskState.watchList.has(inst))
    return recordRejection("watchlistBlocked");
  const stratKey = `${inst}-${
    signal.algoSignal?.strategy || signal.pattern || signal.strategy
  }`;
  if (
    ctx.strategyFailWindowMs &&
    riskState.strategyFailMap.has(stratKey) &&
    now - riskState.strategyFailMap.get(stratKey) < ctx.strategyFailWindowMs
  )
    return recordRejection("strategyCooldown", {
      lastFailure: riskState.strategyFailMap.get(stratKey),
      windowMs: ctx.strategyFailWindowMs,
    });
  const instCount = riskState.tradesPerInstrument.get(inst) || 0;
  const maxPerInst =
    ctx.maxTradesPerInstrument ?? riskState.maxTradesPerInstrument;
  if (instCount >= maxPerInst)
    return recordRejection("maxTradesPerInstrument", {
      count: instCount,
      max: maxPerInst,
    });

  const sec = signal.sector || "GEN";
  const secCount = riskState.tradesPerSector.get(sec) || 0;
  const maxPerSec = ctx.maxTradesPerSector ?? riskState.maxTradesPerSector;
  if (secCount >= maxPerSec)
    return recordRejection("maxTradesPerSector", {
      count: secCount,
      max: maxPerSec,
    });

  if (
    typeof ctx.minTradeValue === "number" &&
    typeof ctx.tradeValue === "number" &&
    ctx.tradeValue < ctx.minTradeValue
  )
    return recordRejection("minTradeValue", {
      min: ctx.minTradeValue,
      value: ctx.tradeValue,
    });
  if (
    typeof ctx.maxTradeValue === "number" &&
    typeof ctx.tradeValue === "number" &&
    ctx.tradeValue > ctx.maxTradeValue
  )
    return recordRejection("maxTradeValue", {
      max: ctx.maxTradeValue,
      value: ctx.tradeValue,
    });
  if (
    typeof ctx.volatilityFilter === "number" &&
    typeof signal.atr === "number" &&
    signal.atr > ctx.volatilityFilter
  )
    return recordRejection("volatilityFilter", {
      atr: signal.atr,
      max: ctx.volatilityFilter,
    });
  if (ctx.allowPyramiding === false && ctx.hasPositionForSymbol)
    return recordRejection("pyramidingDisabled");

  const conf = signal.confidence ?? signal.confidenceScore ?? 0;
  const aiOverride =
    typeof ctx.aiOverrideThreshold === "number" &&
    typeof ctx.mlConfidence === "number" &&
    ctx.mlConfidence >= ctx.aiOverrideThreshold;
  if (
    typeof ctx.minConfidence === "number" &&
    conf < ctx.minConfidence &&
    !aiOverride
  )
    return recordRejection("minConfidence", {
      min: ctx.minConfidence,
      confidence: conf,
    });
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
    typeof ctx.minMlConfidence === "number" &&
    typeof ctx.mlConfidence === "number" &&
    ctx.mlConfidence < ctx.minMlConfidence
  )
    return recordRejection("minMlConfidence", {
      min: ctx.minMlConfidence,
      value: ctx.mlConfidence,
    });
  if (
    typeof ctx.minBacktestWinRate === "number" &&
    typeof ctx.backtestWinRate === "number" &&
    ctx.backtestWinRate < ctx.minBacktestWinRate
  )
    return recordRejection("minBacktestWinRate", {
      min: ctx.minBacktestWinRate,
      value: ctx.backtestWinRate,
    });
  if (
    typeof ctx.minRecentAccuracy === "number" &&
    typeof ctx.recentAccuracy === "number" &&
    ctx.recentAccuracy < ctx.minRecentAccuracy
  )
    return recordRejection("minRecentAccuracy", {
      min: ctx.minRecentAccuracy,
      value: ctx.recentAccuracy,
    });
  if (
    typeof ctx.maxEntryStdDev === "number" &&
    typeof ctx.entryStdDev === "number" &&
    ctx.entryStdDev > ctx.maxEntryStdDev
  )
    return recordRejection("maxEntryStdDev", {
      max: ctx.maxEntryStdDev,
      value: ctx.entryStdDev,
    });
  if (
    typeof ctx.minZScoreAbs === "number" &&
    typeof ctx.zScore === "number" &&
    Math.abs(ctx.zScore) < ctx.minZScoreAbs
  )
    return recordRejection("minZScoreAbs", {
      min: ctx.minZScoreAbs,
      value: ctx.zScore,
    });
  if (
    typeof ctx.maxRiskScore === "number" &&
    typeof signal.riskScore === "number" &&
    signal.riskScore > ctx.maxRiskScore
  )
    return recordRejection("maxRiskScore", {
      max: ctx.maxRiskScore,
      value: signal.riskScore,
    });

  const upper = signal.upperCircuit ?? ctx.upperCircuit;
  const lower = signal.lowerCircuit ?? ctx.lowerCircuit;
  if (typeof upper === "number" && signal.entry >= upper * 0.99)
    return recordRejection("nearUpperCircuit", {
      entry: signal.entry,
      upper,
    });
  if (typeof lower === "number" && signal.entry <= lower * 1.01)
    return recordRejection("nearLowerCircuit", {
      entry: signal.entry,
      lower,
    });
  if (signal.inGapZone || ctx.inGapZone)
    return recordRejection("gapZone", { gapZone: true });

  if (signal.expiresAt && now > new Date(signal.expiresAt).getTime())
    return recordRejection("signalExpired", {
      expiresAt: signal.expiresAt,
    });

  if (
    ![signal.entry, signal.stopLoss].every(
      (x) => typeof x === "number" && Number.isFinite(x)
    )
  ) {
    return recordRejection("invalidPrices", {
      entry: signal.entry,
      stopLoss: signal.stopLoss,
    });
  }

  const rr = validateRR({
    strategy:
      signal.algoSignal?.strategy || signal.pattern || signal.strategy,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    target: signal.target2 ?? signal.target,
    winrate: ctx.winrate || 0,
  });
  if (!rr.valid)
    return recordRejection("rrBelowMinimum", {
      rr: rr.rr,
      min: rr.minRR,
    });
  const minRR = ctx.minRR ?? 2;
  if (rr.rr < minRR)
    return recordRejection("rrBelowThreshold", { rr: rr.rr, minRR });

  if (
    signal.atr &&
    Math.abs(signal.entry - signal.stopLoss) > (ctx.maxSLATR ?? 2) * signal.atr
  )
    return recordRejection("slAtrTooWide", {
      atr: signal.atr,
      slDistance: Math.abs(signal.entry - signal.stopLoss),
      maxMultiplier: ctx.maxSLATR ?? 2,
    });

  if (
    !validateATRStopLoss({
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      atr: signal.atr,
    })
  )
    return recordRejection("atrStopLossInvalid");

  if (
    isSLInvalid({
      price: ctx.currentPrice ?? signal.entry,
      stopLoss: signal.stopLoss,
      atr: signal.atr,
      structureBreak: ctx.structureBreak,
    })
  )
    return recordRejection("slInvalid", {
      price: ctx.currentPrice ?? signal.entry,
      stopLoss: signal.stopLoss,
    });

  if (
    !validateSupportResistance({
      entry: signal.entry,
      direction: signal.direction,
      support: signal.support,
      resistance: signal.resistance,
      atr: signal.atr,
    })
  )
    return recordRejection("supportResistanceFail", {
      support: signal.support,
      resistance: signal.resistance,
    });

  if (
    !validateVolumeSpike({
      volume: signal.volume ?? ctx.volume,
      avgVolume: ctx.avgVolume,
    })
  )
    return recordRejection("volumeSpikeFail", {
      volume: signal.volume ?? ctx.volume,
      avgVolume: ctx.avgVolume,
    });
  if (
    ctx.requireMomentum &&
    typeof ctx.rsi === "number" &&
    ((signal.direction === "Long" && ctx.rsi < (ctx.minRsi ?? 55)) ||
      (signal.direction === "Short" && ctx.rsi > (ctx.maxRsi ?? 45)))
  )
    return recordRejection("momentumRsi", {
      rsi: ctx.rsi,
      minRsi: ctx.minRsi ?? 55,
      maxRsi: ctx.maxRsi ?? 45,
      direction: signal.direction,
    });
  if (
    ctx.requireMomentum &&
    typeof ctx.adx === "number" &&
    ctx.adx < (ctx.minAdx ?? 20)
  )
    return recordRejection("momentumAdx", {
      adx: ctx.adx,
      minAdx: ctx.minAdx ?? 20,
    });
  if (
    typeof ctx.minRvol === "number" &&
    typeof (signal.rvol ?? ctx.rvol) === "number" &&
    (signal.rvol ?? ctx.rvol) < ctx.minRvol
  )
    return recordRejection("minRvol", {
      rvol: signal.rvol ?? ctx.rvol,
      minRvol: ctx.minRvol,
    });

  if (
    typeof ctx.minLiquidity === "number" &&
    typeof (signal.liquidity ?? ctx.volume) === "number" &&
    (signal.liquidity ?? ctx.volume) < ctx.minLiquidity
  )
    return recordRejection("minLiquidity", {
      liquidity: signal.liquidity ?? ctx.volume,
      minLiquidity: ctx.minLiquidity,
    });

  if (
    typeof ctx.minVolume === "number" &&
    typeof (signal.liquidity ?? ctx.volume) === "number" &&
    (signal.liquidity ?? ctx.volume) < ctx.minVolume
  )
    return recordRejection("minVolume", {
      volume: signal.liquidity ?? ctx.volume,
      minVolume: ctx.minVolume,
    });

  if (
    typeof ctx.minVolumeRatio === "number" &&
    typeof ctx.avgVolume === "number" &&
    typeof (signal.liquidity ?? ctx.volume) === "number" &&
    (signal.liquidity ?? ctx.volume) < ctx.avgVolume * ctx.minVolumeRatio
  )
    return recordRejection("minVolumeRatio", {
      volume: signal.liquidity ?? ctx.volume,
      avgVolume: ctx.avgVolume,
      ratio: ctx.minVolumeRatio,
    });

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
      maxSpread: ctx.maxSpread,
      price: ctx.currentPrice ?? signal.entry,
    })
  )
    return recordRejection("volatilitySlippage", {
      atr: signal.atr,
      minATR: ctx.minVolatility,
      maxATR: ctx.maxVolatility,
      dailyRangePct: ctx.dailyRangePct,
      wickPct: ctx.wickPct,
      slippage: ctx.slippage,
      spread: signal.spread,
      maxSpreadPct: ctx.maxSpreadPct,
      maxSpread: ctx.maxSpread,
    });

  if (
    typeof ctx.minAtrPct === "number" &&
    typeof ctx.atrPct === "number" &&
    ctx.atrPct < ctx.minAtrPct
  ) {
    return recordRejection("minAtrPct", {
      atrPct: ctx.atrPct,
      minAtrPct: ctx.minAtrPct,
    });
  }

  if (typeof ctx.minATR === "number" && signal.atr < ctx.minATR)
    return recordRejection("minAtr", {
      atr: signal.atr,
      minATR: ctx.minATR,
    });
  if (typeof ctx.maxATR === "number" && signal.atr > ctx.maxATR)
    return recordRejection("maxAtr", {
      atr: signal.atr,
      maxATR: ctx.maxATR,
    });

  if (
    typeof ctx.minSLDistancePct === "number" &&
    Math.abs(signal.entry - signal.stopLoss) / signal.entry <
      ctx.minSLDistancePct
  )
    return recordRejection("minSlDistancePct", {
      distancePct: Math.abs(signal.entry - signal.stopLoss) / signal.entry,
      minPct: ctx.minSLDistancePct,
    });

  const slDist = Math.abs(signal.entry - signal.stopLoss);
  const lossPct = slDist / signal.entry;
  const maxPerTrade = ctx.maxLossPerTradePct ?? riskState.maxLossPerTradePct;
  if (maxPerTrade > 0 && lossPct > maxPerTrade)
    return recordRejection("maxLossPerTradePct", {
      lossPct,
      maxPct: maxPerTrade,
    });
  if (
    typeof signal.spread === "number" &&
    slDist > 0 &&
    signal.spread / slDist > (ctx.maxSpreadSLRatio ?? 0.3)
  )
    return recordRejection("spreadVsSl", {
      spread: signal.spread,
      slDist,
      maxRatio: ctx.maxSpreadSLRatio ?? 0.3,
    });

  const marketOk = checkMarketConditions({
    atr: signal.atr,
    avgAtr: ctx.avgAtr,
    indexTrend: ctx.indexTrend,
    signalDirection: signal.direction === "Long" ? "up" : "down",
    timeSinceSignal: ctx.timeSinceSignal ?? 0,
    volume: signal.liquidity ?? ctx.volume,
    spread: signal.spread,
    maxSpread: ctx.maxSpread,
    maxSpreadPct: ctx.maxSpreadPct,
    price: ctx.currentPrice ?? signal.entry,
    newsImpact: ctx.newsImpact,
    eventActive: ctx.eventActive,
  });
  if (!marketOk) return recordRejection("marketConditions");

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
  if (!timingOk) return recordRejection("timingFilters");

  const key = `${signal.stock || signal.symbol}-${signal.direction}-${
    signal.pattern || signal.algoSignal?.strategy || signal.strategy
  }`;
  const dupWindow = ctx.duplicateWindowMs || 5 * 60 * 1000;
  if (
    riskState.duplicateMap.has(key) &&
    now - riskState.duplicateMap.get(key) < dupWindow
  )
    return recordRejection("duplicateSignal", { windowMs: dupWindow });
  riskState.duplicateMap.set(key, now);

  if (ctx.marketRegime) {
    if (ctx.marketRegime === "bullish" && signal.direction === "Short")
      return recordRejection("bullishRegimeShort");
    if (ctx.marketRegime === "bearish" && signal.direction === "Long")
      return recordRejection("bearishRegimeLong");
  }

  const group = signal.correlationGroup || signal.sector;
  const corrWindow = ctx.correlationWindowMs || 5 * 60 * 1000;
  if (group) {
    if (
      riskState.correlationMap.has(group) &&
      now - riskState.correlationMap.get(group) < corrWindow
    )
      return recordRejection("correlationThrottle", {
        group,
        windowMs: corrWindow,
      });
    riskState.correlationMap.set(group, now);
  }

  if (ctx.addToWatchlist) riskState.watchList.add(inst);
  return debugTrace ? { ok: true, trace: debugTrace } : true;
}
