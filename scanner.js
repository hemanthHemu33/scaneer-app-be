// scanner.js

import {
  calculateEMA,
  calculateRSI,
  calculateSupertrend,
  // detectPatterns,
  getMAForSymbol,
  getATR as getDailyATR,
  debounceSignal,
  detectAllPatterns,
  calculateExpiryMinutes,
} from "./util.js";

import {
  getHigherTimeframeData,
  getSupportResistanceLevels,
} from "./kite.js";
import { evaluateStrategies } from "./strategies.js";
import { candleHistory } from "./kite.js";
import { RISK_REWARD_RATIO, calculatePositionSize } from "./positionSizing.js";
import { validatePreExecution, adjustStopLoss } from "./riskValidator.js";
import {
  calculateDynamicStopLoss,
  adjustRiskBasedOnDrawdown,
} from "./dynamicRiskModel.js";
import {
  marketContext,
  filterStrategiesByRegime,
} from "./smartStrategySelector.js";

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

    if (!Array.isArray(candles) || candles.length < 5) return null;

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
    const volumes = validCandles.map((c) => c.volume || 0);
    const avgVolume = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(volumes.length - 1, 1);
    const rvol = avgVolume ? volumes[volumes.length - 1] / avgVolume : 1;


    const last = validCandles.at(-1);
    const closePrices = validCandles.map((c) => c.close);
    const ema9 = calculateEMA(closePrices, 9);
    const ema21 = calculateEMA(closePrices, 21);
    const ema50 = calculateEMA(closePrices, 50);
    const ema200 = calculateEMA(closePrices, 200);
    const rsi = calculateRSI(closePrices, 14);
    const supertrend = calculateSupertrend(validCandles, 50);
    const atrValue = getDailyATR(validCandles) || 1;
    const expiryMinutes = calculateExpiryMinutes({ atr: atrValue, rvol });
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();

    // ⚠️ Momentum filter
    if (rsi > 45 && rsi < 55 && atrValue < 1) {
      console.log(
        `[SKIP] ${symbol} - No momentum zone (RSI 45–55 and low ATR)`
      );
      return null;
    }

    if (atrValue < filters.atrThreshold) return null;
    if (atrValue > filters.maxATR) {
      console.log(
        `[SKIP] ${symbol} - ATR ${atrValue.toFixed(2)} exceeds limit`
      );
      return null;
    }

    const possiblePatterns = detectAllPatterns(validCandles, atrValue);
    if (!possiblePatterns || possiblePatterns.length === 0) return null;

    // 🗳️ Pick best pattern
    let pattern = null;
    let bestScore = 0;
    for (const p of possiblePatterns) {
      const score =
        (p.strength || 1) *
        (p.confidence === "High" ? 1 : p.confidence === "Medium" ? 0.6 : 0.3);
      if (score > bestScore) {
        pattern = p;
        bestScore = score;
      }
    }

    if (!pattern) return null;

    // Fallback breakout/stopLoss if missing
    if (typeof pattern.breakout !== "number" || isNaN(pattern.breakout)) {
      pattern.breakout = last.close;
    }
    if (typeof pattern.stopLoss !== "number" || isNaN(pattern.stopLoss)) {
      pattern.stopLoss =
        pattern.direction === "Long" ? last.low : last.high;
    }

    if (
      (pattern.direction === "Long" && rsi > 75) ||
      (pattern.direction === "Short" && rsi < 25)
    ) {
      console.log(`[SKIP] ${symbol} - RSI ${rsi.toFixed(2)} too extreme`);
      return null;
    }

    // VWAP Reversal flat EMA rejection
    if (pattern.type === "VWAP Reversal") {
      const slope = ema9 - ema21;
      if (Math.abs(slope) < 0.05) {
        console.log(`[SKIP] ${symbol} - VWAP Reversal with flat slope`);
        return null;
      }
    }

    // 200 EMA confirmation filter
    if (
      (pattern.direction === "Long" && last.close < ema200) ||
      (pattern.direction === "Short" && last.close > ema200)
    ) {
      console.log(`[SKIP] ${symbol} - Price against 200 EMA filter`);
      return null;
    }

    // Trend alignment
    const isUptrend = ema9 > ema21 && ema21 > ema50;
    const isDowntrend = ema9 < ema21 && ema21 < ema50;
    const isTrendClean =
      (pattern.direction === "Long" && isUptrend) ||
      (pattern.direction === "Short" && isDowntrend);

    let confidence = "High";
    if (!isTrendClean) {
      confidence = "Medium";
      console.log(`[WEAK TREND] ${symbol} has unclear trend structure`);
    }

    // 🧠 Live Volume Spike Check
    if (liveTick?.volume_traded && liquidity && liquidity !== "NA") {
      const volumeSpikeRatio = liveTick.volume_traded / liquidity;

      if (volumeSpikeRatio > 2.5) {
        if (
          pattern.direction === "Long" &&
          liveTick.total_buy_quantity > liveTick.total_sell_quantity * 1.5
        ) {
          confidence = "High";
          console.log(
            `[BOOST] ${symbol} - Volume Spike BUY Ratio ${volumeSpikeRatio.toFixed(
              2
            )}x`
          );
        } else if (
          pattern.direction === "Short" &&
          liveTick.total_sell_quantity > liveTick.total_buy_quantity * 1.5
        ) {
          confidence = "High";
          console.log(
            `[BOOST] ${symbol} - Volume Spike SELL Ratio ${volumeSpikeRatio.toFixed(
              2
            )}x`
          );
        }
      }

      if (volumeSpikeRatio < 0.3) {
        console.log(
          `[SKIP] ${symbol} - Weak live volume (${volumeSpikeRatio.toFixed(
            2
          )}x)`
        );
        return null;
      }
    }

    if (
      (pattern.direction === "Long" && ema9 < ema21 * 0.98) ||
      (pattern.direction === "Short" && ema9 > ema21 * 1.02)
    ) {
      confidence = "Medium";
    }

    if (
      (pattern.direction === "Long" && supertrend.signal === "Sell") ||
      (pattern.direction === "Short" && supertrend.signal === "Buy")
    ) {
      confidence = "Low";
    }

    if (
      (pattern.direction === "Long" && totalBuy < totalSell * 0.9) ||
      (pattern.direction === "Short" && totalSell < totalBuy * 0.9)
    ) {
      confidence = "Low";
    }

    const higherTF = await getHigherTimeframeData(symbol, "15minute");
    if (!higherTF) return null;

    const { ema50: higherEMA50, supertrend: higherSuper } = higherTF;
    const higherTrendOk =
      (pattern.direction === "Long" &&
        higherSuper.signal === "Buy" &&
        last.close > higherEMA50 * 0.98) ||
      (pattern.direction === "Short" &&
        higherSuper.signal === "Sell" &&
        last.close < higherEMA50 * 1.02);

    if (!higherTrendOk && confidence !== "Low") confidence = "Medium";

    if (depth) {
      const bestBid = depth.buy?.[0]?.price || 0;
      const bestAsk = depth.sell?.[0]?.price || 0;
      const buySellRatio = totalBuy / (totalSell || 1);

      if (
        (pattern.direction === "Long" && bestBid < last.close * 0.995) ||
        (pattern.direction === "Short" && bestAsk > last.close * 1.005)
      ) {
        confidence = "Low";
      }

      if (
        (pattern.direction === "Long" &&
          buySellRatio < filters.minBuySellRatio) ||
        (pattern.direction === "Short" &&
          buySellRatio > 1 / filters.minBuySellRatio)
      ) {
        confidence = "Low";
      }
    }

    if (
      spread > filters.maxSpread ||
      liquidity < Math.max(filters.minLiquidity, liquidity * 0.6)
    ) {
      confidence = "Low";
    }

    if (confidence === "Low") {
      console.log(`[SKIP] ${symbol} - Confidence LOW`);
      return null;
    }

    if (confidence === "Medium" && pattern.strength < 2) {
      console.log(
        `[SKIP] ${symbol} - Weak pattern strength + medium confidence`
      );
      return null;
    }



    // Entry/SL/Target Calculation
    let entry =
      pattern.breakout + (pattern.direction === "Long" ? slippage : -slippage);
    const patternSL =
      pattern.stopLoss - (pattern.direction === "Long" ? slippage : -slippage);

    const dynamicSL = calculateDynamicStopLoss({
      atr: atrValue,
      entry,
      direction: pattern.direction,
      setupType:
        confidence === "High" && pattern.type === "Breakout"
          ? "breakout"
          : "conservative",
    });

    let stopLoss = dynamicSL;
    if (patternSL) {
      const distDyn = Math.abs(entry - dynamicSL);
      const distPat = Math.abs(entry - patternSL);
      stopLoss = pattern.direction === "Long" ? Math.max(stopLoss, patternSL) : Math.min(stopLoss, patternSL);
      // Prefer tighter stop when pattern provides closer SL
      if (distPat < distDyn) stopLoss = patternSL;
    }

    if (
      (pattern.direction === "Long" && stopLoss >= entry) ||
      (pattern.direction === "Short" && stopLoss <= entry)
    ) {
      stopLoss = dynamicSL;
    }

    stopLoss = adjustStopLoss({
      price: last.close,
      stopLoss,
      direction: pattern.direction,
      atr: atrValue,
    });

    const baseRisk = Math.abs(entry - stopLoss);
    const riskAmount = accountBalance * riskPerTradePercentage;
    let qty = calculatePositionSize({
      capital: accountBalance,
      risk: riskAmount,
      slPoints: baseRisk,
      price: entry,
      volatility: atrValue,
      lotSize: 1,
      utilizationCap: 1,
    });

    const drawdown = accountBalance
      ? riskState.dailyLoss / accountBalance
      : 0;
    qty = adjustRiskBasedOnDrawdown({ drawdown, lotSize: qty });

    let rrMultiplier = RISK_REWARD_RATIO;
    if (
      atrValue > 2 ||
      (liveTick &&
        ((pattern.direction === "Long" &&
          liveTick.total_buy_quantity > liveTick.total_sell_quantity * 1.5) ||
          (pattern.direction === "Short" &&
            liveTick.total_sell_quantity > liveTick.total_buy_quantity * 1.5)))
    ) {
      rrMultiplier = RISK_REWARD_RATIO + 0.5;
    }

    let target1 =
      entry +
      (pattern.direction === "Long" ? 1 : -1) * (rrMultiplier * 0.5) * baseRisk;
    let target2 =
      entry + (pattern.direction === "Long" ? 1 : -1) * rrMultiplier * baseRisk;

    const rr = Math.abs((target2 - entry) / baseRisk);
    if (rr < RISK_REWARD_RATIO) {
      console.log(`[SKIP] ${symbol} - R:R below 1:${RISK_REWARD_RATIO}. RR = ${rr.toFixed(2)}`);
      return null;
    }

    // Adjustments from live tick data
    if (liveTick) {
      const buyPressure = liveTick.total_buy_quantity || 0;
      const sellPressure = liveTick.total_sell_quantity || 0;
      const priceDev = Math.abs(liveTick.last_price - last.close);

      if (buyPressure > sellPressure && pattern.direction === "Long") {
        target1 += baseRisk * 0.5;
        target2 += baseRisk * 1;
      } else if (sellPressure > buyPressure && pattern.direction === "Short") {
        target1 -= baseRisk * 0.5;
        target2 -= baseRisk * 1;
      }

      if (priceDev > atrValue * 0.5) {
        stopLoss += (pattern.direction === "Long" ? -1 : 1) * baseRisk * 0.2;
      }
    }

    const ma20Val = getMAForSymbol(symbol, 20);
    const ma50Val = getMAForSymbol(symbol, 50);
    const { support, resistance } = getSupportResistanceLevels(symbol);

    const stratResults = evaluateStrategies(validCandles, { rvol }, { topN: 5 });
    const filtered = filterStrategiesByRegime(stratResults, marketContext);
    const [topStrategy] = filtered;
    const strategyName = topStrategy ? topStrategy.name : pattern.type;
    const strategyConfidence = topStrategy ? topStrategy.confidence : (confidence === "High" ? 0.8 : confidence === "Medium" ? 0.6 : 0.4);

    // Debounce logic now that strategy name is known
    const conflictWindow = 3 * 60 * 1000;
    if (
      !debounceSignal(
        signalHistory,
        symbol,
        pattern.direction,
        strategyName,
        conflictWindow
      )
    )
      return null;

    const signal = {
      stock: symbol,
      pattern: pattern.type,
      strength: pattern.strength,
      direction: pattern.direction,
      entry: parseFloat(entry.toFixed(2)),
      stopLoss: parseFloat(stopLoss.toFixed(2)),
      target1: parseFloat(target1.toFixed(2)),
      target2: parseFloat(target2.toFixed(2)),
      qty,
      riskPerUnit: parseFloat(baseRisk.toFixed(2)),
      riskAmount: parseFloat(riskAmount.toFixed(2)),
      accountBalance: parseFloat(accountBalance.toFixed(2)),
      rsi: parseFloat(rsi.toFixed(2)),
      ma20: ma20Val !== null ? parseFloat(ma20Val.toFixed(2)) : null,
      ma50: ma50Val !== null ? parseFloat(ma50Val.toFixed(2)) : null,
      support: support !== null ? parseFloat(support.toFixed(2)) : null,
      resistance:
        resistance !== null ? parseFloat(resistance.toFixed(2)) : null,
      ema9: parseFloat(ema9.toFixed(2)),
      ema21: parseFloat(ema21.toFixed(2)),
      ema50: parseFloat(ema50.toFixed(2)),
      ema200: parseFloat(ema200.toFixed(2)),
      supertrend,
      atr: atrValue,
      slippage: parseFloat(slippage.toFixed(2)),
      spread: parseFloat(spread.toFixed(2)),
      liquidity,
      confidence,
      liveTickData: liveTick,
      depth,
      expiresAt,
      generatedAt: new Date().toISOString(),
      source: "analyzeCandles",
    };
    const advancedSignal = {
      signalId: `${symbol}-1m-${strategyName.replace(/\s+/g, "-")}-${new Date().toISOString().replace(/[:.-]/g, "")}`,
      symbol,
      timeframe: "1m",
      strategy: strategyName,
      side: pattern.direction === "Long" ? "buy" : "sell",
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      targets: [signal.target1, signal.target2],
      quantity: qty,
      risk: {
        rrRatio: parseFloat(rr.toFixed(2)),
        slDistance: parseFloat(Math.abs(signal.entry - signal.stopLoss).toFixed(2)),
        capitalRequired: parseFloat((signal.entry * qty).toFixed(2)),
      },
      filters: {
        rvol: parseFloat(rvol.toFixed(2)),
        marketTrend: isUptrend ? "bullish" : isDowntrend ? "bearish" : "sideways"
      },
      context: { volatility: atrValue.toFixed(2) },
      levels: { support, resistance },
      confidenceScore: strategyConfidence,
      executionWindow: {
        validFrom: signal.generatedAt,
        validUntil: expiresAt,
      },
      executionHint: {
        type: "limitOrMarket",
        slippageTolerance: 0.05,
        broker: "zerodha",
        strategyRef: `id:${strategyName.toLowerCase().replace(/\s+/g, "-")}`
      },
      status: "active",
      expiresAt,
      autoCancelOn: []
    };
    signal.algoSignal = advancedSignal;

    const ok = validatePreExecution(signal, {
      avgAtr: atrValue,
      indexTrend: isUptrend ? 'up' : isDowntrend ? 'down' : 'sideways',
      timeSinceSignal: 0,
      volume: liquidity,
      currentPrice: liveTick ? liveTick.last_price : last.close,
    });
    if (!ok) return null;

    // AI enrichment will be handled asynchronously after the signal is emitted
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
