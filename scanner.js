// scanner.js

import { computeFeatures } from "./featureEngine.js";
import {
  debounceSignal,
  calculateExpiryMinutes,
  toISTISOString,
  getMAForSymbol,
  isStrongPriceAction,
  getWickNoise,
  isAtrStable,
  isAwayFromConsolidation,
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

    if (riskState.dailyLoss >= 50000 || riskState.consecutiveLosses >= 333) {
      console.log(`[RISK BLOCK] Skipping ${symbol}`);
      return null;
    }

    // Filter out malformed candle objects
    const validCandles = candles.filter(
      (c) =>
        c &&
        typeof c.open === "number" &&
        !isNaN(c.open) &&
        typeof c.high === "number" &&
        !isNaN(c.high) &&
        typeof c.low === "number" &&
        !isNaN(c.low) &&
        typeof c.close === "number" &&
        !isNaN(c.close)
    );
    if (validCandles.length < 5) return null;
    const features = computeFeatures(validCandles);
    if (!features) return null;

    const tokenNum = await getTokenForSymbol(symbol);
    const tokenStr =
      tokenNum !== undefined && tokenNum !== null ? String(tokenNum) : null;
    const dailyHistory = tokenStr ? await getHistoricalData(tokenStr) : [];
    const sessionData = candles;

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
    const last = validCandles.at(-1);
    const lastVol = (last && (last.volume ?? last.v ?? last.qty)) ?? 0;
    const effectiveLiquidity = liquidity || avgVolume || lastVol || 0;
    const context = {
      symbol,
      candles: validCandles,
      features,
      depth,
      tick: liveTick,
      spread,
      liquidity: effectiveLiquidity,
      totalBuy,
      totalSell,
      dailyHistory,
      sessionCandles: sessionData,
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
    const strongPriceAction = isStrongPriceAction(validCandles);
    const atrStable = isAtrStable(validCandles);
    const expiryMinutesRaw = calculateExpiryMinutes({ atr: atrValue, rvol });
    const expiryMinutes =
      Number.isFinite(expiryMinutesRaw) && expiryMinutesRaw > 0
        ? expiryMinutesRaw
        : 5;
    const expiresAt = new Date(
      Date.now() + expiryMinutes * 60 * 1000
    ).toISOString();

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

    const stratResults = evaluateAllStrategies({
      ...context,
      expiresAt,
      support,
      resistance,
      accountBalance,
      riskPerTradePercentage,
    });
    const altStrategies = evaluateStrategies(validCandles, {
      topN: 1,
    });
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
      atr: atrValue,
      spread,
      liquidity: effectiveLiquidity,
      support,
      resistance,
      // let the risk validator use our category mapping
      algoSignal: riskStrategyKey ? { strategy: riskStrategyKey } : undefined,
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

    const diagBaseRisk =
      Number.isFinite(base.entry) && Number.isFinite(base.stopLoss)
        ? Math.abs(base.entry - base.stopLoss)
        : null;
    const diagRrNumerator = Number.isFinite(base.target2 ?? base.target1)
      ? Math.abs((base.target2 ?? base.target1) - base.entry)
      : null;
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
      spread,
      slippage,
      rr:
        diagBaseRisk && diagBaseRisk > 0 && diagRrNumerator !== null
          ? (diagRrNumerator / diagBaseRisk).toFixed(2)
          : null,
    });

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
      minRR: RISK_REWARD_RATIO,
      minLiquidity: effectiveLiquidity ? FILTERS.minLiquidity : 0,
      minVolumeRatio: 0.4,
      minVwapParticipation: 0.9,
      maxIndexVolatility: 20,
      blockWatchlist: false,
      addToWatchlist: false,
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
      const debugTrace = Array.isArray(riskCtx.debugTrace)
        ? riskCtx.debugTrace
        : Array.isArray(riskVerdict?.trace)
        ? riskVerdict.trace
        : [];
      const reasonSummary =
        (typeof riskVerdict === "object" && riskVerdict.reason) ||
        debugTrace.map((d) => d.code).join(", ") ||
        "riskValidationFail";
      console.log(`[RISK] ${symbol} blocked: ${reasonSummary}`);
      try {
        await logSignalRejected(
          `${symbol}-${Date.now()}`,
          reasonSummary,
          { ...riskCtx, debugTrace },
          preliminary
        );
      } catch (e) {
        logError("logSignalRejected", e);
      }
      return null;
    }

    // Step 6: Position sizing after risk filter
    const baseRisk = Math.abs(base.entry - base.stopLoss);
    if (!Number.isFinite(baseRisk) || baseRisk <= 0) {
      console.log(`[SKIP] ${symbol} - invalid baseRisk`, {
        entry: base.entry,
        sl: base.stopLoss,
      });
      return null;
    }
    const rrNumerator = Number.isFinite(base.target2 ?? base.target1)
      ? Math.abs((base.target2 ?? base.target1) - base.entry)
      : 0;
    const riskReward = baseRisk > 0 ? rrNumerator / baseRisk : 0;
    const consolidationOk = isAwayFromConsolidation(validCandles, base.entry);
    const { getDrawdown } = await import("./account.js");
    const dd = typeof getDrawdown === "function" ? getDrawdown() : 0;
    let qty = calculatePositionSize({
      capital: accountBalance,
      risk: accountBalance * riskPerTradePercentage,
      slPoints: baseRisk,
      price: base.entry,
      volatility: atrValue,
      drawdown: dd,
    });
    if (riskReward > 2) qty = Math.floor(qty * 1.1);
    else if (riskReward < 1.2) qty = Math.floor(qty * 0.9);
    qty = Math.max(1, qty || 0);

    const tradeParams = {
      entry: base.entry,
      stopLoss: base.stopLoss,
      target1: base.target1,
      target2: base.target2,
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
      slippage,
      spread,
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
      baseRisk: Math.abs(base.entry - base.stopLoss),
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

    signal.expiresAt = toISTISOString(expiresAt);
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
  const top = selectTopSignal(signals);
  if (top) {
    const { refreshAccountBalance } = await import("./account.js");
    await refreshAccountBalance();
    accountBalance = getAccountBalance();
    const requiredMargin = calculateRequiredMargin({
      price: top.entry,
      qty: top.qty,
    });
    const tradeValue = top.entry * top.qty;
    const sector = getSector(top.stock || top.symbol);
    const exposureOk =
      openPositions.size < MAX_OPEN_TRADES &&
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
      return null;
    }
    if (accountBalance >= requiredMargin) {
      await sendToExecution(top);
    } else {
      console.log(
        `[SKIP] Insufficient margin. Required ${requiredMargin}, available ${accountBalance} for ${
          top.stock || top.symbol
        }`
      );
    }
  }
  return top;
}

export { getAccountBalance, initAccountBalance };
