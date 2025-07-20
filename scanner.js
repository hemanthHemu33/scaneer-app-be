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

import { getSupportResistanceLevels, historicalCache } from "./kite.js";
import { candleHistory, symbolTokenMap } from "./dataEngine.js";
import { evaluateAllStrategies } from "./strategyEngine.js";
import { evaluateStrategies } from "./strategies.js";
import { RISK_REWARD_RATIO, calculatePositionSize } from "./positionSizing.js";
import { isSignalValid, riskState } from "./riskEngine.js";
import { startExitMonitor } from "./exitManager.js";
import { openPositions, recordExit } from "./portfolioContext.js";
import { logTrade } from "./tradeLogger.js";
import {
  marketContext,
  filterStrategiesByRegime,
} from "./smartStrategySelector.js";
import { signalQualityScore, applyPenaltyConditions } from "./confidence.js";
import { sendToExecution } from "./orderExecution.js";
import { initAccountBalance, getAccountBalance } from "./account.js";
import { buildSignal } from "./signalBuilder.js";
import { getSector } from "./sectors.js";
import { recordSectorSignal } from "./sectorSignals.js";
// 📊 Signal history tracking
const signalHistory = {};
let accountBalance = 0;
initAccountBalance().then((bal) => {
  accountBalance = bal;
  console.log(`[INIT] Account balance set to ${accountBalance}`);
});
const riskPerTradePercentage = 0.01;

