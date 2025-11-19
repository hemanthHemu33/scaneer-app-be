// scanner.js

import { computeFeatures, resetIndicatorCache } from "./featureEngine.js";
import {
  debounceSignal,
  calculateExpiryMinutes,
  toISTISOString,
  getMAForSymbol,
  isStrongPriceAction,
  getWickNoise,
  isAtrStable,
  isAwayFromConsolidation,
  sanitizeCandles,
  toSpreadPct,
} from "./util.js";

import {
  getSupportResistanceLevels,
  getHistoricalData,
  getTokenForSymbol,
} from "./kite.js";
import { evaluateAllStrategies } from "./strategyEngine.js";
import { evaluateStrategies } from "./strategies.js";
import { RISK_REWARD_RATIO, calculatePositionSize } from "./positionSizing.js";
import { isSignalValid, riskState } from "./riskEngine.js";
import { riskDefaults } from "./riskConfig.js";
import {
  openPositions,
  recordExit,
  checkExposureLimits,
} from "./portfolioContext.js";
import { logTrade } from "./tradeLogger.js";
import {
  marketContext,
  filterStrategiesByRegime,
} from "./smartStrategySelector.js";
import { signalQualityScore, applyPenaltyConditions } from "./confidence.js";
import { sendToExecution } from "./orderExecution.js";
import { initAccountBalance, getAccountBalance } from "./account.js";
import { calculateRequiredMargin } from "./util.js";
import { getAutoTradingConfig } from "./autoTrader.js";
import { scoreSwingOpportunity } from "./swingTrader.js";
import { buildSignal } from "./signalBuilder.js";
import { getSector } from "./sectors.js";
import { recordSectorSignal } from "./sectorSignals.js";
import { logSignalRejected } from "./auditLogger.js";
// 📊 Signal history tracking
const signalHistory = {};
let accountBalance = 0;
initAccountBalance().then((bal) => {
  accountBalance = bal;
  console.log(`[INIT] Account balance set to ${accountBalance}`);
});
const riskPerTradePercentage = 0.01;

// Portfolio exposure controls - use dynamic account balance as capital
const MAX_OPEN_TRADES = Number(process.env.MAX_OPEN_TRADES) || 10;
const SECTOR_CAPS = {
  // default sector caps; override via env if needed
};

// 🚦 Risk control state
// ⚙️ Scanner mode toggle
const MODE = "relaxed"; // Options: "strict" | "relaxed"
const FILTERS = {
  atrThreshold: MODE === "strict" ? 2 : 0.2,
  minBuySellRatio: MODE === "strict" ? 0.8 : 0.6,
  maxSpread: MODE === "strict" ? 1.5 : 2.0,
  minLiquidity: MODE === "strict" ? 500 : 300,
  maxATR: MODE === "strict" ? 3.5 : 5.0,
  rangeSpike: MODE === "strict" ? 10 : 15,
  consolidationRatio: MODE === "strict" ? 0.5 : 0.3,
  maxSlippage: MODE === "strict" ? 0.02 : 0.05,
  maxSpreadPct: MODE === "strict" ? 0.3 : 0.5,
};

let lastFeatureSeriesKey = null;

