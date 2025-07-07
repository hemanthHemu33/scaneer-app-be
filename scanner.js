// scanner.js

import { computeFeatures } from "./featureEngine.js";
import {
  debounceSignal,
  calculateExpiryMinutes,
} from "./util.js";

import { getSupportResistanceLevels, historicalCache } from "./kite.js";
import { candleHistory, symbolTokenMap } from "./dataEngine.js";
import { detectGapUpOrDown } from "./strategies.js";
import { evaluateAllStrategies } from "./strategyEngine.js";
import {
  RISK_REWARD_RATIO,
  calculatePositionSize,
} from "./positionSizing.js";
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
// 📊 Signal history tracking
const signalHistory = {};
let accountBalance = 10000;
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

    // 🔍 Early Gap Up/Down detection (9:15-9:20 AM)
    const nowIST = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    );
    const minutes = nowIST.getHours() * 60 + nowIST.getMinutes();
    if (minutes >= 555 && minutes <= 560) {
      const token = symbolTokenMap[symbol];
      const dailyHistory = historicalCache[token] || [];
      const sessionData = candleHistory[token] || candles;
      const gapPattern = detectGapUpOrDown({
        dailyHistory,
        sessionCandles: sessionData,
      });
      if (gapPattern) {
        const entry = gapPattern.breakout;
        const stopLoss = gapPattern.stopLoss;
        const baseRisk = Math.abs(entry - stopLoss);
        const riskAmount = accountBalance * riskPerTradePercentage;
        const qty = calculatePositionSize({
          capital: accountBalance,
          risk: riskAmount,
          slPoints: baseRisk,
          price: entry,
          volatility: baseRisk,
        });
        const target1 =
          entry +
          (gapPattern.direction === "Long" ? 1 : -1) *
            (RISK_REWARD_RATIO * 0.5) *
            baseRisk;
        const target2 =
          entry +
          (gapPattern.direction === "Long" ? 1 : -1) *
            RISK_REWARD_RATIO *
            baseRisk;
        return {
          stock: symbol,
          pattern: gapPattern.type,
          strength: 3,
          direction: gapPattern.direction,
          entry: parseFloat(entry.toFixed(2)),
          stopLoss: parseFloat(stopLoss.toFixed(2)),
          target1: parseFloat(target1.toFixed(2)),
          target2: parseFloat(target2.toFixed(2)),
          qty,
          confidence: "High",
          expiresAt: new Date(nowIST.getTime() + 5 * 60 * 1000).toISOString(),
          gapPercent: parseFloat(gapPattern.gapPercent.toFixed(2)),
          source: "gapStrategy",
        };
      }
    }

    const validCandles = candles.filter(
      (c) => c.open && c.high && c.low && c.close
    );
    if (validCandles.length < 5) return null;
    const features = computeFeatures(validCandles);
    if (!features) return null;

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
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();

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
    const filtered = filterStrategiesByRegime(stratResults, marketContext);
    const [signal] = filtered;
    if (!signal) return null;

    // Debounce logic now that strategy name is known
    const conflictWindow = 3 * 60 * 1000;
    if (
      !debounceSignal(
        signalHistory,
        symbol,
        signal.direction,
        signal.strategy,
        conflictWindow
      )
    )
      return null;
    signal.support = support;
    signal.resistance = resistance;
    signal.expiresAt = expiresAt;

    const ok = isSignalValid(signal, {
      avgAtr: atrValue,
      indexTrend: isUptrend ? 'up' : isDowntrend ? 'down' : 'sideways',
      timeSinceSignal: 0,
      volume: liquidity,
      currentPrice: liveTick ? liveTick.last_price : last.close,
      marketRegime: marketContext.regime,
      minATR: FILTERS.atrThreshold,
      maxATR: FILTERS.maxATR,
      minRR: RISK_REWARD_RATIO,
    });
    if (!ok) return null;
    signal.ai = null;

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
  logTrade({ symbol: trade.symbol, reason, event: 'exit' });
}

if (process.env.NODE_ENV !== 'test') {
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