// 🚦 Risk control state
// ⚙️ Scanner mode toggle
const MODE = "relaxed"; // Options: "strict" | "relaxed"
const FILTERS = {
  atrThreshold: MODE === "strict" ? 2 : 0.4,
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

    if (riskState.dailyLoss >= 500 || riskState.consecutiveLosses >= 3) {
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

    const token = symbolTokenMap[symbol];
    const dailyHistory = historicalCache[token] || [];
    const sessionData = candleHistory[token] || validCandles;

    const context = {
      symbol,
      candles: validCandles,
      features,
      depth,
      tick: liveTick,
      spread,
      liquidity,
      totalBuy,
      totalSell,
      dailyHistory,
      sessionCandles: sessionData,
    };

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
    let dailyRangePct = 0;
    if (Array.isArray(dailyHistory) && dailyHistory.length) {
      const d = dailyHistory[dailyHistory.length - 1];
      const ref = d.close ?? d.open ?? 1;
      dailyRangePct = ref ? ((d.high - d.low) / ref) * 100 : 0;
    }

    const wickPct = last ? getWickNoise(last) : 0;
    const strongPriceAction = isStrongPriceAction(validCandles);
    const atrStable = isAtrStable(validCandles);
    const expiryMinutes = calculateExpiryMinutes({ atr: atrValue, rvol });
    const expiresAt = new Date(
      Date.now() + expiryMinutes * 60 * 1000
    ).toISOString();

    const isUptrend = ema9 > ema21 && ema21 > ema50;
    const isDowntrend = ema9 < ema21 && ema21 < ema50;
    const vwapParticipation = vwap
      ? 1 - Math.abs(last.close - vwap) / last.close
      : 1;

    // ⚠️ Momentum filter
    if (rsi > 45 && rsi < 55 && atrValue < 1) {
      console.log(
        `[SKIP] ${symbol} - No momentum zone (RSI 45–55 and low ATR)`
      );
      return null;
    }

    const { support, resistance } = getSupportResistanceLevels(symbol);

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
    const [base] = filtered;
    if (!base) return null;

    if (altStrategies && altStrategies[0]) {
      base.strategy = altStrategies[0].name;
      base.confidence = altStrategies[0].confidence;
    }

    // Debounce logic now that strategy name is known
    const conflictWindow = 3 * 60 * 1000;
    if (
      !debounceSignal(
        signalHistory,
        symbol,
        base.direction,
        base.strategy,
        conflictWindow
      )
    )
      return null;
    // Step 5: Risk filter on raw strategy output
    // Preliminary signal for risk validation (no sizing or meta info)
    const preliminary = {
      stock: symbol,
      pattern: base.strategy,
      direction: base.direction,
      entry: base.entry,
      stopLoss: base.stopLoss,
      target2: base.target2,
      atr: atrValue,
      spread,
      liquidity,
    };

    const riskOk = isSignalValid(preliminary, {
      avgAtr: atrValue,
      indexTrend: isUptrend ? "up" : isDowntrend ? "down" : "sideways",
      indexVolatility: marketContext.vix,
      timeSinceSignal: 0,
      volume: liquidity,
      avgVolume,
      currentPrice: liveTick ? liveTick.last_price : last.close,
      marketRegime: marketContext.regime,
      vwapParticipation,
      rsi,
      adx,
      requireMomentum: true,
      minATR: FILTERS.atrThreshold,
      maxATR: FILTERS.maxATR,
      minVolatility: FILTERS.atrThreshold,
      maxVolatility: FILTERS.maxATR,
      dailyRangePct,
      rangeSpikeThreshold: FILTERS.rangeSpike,
      wickPct,
      consolidationVolumeRatio: FILTERS.consolidationRatio,
      slippage,
      maxSlippage: FILTERS.maxSlippage,
      maxSpreadPct: FILTERS.maxSpreadPct,
      minRR: RISK_REWARD_RATIO,
      minLiquidity: FILTERS.minLiquidity,
      minVolumeRatio: 0.5,
      minVwapParticipation: 0.98,
      maxIndexVolatility: 20,
      blockWatchlist: true,
      addToWatchlist: false,
      maxSignalAgeMinutes: 5,
      strategyFailWindowMs: 15 * 60 * 1000,
      minSLDistancePct: 0.001,
    });
    if (!riskOk) return null;

    // Step 6: Position sizing after risk filter
    const baseRisk = Math.abs(base.entry - base.stopLoss);
    const riskReward = Math.abs((base.target2 ?? base.target1) - base.entry) / baseRisk;
    const consolidationOk = isAwayFromConsolidation(validCandles.slice(0, -1), base.entry);
    let qty = calculatePositionSize({
      capital: accountBalance,
      risk: accountBalance * riskPerTradePercentage,
      slPoints: baseRisk,
      price: base.entry,
      volatility: atrValue,
    });
    if (riskReward > 2) qty = Math.floor(qty * 1.1);
    else if (riskReward < 1.2) qty = Math.floor(qty * 0.9);

    const tradeParams = {
      entry: base.entry,
      stopLoss: base.stopLoss,
      target1: base.target1,
      target2: base.target2,
      qty,
    };

    const contextForBuild = {
      symbol,
      instrumentToken: token,
      ma20Val: getMAForSymbol(String(token), 20),
      ma50Val: getMAForSymbol(String(token), 50),
      ema9,
      ema21,
      ema50,
      ema200,
      rsi,
      supertrend,
      atrValue,
      slippage,
      spread,
      liquidity,
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
      finalScore: signalQualityScore({
        atr: atrValue,
        rvol,
        strongPriceAction,
        cleanBody: wickPct < 0.3,
        rrRatio: riskReward,
        atrStable,
        awayFromConsolidation: consolidationOk,
      }),
      expiresAt,
      riskAmount: accountBalance * riskPerTradePercentage,
      accountBalance,
      baseRisk: Math.abs(base.entry - base.stopLoss),
    };

    // Step 7: Append meta information and build final signal
    const { signal } = buildSignal(
      contextForBuild,
      { type: base.strategy, strength: base.confidence, direction: base.direction },
      tradeParams,
      base.confidence
    );

    signal.expiresAt = toISTISOString(expiresAt);
    signal.ai = null; // Step 8: final enrichment placeholder

    const penaltyAdjusted = applyPenaltyConditions(signal.confidenceScore, {
      doji: wickPct > 0.6 || !strongPriceAction,
      lowVolume: liquidity && avgVolume && liquidity < avgVolume * 0.5,
      againstTrend:
        (base.direction === "Long" && isDowntrend) ||
        (base.direction === "Short" && isUptrend),
      lateSession: new Date(signal.generatedAt).getHours() >= 15,
      signalOverload: riskState.signalCount > 10,
      wickHeavy: wickPct > 0.6,
      badRR: riskReward < 1.5,
      positionConflict:
        openPositions.has(symbol) &&
        openPositions.get(symbol).side !== (base.direction === "Long" ? "buy" : "sell"),
    });
    signal.confidence = penaltyAdjusted;
    signal.confidenceScore = penaltyAdjusted;

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

function handleExit(trade, reason) {
  recordExit(trade.symbol);
  logTrade({ symbol: trade.symbol, reason, event: "exit" });
}

if (process.env.NODE_ENV !== "test") {
  startExitMonitor(openPositions, {
    exitTrade: handleExit,
    logTradeExit: handleExit,
  });
}

// Rank signals and send top one to execution
export async function rankAndExecute(signals = []) {
  const { selectTopSignal } = await import("./signalRanker.js");
  const top = selectTopSignal(signals);
  if (top) {
    accountBalance = await initAccountBalance();
    if (accountBalance > 0) {
      await sendToExecution(top);
    } else {
      console.log(
        `[SKIP] Insufficient balance. Signal for ${
          top.stock || top.symbol
        } not executed`
      );
    }
  }
  return top;
}

export { getAccountBalance, initAccountBalance };
