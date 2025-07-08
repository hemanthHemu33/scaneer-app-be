// scanner.js

import { computeFeatures } from "./featureEngine.js";
import {
  debounceSignal,
  calculateExpiryMinutes,
  toISTISOString,
  getMAForSymbol,
} from "./util.js";

import { getSupportResistanceLevels, historicalCache } from "./kite.js";
import { candleHistory, symbolTokenMap } from "./dataEngine.js";
import { evaluateAllStrategies } from "./strategyEngine.js";
import { evaluateStrategies } from "./strategies.js";
import { RISK_REWARD_RATIO, calculatePositionSize } from "./positionSizing.js";
import { isSignalValid } from "./riskEngine.js";
import { startExitMonitor } from "./exitManager.js";
import { openPositions, recordExit } from "./portfolioContext.js";
import { logTrade } from "./tradeLogger.js";
import {
  marketContext,
  filterStrategiesByRegime,
} from "./smartStrategySelector.js";
import { signalQualityScore } from "./confidence.js";
import { sendToExecution } from "./orderExecution.js";
import { initAccountBalance, getAccountBalance } from "./account.js";
import { buildSignal } from "./signalBuilder.js";
// 📊 Signal history tracking
const signalHistory = {};
let accountBalance = 0;
initAccountBalance().then((bal) => {
  accountBalance = bal;
  console.log(`[INIT] Account balance set to ${accountBalance}`);
});
const riskPerTradePercentage = 0.01;

// 🚦 Risk control state
let riskState = {
  dailyLoss: 0,
  consecutiveLosses: 0,
  lastResetDay: new Date().getDate(),
};

// ⚙️ Scanner mode toggle
const MODE = "strict"; // Options: "strict" | "relaxed"
const FILTERS = {
  atrThreshold: MODE === "strict" ? 2 : 0.4,
  minBuySellRatio: MODE === "strict" ? 0.8 : 0.6,
  maxSpread: MODE === "strict" ? 1.5 : 2.0,
  minLiquidity: MODE === "strict" ? 500 : 300,
  maxATR: MODE === "strict" ? 3.5 : 5.0,
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

    const validCandles = candles.filter(
      (c) => c.open && c.high && c.low && c.close
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
      supertrend,
      atr: atrValue = 1,
      rvol,
    } = features;
    const last = validCandles.at(-1);
    const expiryMinutes = calculateExpiryMinutes({ atr: atrValue, rvol });
    const expiresAt = new Date(
      Date.now() + expiryMinutes * 60 * 1000
    ).toISOString();

    const isUptrend = ema9 > ema21 && ema21 > ema50;
    const isDowntrend = ema9 < ema21 && ema21 < ema50;

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
      timeSinceSignal: 0,
      volume: liquidity,
      currentPrice: liveTick ? liveTick.last_price : last.close,
      marketRegime: marketContext.regime,
      minATR: FILTERS.atrThreshold,
      maxATR: FILTERS.maxATR,
      minRR: RISK_REWARD_RATIO,
    });
    if (!riskOk) return null;

    // Step 6: Position sizing after risk filter
    const qty = calculatePositionSize({
      capital: accountBalance,
      risk: accountBalance * riskPerTradePercentage,
      slPoints: Math.abs(base.entry - base.stopLoss),
      price: base.entry,
      volatility: atrValue,
    });

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
      isUptrend,
      isDowntrend,
      strategyName: base.strategy,
      strategyConfidence: base.confidence,
      support,
      resistance,
      finalScore: signalQualityScore({ atr: atrValue, rvol }),
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
    await sendToExecution(top);
  }
  return top;
}

export { getAccountBalance, initAccountBalance };