function logError(context, err) {
  console.error(
    `[${new Date().toISOString()}] ❌ [${context}] ${err?.message || err}`
  );
}

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
  try {
    const filters = { ...FILTERS, ...overrideFilters };

    if (!Array.isArray(candles) || candles.length === 0) return null;

    const today = new Date().getDate();
    if (riskState.lastResetDay !== today) {
      riskState.dailyLoss = 0;
      riskState.consecutiveLosses = 0;
      riskState.lastResetDay = today;
    }

    const dailyLossLimit = Number.isFinite(riskDefaults.maxDailyLoss)
      ? riskDefaults.maxDailyLoss
      : 500;
    const lossStreakLimit = Number.isFinite(riskDefaults.maxLossStreak)
      ? riskDefaults.maxLossStreak
      : 3;
    if (
      (dailyLossLimit > 0 && riskState.dailyLoss >= dailyLossLimit) ||
      (lossStreakLimit > 0 && riskState.consecutiveLosses >= lossStreakLimit)
    ) {
      console.log(`[RISK BLOCK] Skipping ${symbol}`);
      return null;
    }

    const cleanCandles = sanitizeCandles(candles);
    if (cleanCandles.length < 5) return null;
    const benchmarkCloses =
      marketContext?.benchmarkCloses?.[symbol] ??
      marketContext?.benchmark?.[symbol] ??
      marketContext?.benchmarks?.[symbol] ??
      null;
    const seriesKey = symbol ? `${symbol}:primary` : null;
    if (seriesKey && seriesKey !== lastFeatureSeriesKey) {
      resetIndicatorCache();
      lastFeatureSeriesKey = seriesKey;
    }
    const features = computeFeatures(cleanCandles, {
      seriesKey,
      supertrendSettings: { atrLength: 10, multiplier: 3 },
      only: [
        "ema9",
        "ema21",
        "ema50",
        "ema200",
        "rsi",
        "atr",
        "macd",
        "macdHist",
        "ttmSqueeze",
        "zScore",
        "rvol",
        "vwap",
      ],
      benchmarkCloses,
      rsLookback: 20,
    });
    if (!features) return null;

    const tokenNum = await getTokenForSymbol(symbol);
    const tokenStr =
      tokenNum !== undefined && tokenNum !== null ? String(tokenNum) : null;
    const dailyHistory = tokenStr ? await getHistoricalData(tokenStr) : [];
    const sessionData = cleanCandles;

    const {
      ema9,
      ema21,
      ema50,
      ema200,
      rsi,
      adx,
      supertrend,
      vwap,
      atr: atrValue = 1,
      rvol,
      avgVolume,
      emaSlope,
      trendStrength,
      volatilityClass,
    } = features;
    const last = cleanCandles.at(-1);
    const lastVol = (last && (last.volume ?? last.v ?? last.qty)) ?? 0;
    const effectiveLiquidity = liquidity || avgVolume || lastVol || 0;
    const spreadPct = toSpreadPct(spread, last?.close);
    const context = {
      symbol,
      candles: cleanCandles,
      features,
      depth,
      tick: liveTick,
      spread,
      spreadPct,
      liquidity: effectiveLiquidity,
      totalBuy,
      totalSell,
      dailyHistory,
      sessionCandles: sessionData,
      benchmarkCloses,
      rsLookback: 20,
    };
    let dailyRangePct = 0;
    if (Array.isArray(dailyHistory) && dailyHistory.length) {
      const d = dailyHistory[dailyHistory.length - 1];
      const dHigh = Number(d?.high);
      const dLow = Number(d?.low);
      const ref = Number(d?.close ?? d?.open ?? 0);
      if (Number.isFinite(dHigh) && Number.isFinite(dLow) && ref > 0) {
        dailyRangePct = ((dHigh - dLow) / ref) * 100;
      }
    }

    const wickPct = last ? getWickNoise(last) : 0;
    const strongPriceAction = isStrongPriceAction(cleanCandles);
    const atrStable = isAtrStable(cleanCandles);
    const lastPrice = Number.isFinite(last?.close)
      ? last.close
      : Number.isFinite(last?.open)
      ? last.open
      : undefined;
    const expiryMinutesRaw = calculateExpiryMinutes({
      atr: atrValue,
      rvol,
      price: lastPrice,
    });
    const expiryMinutes =
      Number.isFinite(expiryMinutesRaw) && expiryMinutesRaw > 0
        ? expiryMinutesRaw
        : 5;
    const expiresAtDate = new Date(Date.now() + expiryMinutes * 60 * 1000);
    const expiresAt = expiresAtDate.toISOString();

    const isUptrend = ema9 > ema21 && ema21 > ema50;
    const isDowntrend = ema9 < ema21 && ema21 < ema50;
    const vwapParticipation =
      Number.isFinite(vwap) && Number.isFinite(last?.close) && last.close > 0
        ? Math.max(0, Math.min(1, 1 - Math.abs(last.close - vwap) / last.close))
        : 0.9;

    // ⚠️ Momentum filter
    const atrPct = last?.close
      ? Math.min(100, (atrValue / Math.max(last.close, 1)) * 100)
      : null;
    if (typeof rsi === "number" && atrPct != null) {
      const inNoMoRSI = rsi > 47 && rsi < 53;
      const ultraLowAtr = atrPct < 0.1;
      if (inNoMoRSI && ultraLowAtr) {
        console.log(`[SKIP] ${symbol} - No momentum (RSI 47–53 & ATR<0.10%)`);
        return null;
      }
    }

    const { support, resistance } = await getSupportResistanceLevels(symbol);
    const upperCircuit = liveTick?.upper_circuit_limit;
    const lowerCircuit = liveTick?.lower_circuit_limit;

    const stratResults = evaluateAllStrategies({
      ...context,
      expiresAt,
      support,
      resistance,
      atr: atrValue,
      accountBalance,
      riskPerTradePercentage,
    });
    const altStrategies = evaluateStrategies(
      cleanCandles,
      {
        atr: atrValue,
        rvol,
        avgVolume,
        regime: marketContext?.regime,
        spreadPct,
        features,
        benchmarkCloses,
        rsLookback: 20,
      },
      { topN: 1, atr: atrValue }
    );
    const filtered = filterStrategiesByRegime(stratResults, marketContext);
    const basePick = (filtered.length ? filtered : stratResults)[0];
    if (!basePick) return null;
    const base = { ...basePick };

    const primaryStrategy = basePick?.strategy || "unknown";
    if (altStrategies && altStrategies[0]) {
      base.strategy = altStrategies[0].name;
      base.confidence = altStrategies[0].confidence;
    }
    const displayStrategy = altStrategies?.[0]?.name || primaryStrategy;
    base.strategy = displayStrategy;
    const riskStrategyKey =
      displayStrategy && displayStrategy !== primaryStrategy
        ? displayStrategy
        : base.strategyCategory || primaryStrategy;

    // Debounce logic now that strategy name is known
    const conflictWindow = 3 * 60 * 1000;
    if (
      !debounceSignal(
        signalHistory,
        symbol,
        base.direction,
        primaryStrategy,
        conflictWindow
      )
    )
      return null;
    // Step 5: Risk filter on raw strategy output
    // Preliminary signal for risk validation (no sizing or meta info)
    const preliminary = {
      stock: symbol,
      pattern: displayStrategy,
      direction: base.direction,
      entry: base.entry,
      stopLoss: base.stopLoss,
      target2: base.target2,
      target: base.target2 ?? base.target1,
      atr: atrValue,
      spread,
      liquidity: effectiveLiquidity,
      support,
      resistance,
      upperCircuit,
      lowerCircuit,
      // let the risk validator use our category mapping
      algoSignal: { strategy: riskStrategyKey || displayStrategy },
    };

    const momentumThresholds = {
      minRsi: isUptrend ? 47 : 49,
      maxRsi: isDowntrend ? 54 : 56,
      minAdx:
        typeof trendStrength === "number" && trendStrength > 0.6 ? 16 : 12,
      minRvol:
        marketContext.regime === "volatile"
          ? 0.85
          : marketContext.regime === "bearish"
          ? 0.65
          : 0.6,
    };

    const safeVix = Number.isFinite(marketContext?.vix) ? marketContext.vix : 0;
    const safeRegime = marketContext?.regime ?? "neutral";

    const baseRisk =
      Number.isFinite(base.entry) && Number.isFinite(base.stopLoss)
        ? Math.abs(base.entry - base.stopLoss)
        : null;
    let rrNumerator = Number.isFinite(base.target2 ?? base.target1)
      ? Math.abs((base.target2 ?? base.target1) - base.entry)
      : null;
    let riskReward =
      baseRisk && baseRisk > 0 && rrNumerator !== null
        ? rrNumerator / baseRisk
        : 0;

    if (!Number.isFinite(baseRisk) || baseRisk <= 0) {
      console.log(`[SKIP] ${symbol} - invalid baseRisk`, {
        entry: base.entry,
        sl: base.stopLoss,
      });
      return null;
    }

    const consolidationOk = isAwayFromConsolidation(cleanCandles, base.entry);
    const { getDrawdown } = await import("./account.js");
    const dd = typeof getDrawdown === "function" ? getDrawdown() : 0;
    const sizingOverrides = {};
    const setIfDefined = (key, value) => {
      if (value !== undefined) sizingOverrides[key] = value;
    };
    setIfDefined("lotSize", base.lotSize ?? riskDefaults.lotSize);
    setIfDefined("minLotSize", base.minLotSize ?? riskDefaults.minLotSize);
    setIfDefined("minQty", base.minQty ?? riskDefaults.minQty);
    setIfDefined("maxQty", base.maxQty ?? riskDefaults.maxQty);
    setIfDefined(
      "leverage",
      base.leverage ?? riskDefaults.leverage ?? marketContext?.leverage
    );
    setIfDefined(
      "marginPercent",
      base.marginPercent ??
        riskDefaults.marginPercent ??
        marketContext?.marginPercent
    );
    setIfDefined(
      "marginPerLot",
      base.marginPerLot ?? riskDefaults.marginPerLot
    );
    setIfDefined(
      "utilizationCap",
      base.utilizationCap ??
        riskDefaults.utilizationCap ??
        marketContext?.utilizationCap
    );
    setIfDefined(
      "marginBuffer",
      base.marginBuffer ?? riskDefaults.marginBuffer
    );
    setIfDefined(
      "exchangeMarginMultiplier",
      base.exchangeMarginMultiplier ?? riskDefaults.exchangeMarginMultiplier
    );
    setIfDefined(
      "costBuffer",
      base.costBuffer ?? riskDefaults.costBuffer ?? marketContext?.costBuffer
    );
    setIfDefined("drawdown", dd);
    setIfDefined("lossStreak", riskState?.consecutiveLosses ?? base.lossStreak);

    const appliedSlippage = Number.isFinite(sizingOverrides.slippage)
      ? sizingOverrides.slippage
      : Number.isFinite(base.slippage)
      ? base.slippage
      : Number.isFinite(slippage)
      ? slippage
      : 0;
    const appliedSpread = Number.isFinite(sizingOverrides.spread)
      ? sizingOverrides.spread
      : Number.isFinite(base.spread)
      ? base.spread
      : Number.isFinite(spread)
      ? spread
      : 0;
    const appliedCostBuffer = Number.isFinite(sizingOverrides.costBuffer)
      ? sizingOverrides.costBuffer
      : Number.isFinite(riskDefaults.costBuffer)
      ? riskDefaults.costBuffer
      : Number.isFinite(marketContext?.costBuffer)
      ? marketContext.costBuffer
      : 1;

    sizingOverrides.slippage = appliedSlippage;
    sizingOverrides.spread = appliedSpread;
    sizingOverrides.costBuffer = appliedCostBuffer;

    const rawStopDistance = baseRisk;
    const effectiveStopDistance =
      (rawStopDistance + appliedSlippage + appliedSpread) * appliedCostBuffer;

    let target1 = base.target1;
    let target2 = base.target2 ?? base.target1;
    if (
      Number.isFinite(effectiveStopDistance) &&
      effectiveStopDistance > 0 &&
      Number.isFinite(base.entry)
    ) {
      const directionSign = base.direction === "Short" ? -1 : 1;
      const targetDistance = effectiveStopDistance * RISK_REWARD_RATIO;
      const partialDistance = targetDistance * 0.5;
      target1 = base.entry + directionSign * partialDistance;
      target2 = base.entry + directionSign * targetDistance;
    }

    rrNumerator = Number.isFinite(target2 ?? target1)
      ? Math.abs((target2 ?? target1) - base.entry)
      : rrNumerator;
    if (
      Number.isFinite(effectiveStopDistance) &&
      effectiveStopDistance > 0 &&
      rrNumerator !== null
    ) {
      riskReward = rrNumerator / effectiveStopDistance;
    }

    if (target1 !== undefined && preliminary.target1 === undefined) {
      preliminary.target1 = target1;
    }
    if (target2 !== undefined) {
      preliminary.target2 = target2;
      preliminary.target = target2;
    } else if (target1 !== undefined) {
      preliminary.target = target1;
    }

    const sizingDebug = {};

    let qty = calculatePositionSize({
      capital: accountBalance,
      risk: accountBalance * riskPerTradePercentage,
      slPoints: baseRisk,
      price: base.entry,
      volatility: atrValue,
      debug: sizingDebug,
      ...sizingOverrides,
    });
    if (riskReward > 2) qty = Math.floor(qty * 1.1);
    else if (riskReward < 1.2) qty = Math.floor(qty * 0.9);
    qty = Math.max(1, qty || 0);
    sizingDebug.signalQty = qty;
    const tradeValue =
      Number.isFinite(base.entry) && qty ? base.entry * qty : undefined;
    if (tradeValue !== undefined) preliminary.tradeValue = tradeValue;

    console.log(`[DIAG] ${symbol}`, {
      lastClose: last?.close,
      rsi,
      adx,
      ema9,
      ema21,
      ema50,
      vwap,
      atrValue,
      atrPct,
      wickPct,
      rvol,
      avgVolume,
      effectiveLiquidity,
      vix: safeVix,
      regime: safeRegime,
      spread: appliedSpread,
      slippage: appliedSlippage,
      rr: Number.isFinite(riskReward) ? riskReward.toFixed(2) : null,
    });

    const now = new Date();
    const priceSeries = cleanCandles
      .map((c) => (Number.isFinite(c?.close) ? c.close : null))
      .filter((v) => Number.isFinite(v));
    const maxOpenPositions = Number.isFinite(riskDefaults.maxOpenPositions)
      ? riskDefaults.maxOpenPositions
      : MAX_OPEN_TRADES;
    const maxSpreadSlRatio =
      riskDefaults.maxSpreadSLRatio ?? riskDefaults.maxSpreadSlRatio ?? 0.3;

    const riskCtx = {
      // Provide win-rate so RR validator can adjust for scalping/fade setups
      winrate:
        marketContext?.strategyWinrates?.[displayStrategy] ??
        marketContext?.winrate ??
        0,
      avgAtr: atrValue,
      indexTrend: isUptrend ? "up" : isDowntrend ? "down" : "sideways",
      indexVolatility: safeVix,
      timeSinceSignal: 0,
      volume: effectiveLiquidity,
      avgVolume,
      currentPrice: liveTick ? liveTick.last_price : last.close,
      marketRegime: safeRegime,
      vwapParticipation,
      rsi,
      adx,
      requireMomentum: true,
      maxATR: FILTERS.maxATR,
      minVolatility: FILTERS.atrThreshold,
      maxVolatility: FILTERS.maxATR,
      dailyRangePct,
      rangeSpikeThreshold: FILTERS.rangeSpike,
      wickPct,
      consolidationVolumeRatio: FILTERS.consolidationRatio,
      slippage,
      maxSlippage: FILTERS.maxSlippage,
      maxSpread: FILTERS.maxSpread,
      maxSpreadPct: FILTERS.maxSpreadPct,
      maxSpreadSLRatio: maxSpreadSlRatio,
      minRR: RISK_REWARD_RATIO,
      minLiquidity: effectiveLiquidity ? FILTERS.minLiquidity : 0,
      minVolumeRatio: 0.4,
      minVwapParticipation: 0.9,
      maxIndexVolatility: 20,
      blockWatchlist: false,
      addToWatchlist: false,
      now,
      tradeValue,
      openPositionsCount: openPositions.size,
      openPositionsMap: openPositions,
      openSymbols: Array.from(openPositions.keys()),
      hasPositionForSymbol: openPositions.has(symbol),
      maxOpenPositions,
      preventOverlap: true,
      resolveConflicts: true,
      prices: priceSeries,
      stdLookback: 5,
      zLookback: 20,
      maxSignalAgeMinutes: 5,
      strategyFailWindowMs: 15 * 60 * 1000,
      minSLDistancePct: 0.0005,
      minRsi: momentumThresholds.minRsi,
      maxRsi: momentumThresholds.maxRsi,
      minAdx: momentumThresholds.minAdx,
      minRvol: momentumThresholds.minRvol,
      atrPct,
      minAtrPct: 0.12,
    };
    riskCtx.debugTrace = [];
    const riskVerdict = isSignalValid(preliminary, riskCtx);
    const riskOk =
      typeof riskVerdict === "object" ? !!riskVerdict.ok : !!riskVerdict;
    if (!riskOk) {
      const reason =
        typeof riskVerdict === "object"
          ? riskVerdict.reason
          : "riskValidationFail";
      const debugTrace =
        typeof riskVerdict === "object" && Array.isArray(riskVerdict.trace)
          ? riskVerdict.trace
          : Array.isArray(riskCtx.debugTrace)
          ? riskCtx.debugTrace
          : null;
      if (debugTrace?.length) {
        const reasonSummary = debugTrace.map((entry) => entry.code).join(", ");
        console.log(`[RISK] ${symbol} blocked: ${reasonSummary}`);
      }
      try {
        const rejectionCtx = debugTrace?.length
          ? { ...riskCtx, debugTrace: [...debugTrace] }
          : riskCtx;
        await logSignalRejected(
          `${symbol}-${Date.now()}`,
          reason,
          rejectionCtx,
          preliminary
        );
      } catch (e) {
        logError("logSignalRejected", e);
      }
      return null;
    }

    // Step 6: Position sizing already computed above; package for builders
    const tradeParams = {
      entry: base.entry,
      stopLoss: base.stopLoss,
      target1,
      target2,
      qty,
    };

    const ma20Val = await getMAForSymbol(symbol, 20);
    const ma50Val = await getMAForSymbol(symbol, 50);
    const contextForBuild = {
      symbol,
      instrumentToken: tokenNum ?? tokenStr,
      ma20Val,
      ma50Val,
      ema9,
      ema21,
      ema50,
      ema200,
      rsi,
      supertrend,
      atrValue,
      slippage: appliedSlippage,
      spread: appliedSpread,
      liquidity: effectiveLiquidity,
      liveTick,
      depth,
      rrMultiplier: RISK_REWARD_RATIO,
      rvol,
      vwap,
      expiryMinutes,
      riskReward,
      trendStrength,
      volatilityClass,
      emaSlope,
      isUptrend,
      isDowntrend,
      strategyName: base.strategy,
      strategyConfidence: base.confidence,
      support,
      resistance,
      finalScore: signalQualityScore(
        {
          atr: atrValue,
          rvol,
          strongPriceAction,
          cleanBody: wickPct < 0.3,
          rrRatio: riskReward,
          atrStable,
          awayFromConsolidation: consolidationOk,
        },
        { symbol, strategy: base.strategy }
      ),
      expiresAt,
      riskAmount: accountBalance * riskPerTradePercentage,
      accountBalance,
      baseRisk,
      rawStopDistance,
      effectiveStopDistance,
      costBufferApplied: appliedCostBuffer,
      sizingDebug,
    };

    // Step 7: Append meta information and build final signal
    const { signal } = buildSignal(
      contextForBuild,
      {
        type: base.strategy,
        strength: base.confidence,
        direction: base.direction,
      },
      tradeParams,
      base.confidence
    );

    signal.expiresAt = toISTISOString(expiresAtDate);
    signal.algoSignal = { strategy: displayStrategy };
    signal.upperCircuit = upperCircuit;
    signal.lowerCircuit = lowerCircuit;
    signal.ai = null; // Step 8: final enrichment placeholder

    const penaltyAdjusted = applyPenaltyConditions(signal.confidenceScore, {
      doji: wickPct > 0.6 || !strongPriceAction,
      lowVolume:
        effectiveLiquidity && avgVolume && effectiveLiquidity < avgVolume * 0.5,
      againstTrend:
        (base.direction === "Long" && isDowntrend) ||
        (base.direction === "Short" && isUptrend),
      lateSession: new Date(signal.generatedAt).getHours() >= 15,
      signalOverload: riskState.signalCount > 10,
      wickHeavy: wickPct > 0.6,
      badRR: riskReward < 1.5,
      positionConflict:
        openPositions.has(symbol) &&
        openPositions.get(symbol).side !==
          (base.direction === "Long" ? "buy" : "sell"),
    });
    signal.confidence = penaltyAdjusted;
    signal.confidenceScore = penaltyAdjusted;
    signal.strategy = displayStrategy;
    const swingSummary = scoreSwingOpportunity(signal);
    signal.swingScore = swingSummary.score;
    signal.swingBreakdown = swingSummary.breakdown;

    const sector = getSector(symbol);
    recordSectorSignal(sector, signal.direction);

    return signal;
  } catch (err) {
    logError(`analyzeCandles for ${symbol}`, err);
    return null;
  }
}

export function getSignalHistory() {
  return signalHistory;
}

// Rank signals and send top one to execution
export async function rankAndExecute(signals = []) {
  const { selectTopSignal } = await import("./signalRanker.js");
  const { validatePreExecution } = await import("./riskValidator.js");
  const top = selectTopSignal(signals);
  const result = {
    candidate: top || null,
    top: null,
    orders: null,
    reason: null,
  };
  if (!top) return result;
  const autoConfig = getAutoTradingConfig();
  const effectiveConfidence =
    top.confidence ?? top.confidenceScore ?? top.algoSignal?.confidence;
  if (
    autoConfig.minConfidence !== null &&
    effectiveConfidence !== undefined &&
    effectiveConfidence < autoConfig.minConfidence
  ) {
    result.reason = "confidence";
    return result;
  }

  const swingSummary =
    typeof top.swingScore === "number"
      ? { score: top.swingScore, breakdown: top.swingBreakdown }
      : scoreSwingOpportunity(top);
  top.swingScore = swingSummary.score;
  top.swingBreakdown = swingSummary.breakdown;
  if (
    autoConfig.minSwingScore !== null &&
    top.swingScore < autoConfig.minSwingScore
  ) {
    result.reason = "swing";
    return result;
  }

  const { refreshAccountBalance } = await import("./account.js");
  await refreshAccountBalance();
  accountBalance = getAccountBalance();
  // final pre-exec gate (uses robust spread% logic)
  const ok = validatePreExecution(top, {
    avgAtr: top.atr,
    indexTrend: top.isUptrend ? "up" : top.isDowntrend ? "down" : "sideways",
    timeSinceSignal: 0,
    volume: top.liquidity ?? 0,
    currentPrice: top.entry,
    maxSpread: FILTERS.maxSpread,
    maxSpreadPct: FILTERS.maxSpreadPct,
    winrate:
      marketContext?.strategyWinrates?.[top.strategy] ??
      marketContext?.winrate ??
      0,
    costBuffer:
      top.costBufferApplied ??
      top.costBuffer ??
      marketContext?.costBuffer ??
      riskDefaults.costBuffer,
    slippage: top.slippage ?? marketContext?.slippage ?? 0,
    spread: top.spread ?? marketContext?.spread ?? 0,
    support: top.support,
    resistance: top.resistance,
  });
  if (!ok) {
    result.reason = "validation";
    return result;
  }
  const requiredMargin = calculateRequiredMargin({
    price: top.entry,
    qty: top.qty,
  });
  const tradeValue = top.entry * top.qty;
  const sector = getSector(top.stock || top.symbol);
  const maxOpen =
    autoConfig.maxOpenTrades && autoConfig.maxOpenTrades > 0
      ? Math.min(autoConfig.maxOpenTrades, MAX_OPEN_TRADES)
      : MAX_OPEN_TRADES;
  const exposureOk =
    openPositions.size < maxOpen &&
    checkExposureLimits({
      symbol: top.stock || top.symbol,
      tradeValue,
      sector,
      totalCapital: accountBalance,
      sectorCaps: SECTOR_CAPS,
    });
  if (!exposureOk) {
    console.log(
      `[PORTFOLIO] Exposure limits blocked trade for ${
        top.stock || top.symbol
      }`
    );
    result.reason = "exposure";
    return result;
  }
  if (accountBalance >= requiredMargin) {
    const execution = await sendToExecution(top);
    if (execution) {
      const label = top.pattern || top.strategy || top.strategyName || "signal";
      const swingPct =
        top.swingScore !== undefined
          ? `${Math.round(top.swingScore * 1000) / 10}%`
          : "n/a";
      const confidencePct =
        effectiveConfidence !== undefined
          ? `${Math.round(effectiveConfidence * 1000) / 10}%`
          : "n/a";
      console.log(
        `[AUTO-EXEC] Submitted ${
          top.stock || top.symbol
        } via ${label} (confidence ${confidencePct}, swing ${swingPct})`
      );
      result.top = top;
      result.orders = execution;
    } else {
      result.reason = "execution-failed";
    }
  } else {
    console.log(
      `[SKIP] Insufficient margin. Required ${requiredMargin}, available ${accountBalance} for ${
        top.stock || top.symbol
      }`
    );
    result.reason = "margin";
  }
  return result;
}

export { getAccountBalance, initAccountBalance };
