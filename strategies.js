import {
  calculateEMA,
  calculateRSI,
  calculateSupertrend,
  calculateVWAP,
  getATR,
} from "./featureEngine.js";
import { confirmRetest } from "./util.js";

// Default thresholds used by strategy detectors. These can be overridden
// via the optional `config` parameter in `evaluateStrategies`.
export const DEFAULT_CONFIG = {
  volumeSpikeMultiplier: 1.5,
  ribbonCompressionPct: 0.005,
  rsiExhaustion: 80,
};

function emaSeries(prices, length) {
  const k = 2 / (length + 1);
  const series = [];
  let ema = prices[0];
  series.push(ema);
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    series.push(ema);
  }
  return series;
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function highest(candles, count) {
  return Math.max(...candles.slice(-count).map((c) => c.high));
}

function lowest(candles, count) {
  return Math.min(...candles.slice(-count).map((c) => c.low));
}

function detectEmaCrossover(candles, _ctx = {}, config = DEFAULT_CONFIG) {
  if (candles.length < 50) return null;
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume || 0);
  const ema21 = emaSeries(closes, 21);
  const ema50 = emaSeries(closes, 50);
  const last = candles.at(-1);
  const avgVol =
    volumes.slice(-10).reduce((a, b) => a + b, 0) /
    Math.min(10, volumes.length);

  if (
    ema21.at(-2) <= ema50.at(-2) &&
    ema21.at(-1) > ema50.at(-1) &&
    last.close > ema21.at(-1) &&
    last.volume > avgVol * config.volumeSpikeMultiplier
  ) {
    return { name: "EMA Crossover + Volume Spike", confidence: 0.8 };
  }
  return null;
}

function detectBreakoutRetest(candles) {
  if (candles.length < 7) return null;
  const breakout = Math.max(...candles.slice(-7, -2).map((c) => c.high));
  if (confirmRetest(candles.slice(-2), breakout, 'Long')) {
    return { name: "Breakout + Retest", confidence: 0.7 };
  }
  return null;
}

function detectHammerDemandZone(candles) {
  if (candles.length < 5) return null;
  const last = candles.at(-1);
  const lowestLow = Math.min(...candles.slice(-5).map((c) => c.low));
  const body = Math.abs(last.close - last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;
  if (lowerWick > body * 2 && last.low <= lowestLow) {
    return { name: "Hammer at Demand Zone + ATR Filter", confidence: 0.6 };
  }
  return null;
}

function detectHighVolumeBreakout(candles) {
  if (candles.length < 6) return null;
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume || 0);
  const last = candles.at(-1);
  const priorHigh = Math.max(...candles.slice(-5, -1).map((c) => c.high));
  const avgVol =
    volumes.slice(-5, -1).reduce((a, b) => a + b, 0) /
    Math.min(5, volumes.length - 1);
  if (last.close > priorHigh && last.volume > avgVol * 2) {
    return { name: "High Volume Breakout", confidence: 0.85 };
  }
  return null;
}

function detectVduPocketPivot(candles) {
  if (candles.length < 6) return null;
  const last = candles.at(-1);
  const vols = candles.slice(-6).map((c) => c.volume || 0);
  const declining = vols
    .slice(1, -1)
    .every((v, i, arr) => v <= arr[i] && v > 0);
  const avgDecline = vols.slice(0, -1).reduce((a, b) => a + b, 0) / 5;
  if (
    declining &&
    last.volume > avgDecline * 1.5 &&
    last.close > candles.at(-2).high
  ) {
    return { name: "Volume Dry-Up (VDU) + Pocket Pivot", confidence: 0.75 };
  }
  return null;
}

function detectEmaRibbonCompression(
  candles,
  _ctx = {},
  config = DEFAULT_CONFIG
) {
  if (candles.length < 50) return null;
  const closes = candles.map((c) => c.close);
  const ema5 = emaSeries(closes, 5).at(-1);
  const ema20 = emaSeries(closes, 20).at(-1);
  const ema50 = emaSeries(closes, 50).at(-1);
  const spread = Math.max(ema5, ema20, ema50) - Math.min(ema5, ema20, ema50);
  const price = closes.at(-1);
  if (
    spread < price * config.ribbonCompressionPct &&
    price > Math.max(ema5, ema20, ema50)
  ) {
    return { name: "EMA Ribbon Compression", confidence: 0.65 };
  }
  return null;
}

function detectSupertrendRsi(candles) {
  if (candles.length < 20) return null;
  const closes = candles.map((c) => c.close);
  const rsi = calculateRSI(closes, 14);
  const st = calculateSupertrend(candles, 10);
  const last = candles.at(-1);
  if (last.close > st.level && rsi > 55) {
    return { name: "Supertrend + RSI Filter", confidence: 0.65 };
  }
  return null;
}

function detectMicrotrendPullback(candles) {
  if (candles.length < 200) return null;
  const closes = candles.map((c) => c.close);
  const ema20 = calculateEMA(closes, 20);
  const ema200 = calculateEMA(closes, 200);
  const last = candles.at(-1);
  const prev = candles.at(-2);
  if (last.close > ema200 && prev.low <= ema20 && last.close > prev.close) {
    return { name: "20 EMA Pullback (Microtrend)", confidence: 0.6 };
  }
  return null;
}

function detectFibonacciPullback(candles) {
  if (candles.length < 20) return null;
  const closes = candles.map((c) => c.close);
  const high = highest(candles, 20);
  const low = lowest(candles, 20);
  const fib38 = low + 0.382 * (high - low);
  const fib61 = low + 0.618 * (high - low);
  const last = candles.at(-1);
  if (last.low <= fib61 && last.low >= fib38 && last.close > last.open) {
    return { name: "Fibonacci Pullback Strategy", confidence: 0.55 };
  }
  return null;
}

function detectBullishDivergence(candles) {
  if (candles.length < 15) return null;
  const closes = candles.map((c) => c.close);
  const rsiSeries = closes.map((_, i) =>
    i < 14 ? 50 : calculateRSI(closes.slice(i - 14, i + 1), 14)
  );
  const lastLow = lowest(candles, 5);
  const prevLow = lowest(candles.slice(0, -5), 5);
  const lastRsi = rsiSeries.at(-1);
  const prevRsi = rsiSeries[rsiSeries.length - 5];
  if (lastLow < prevLow && lastRsi > prevRsi) {
    return { name: "Bullish Divergence with RSI", confidence: 0.6 };
  }
  return null;
}

function detectDoubleBottomBreakout(candles) {
  if (candles.length < 10) return null;
  const lows = candles.map((c) => c.low);
  const low1 = Math.min(...lows.slice(-10, -5));
  const low2 = Math.min(...lows.slice(-5));
  const diff = Math.abs(low1 - low2) / low1;
  const high = highest(candles, 10);
  const last = candles.at(-1);
  if (diff < 0.01 && last.close > high) {
    return {
      name: "Double Bottom with Breakout Confirmation",
      confidence: 0.65,
    };
  }
  return null;
}

function detectDarkCloudPiercing(candles) {
  if (candles.length < 3) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const bearish =
    prev.close > prev.open &&
    last.open > prev.close &&
    last.close < prev.close - (prev.high - prev.low) * 0.5;
  const bullish =
    prev.close < prev.open &&
    last.open < prev.close &&
    last.close > prev.close + (prev.high - prev.low) * 0.5;
  if (bearish || bullish) {
    return {
      name: "Dark Cloud Cover / Piercing Line Reversal",
      confidence: 0.55,
    };
  }
  return null;
}

function detectBollingerBounce(candles) {
  if (candles.length < 20) return null;
  const closes = candles.map((c) => c.close);
  const sma20 = calculateEMA(closes, 20); // use EMA as SMA proxy
  const std = Math.sqrt(
    closes.slice(-20).reduce((s, p) => s + Math.pow(p - sma20, 2), 0) / 20
  );
  const lower = sma20 - 2 * std;
  const last = candles.at(-1);
  if (last.low <= lower && last.close > last.open) {
    return { name: "Bollinger Band Bounce", confidence: 0.6 };
  }
  return null;
}

function detectInsideBarBreakout(candles) {
  if (candles.length < 3) return null;
  const [pre, last] = [candles.at(-2), candles.at(-1)];
  if (last.high < pre.high && last.low > pre.low) return null;
  if (pre.high - pre.low < (highest(candles, 5) - lowest(candles, 5)) * 0.3) {
    if (last.close > pre.high || last.close < pre.low) {
      return { name: "Inside Bar Range Breakout", confidence: 0.55 };
    }
  }
  return null;
}

function detectSupportResistancePingPong(candles) {
  if (candles.length < 6) return null;
  const highs = candles.slice(-6).map((c) => c.high);
  const lows = candles.slice(-6).map((c) => c.low);
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const last = candles.at(-1);
  if (last.low <= low * 1.001 || last.high >= high * 0.999) {
    return { name: "Support-Resistance Ping Pong", confidence: 0.5 };
  }
  return null;
}

function detectVWReversalZone(candles) {
  if (candles.length < 10) return null;
  const vwap = calculateVWAP(candles.slice(-10));
  const last = candles.at(-1);
  const deviation = Math.abs(last.close - vwap) / vwap;
  if (
    deviation > 0.02 &&
    last.high - last.low > (highest(candles, 5) - lowest(candles, 5)) * 0.5
  ) {
    return { name: "Volume-Weighted Reversal Zone (VW-RZ)", confidence: 0.6 };
  }
  return null;
}

function detectGapOpeningRangeBreakout(candles) {
  if (candles.length < 20) return null;
  const first = candles.at(-20);
  const rangeHigh = Math.max(...candles.slice(-15).map((c) => c.high));
  const rangeLow = Math.min(...candles.slice(-15).map((c) => c.low));
  const last = candles.at(-1);
  if (first.open > first.close && last.close > rangeHigh) {
    return { name: "Gap Up + Opening Range Breakout", confidence: 0.6 };
  }
  return null;
}

export function detectGapUpOrDown({ dailyHistory, sessionCandles }) {
  if (!Array.isArray(dailyHistory) || dailyHistory.length < 2) return null;
  if (!Array.isArray(sessionCandles) || !sessionCandles[0]) return null;
  const yesterdayClose = dailyHistory[dailyHistory.length - 2]?.close;
  const todayOpen = sessionCandles[0].open;
  if (typeof yesterdayClose !== "number" || typeof todayOpen !== "number")
    return null;
  const gapPercent = ((todayOpen - yesterdayClose) / yesterdayClose) * 100;
  if (gapPercent >= 1.5)
    return {
      type: "Gap-Up Breakout",
      direction: "Long",
      gapPercent,
      breakout: todayOpen,
      stopLoss: yesterdayClose,
    };
  if (gapPercent <= -1.5)
    return {
      type: "Gap-Down Reversal",
      direction: "Short",
      gapPercent,
      breakout: todayOpen,
      stopLoss: yesterdayClose,
    };
  return null;
}

function detectVwapBounce(candles) {
  if (candles.length < 10) return null;
  const vwap = calculateVWAP(candles.slice(-10));
  const last = candles.at(-1);
  const prev = candles.at(-2);
  if (prev.low <= vwap && last.close > prev.close && last.low > vwap) {
    return { name: "VWAP Bounce", confidence: 0.55 };
  }
  return null;
}

function detectFlatBaseBreakout(candles) {
  if (candles.length < 10) return null;
  const rangeHigh = highest(candles, 10);
  const rangeLow = lowest(candles, 10);
  const volatility = rangeHigh - rangeLow;
  const last = candles.at(-1);
  if (volatility / rangeLow < 0.02 && last.close > rangeHigh) {
    return { name: "Flat Base Breakout (Darvas Box)", confidence: 0.6 };
  }
  return null;
}

function detectPreMarketBreakout(candles) {
  if (candles.length < 20) return null;
  const rangeHigh = highest(candles.slice(-20, -15), 5);
  const last = candles.at(-1);
  if (last.close > rangeHigh) {
    return { name: "Pre-Market High/Low Breakout", confidence: 0.55 };
  }
  return null;
}

function detectTrendReversalCombo(candles) {
  if (candles.length < 30) return null;
  const closes = candles.map((c) => c.close);
  const ema50 = calculateEMA(closes, 50);
  const ema9 = calculateEMA(closes, 9);
  const last = candles.at(-1);
  const prev = candles.at(-2);
  if (ema9 > ema50 && prev.low <= ema9 && last.close > prev.close) {
    return { name: "Trend + Reversal Combo", confidence: 0.6 };
  }
  return null;
}

function detectAtrExpansionBreakout(candles) {
  if (candles.length < 15) return null;
  const atr = getATR(candles, 14);
  const prevAtr = getATR(candles.slice(0, -1), 14);
  const last = candles.at(-1);
  if (atr > prevAtr * 1.2 && last.close > highest(candles, 5)) {
    return { name: "ATR Expansion Breakout", confidence: 0.6 };
  }
  return null;
}

function detectMultiTimeFrameAlignment(candles) {
  if (candles.length < 50) return null;
  const closes = candles.map((c) => c.close);
  const ema15 = calculateEMA(closes, 15);
  const ema50 = calculateEMA(closes, 50);
  const last = candles.at(-1);
  if (last.close > ema15 && ema15 > ema50) {
    return { name: "Multi-Time Frame Alignment", confidence: 0.55 };
  }
  return null;
}

function detectEarningsGapReversal(candles) {
  if (candles.length < 5) return null;
  const last = candles.at(-1);
  const prev = candles.at(-2);
  if (
    Math.abs(last.open - prev.close) / prev.close > 0.05 &&
    last.close < last.open &&
    last.high - last.low > prev.high - prev.low
  ) {
    return { name: "Earnings Gap Reversal", confidence: 0.55 };
  }
  return null;
}

function detectCprBreakout(candles) {
  if (candles.length < 4) return null;
  const pivots = [
    candles.at(-4).close,
    candles.at(-3).close,
    candles.at(-2).close,
  ];
  const avgPivot = avg(pivots);
  const last = candles.at(-1);
  if (last.close > avgPivot && last.close > highest(candles, 4)) {
    return { name: "CPR Breakout", confidence: 0.55 };
  }
  return null;
}

function detectNewsVolatilityTrap(candles) {
  if (candles.length < 3) return null;
  const last = candles.at(-1);
  if (
    last.high - last.low >
      avg(candles.slice(-3).map((c) => c.high - c.low)) * 1.5 &&
    last.close < last.open
  ) {
    return { name: "News-Based Volatility Trap", confidence: 0.55 };
  }
  return null;
}

function detectRelativeStrength(candles) {
  if (candles.length < 10) return null;
  const closes = candles.map((c) => c.close);
  const ema10 = calculateEMA(closes, 10);
  const last = candles.at(-1);
  if (last.close > ema10) {
    return { name: "Relative Strength (Sector vs Stock)", confidence: 0.5 };
  }
  return null;
}

function detectLiquidityTrap(candles) {
  if (candles.length < 3) return null;
  const last = candles.at(-1);
  const prev = candles.at(-2);
  if (
    prev.volume < avg(candles.slice(-3, -1).map((c) => c.volume)) * 0.5 &&
    last.volume > prev.volume * 2 &&
    last.close < last.open
  ) {
    return { name: "Liquidity Trap Detection", confidence: 0.55 };
  }
  return null;
}

function detectTrendExhaustion(candles) {
  if (candles.length < 6) return null;
  const last = candles.at(-1);
  const rsi = calculateRSI(
    candles.map((c) => c.close),
    14
  );
  const candlesUp = candles.slice(-5).every((c) => c.close > c.open);
  if (candlesUp && rsi > 75 && last.close < last.open) {
    return { name: "Trend Exhaustion Strategy", confidence: 0.6 };
  }
  return null;
}

function detectCompressionBreakout(candles) {
  if (candles.length < 8) return null;
  const ranges = candles.slice(-8).map((c) => c.high - c.low);
  const shrinking = ranges.every((r, i) => i === 0 || r <= ranges[i - 1]);
  const last = candles.at(-1);
  if (shrinking && last.close > highest(candles, 8)) {
    return { name: "Consolidation Compression Breakout", confidence: 0.6 };
  }
  return null;
}

function detectOpeningRangeFakeout(candles) {
  if (candles.length < 15) return null;
  const first15High = highest(candles.slice(0, 15), 15);
  const last = candles.at(-1);
  if (last.high > first15High && last.close < first15High) {
    return { name: "Intraday Opening Range Fakeout", confidence: 0.55 };
  }
  return null;
}

function detectInsideOutsideInside(candles) {
  if (candles.length < 4) return null;
  const a = candles.at(-3);
  const b = candles.at(-2);
  const c = candles.at(-1);
  if (b.high > a.high && b.low < a.low && c.high < b.high && c.low > b.low) {
    return { name: "Inside–Outside–Inside Pattern (IOI)", confidence: 0.55 };
  }
  return null;
}

function detect50SmaAnchor(candles) {
  if (candles.length < 50) return null;
  const closes = candles.map((c) => c.close);
  const sma50 = calculateEMA(closes, 50);
  const last = candles.at(-1);
  const prev = candles.at(-2);
  if (prev.low <= sma50 && last.close > prev.close) {
    return { name: "50 SMA Anchor Setup", confidence: 0.55 };
  }
  return null;
}

function detectFalseBreakdownReclaim(candles) {
  if (candles.length < 5) return null;
  const lows = candles.slice(-5).map((c) => c.low);
  const support = Math.min(...lows);
  const last = candles.at(-1);
  const prev = candles.at(-2);
  if (prev.close < support && last.close > support) {
    return { name: "False Breakdown Reclaim (FDR)", confidence: 0.6 };
  }
  return null;
}

function detectMultiCandleTrapBar(candles) {
  if (candles.length < 3) return null;
  const [a, b, c] = candles.slice(-3);
  if (a.close < a.open && b.open === b.close && c.close > b.high) {
    return { name: "Multi-Candle Trap Bar", confidence: 0.55 };
  }
  return null;
}

function detectStairStep(candles) {
  if (candles.length < 3) return null;
  const last3 = candles.slice(-3);
  const higherHighs = last3.every(
    (d, i) => i === 0 || d.high > last3[i - 1].high
  );
  const smallBodies = last3.every(
    (d) => Math.abs(d.close - d.open) < (d.high - d.low) * 0.5
  );
  if (higherHighs && smallBodies) {
    return { name: "Stair-Step Strategy", confidence: 0.55 };
  }
  return null;
}

function detectEmaSweepReversal(candles) {
  if (candles.length < 20) return null;
  const closes = candles.map((c) => c.close);
  const ema5 = calculateEMA(closes, 5);
  const ema13 = calculateEMA(closes, 13);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const last = candles.at(-1);
  if (
    last.low <= ema20 &&
    last.close > ema20 &&
    ema5 < ema13 &&
    ema13 < ema20
  ) {
    return { name: "EMA Sweep Reversal", confidence: 0.6 };
  }
  return null;
}

function detectVolumeClusterBreakout(candles) {
  if (candles.length < 10) return null;
  const highVols = candles
    .slice(-10, -2)
    .filter((c) => c.volume > avg(candles.slice(-10).map((d) => d.volume)));
  const rangeHigh = highest(candles, 10);
  const last = candles.at(-1);
  if (highVols.length >= 2 && last.close > rangeHigh) {
    return { name: "Volume Cluster Breakout", confidence: 0.6 };
  }
  return null;
}

function detectBreakoutFailureReversal(candles) {
  if (candles.length < 6) return null;
  const breakout = highest(candles.slice(-6, -1), 5);
  const last = candles.at(-1);
  const prev = candles.at(-2);
  if (prev.close > breakout && last.close < breakout) {
    return { name: "Breakout Failure + Trend Reversal", confidence: 0.55 };
  }
  return null;
}

function detectAdxDiStrength(candles) {
  if (candles.length < 15) return null;
  const atr = getATR(candles, 14);
  const diff = highest(candles, 1) - lowest(candles, 1);
  if (diff > atr && atr > 0) {
    return { name: "ADX + DI Trend Strength Validator", confidence: 0.55 };
  }
  return null;
}

function detectHeikinAshiContinuation(candles) {
  if (candles.length < 4) return null;
  const last3 = candles.slice(-3);
  const noLowerWick = last3.every((c) => c.open <= c.low && c.close >= c.open);
  if (noLowerWick && candles.at(-1).close > candles.at(-2).close) {
    return { name: "Heikin Ashi Trend Continuation", confidence: 0.55 };
  }
  return null;
}

function detectRsiRangeShift(candles) {
  if (candles.length < 20) return null;
  const closes = candles.map((c) => c.close);
  const rsi = calculateRSI(closes, 14);
  const prevRsi = calculateRSI(closes.slice(0, -5), 14);
  if (prevRsi < 50 && rsi > 60) {
    return { name: "RSI Range Shift", confidence: 0.55 };
  }
  return null;
}

function detectGapFill(candles) {
  if (candles.length < 3) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  if (
    Math.abs(prev.close - last.open) / prev.close > 0.03 &&
    last.close === prev.close
  ) {
    return { name: "Gap Fill Strategy", confidence: 0.55 };
  }
  return null;
}

function detectVcp(candles) {
  if (candles.length < 15) return null;
  const ranges = candles.slice(-15).map((c) => c.high - c.low);
  const declining = ranges.every((r, i) => i === 0 || r <= ranges[i - 1]);
  const last = candles.at(-1);
  if (declining && last.close > highest(candles, 5)) {
    return { name: "Volatility Contraction Pattern (VCP)", confidence: 0.6 };
  }
  return null;
}

function detectParabolicExhaustion(
  candles,
  _ctx = {},
  config = DEFAULT_CONFIG
) {
  if (candles.length < 5) return null;
  const last5 = candles.slice(-5);
  const rising = last5.every((c) => c.close > c.open);
  const rsi = calculateRSI(
    candles.map((c) => c.close),
    14
  );
  if (rising && rsi > config.rsiExhaustion) {
    const last = candles.at(-1);
    if (last.close < last.open) {
      return { name: "Parabolic Exhaustion Short", confidence: 0.6 };
    }
  }
  return null;
}

function detectEmaSnapback(candles) {
  if (candles.length < 20) return null;
  const closes = candles.map((c) => c.close);
  const ema20 = calculateEMA(closes, 20);
  const last = candles.at(-1);
  if (Math.abs(last.close - ema20) / ema20 > 0.05 && last.close < last.open) {
    return { name: "EMA Snapback Mean Reversion", confidence: 0.55 };
  }
  return null;
}

function detectInstitutionalFootprintBreakout(candles) {
  if (candles.length < 10) return null;
  const obv = candles.reduce((acc, c, idx) => {
    if (idx === 0) return 0;
    return acc + (c.close > candles[idx - 1].close ? c.volume : -c.volume);
  }, 0);
  const last = candles.at(-1);
  if (obv > 0 && last.close > highest(candles, 5)) {
    return { name: "Institutional Footprint Breakout", confidence: 0.6 };
  }
  return null;
}

function detectEventVolatilityTrap(candles) {
  if (candles.length < 3) return null;
  const last = candles.at(-1);
  const prev = candles.at(-2);
  if (
    last.high - last.low > prev.high - prev.low * 1.5 &&
    last.close < prev.close
  ) {
    return { name: "Event Volatility Trap + Spike Fade", confidence: 0.55 };
  }
  return null;
}

function detectOpeningRangeReversal(candles) {
  if (candles.length < 30) return null;
  const rangeHigh = highest(candles.slice(0, 30), 30);
  const rangeLow = lowest(candles.slice(0, 30), 30);
  const last = candles.at(-1);
  if (last.high > rangeHigh && last.close < rangeHigh) {
    return { name: "Opening Range Reversal (ORR)", confidence: 0.55 };
  }
  if (last.low < rangeLow && last.close > rangeLow) {
    return { name: "Opening Range Reversal (ORR)", confidence: 0.55 };
  }
  return null;
}

function detectVpaTrapCandle(candles) {
  if (candles.length < 3) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  if (
    last.volume > prev.volume * 2 &&
    Math.abs(last.close - last.open) < (last.high - last.low) * 0.2
  ) {
    return {
      name: "Volume Price Analysis (VPA) Trap Candle",
      confidence: 0.55,
    };
  }
  return null;
}

function detectDeltaDivergence(candles) {
  if (candles.length < 3) return null;
  const last = candles.at(-1);
  const prevHigh = highest(candles.slice(-3, -1), 2);
  if (last.high > prevHigh && (last.delta || 0) < (candles.at(-2).delta || 0)) {
    return { name: "Delta Divergence Strategy", confidence: 0.55 };
  }
  return null;
}

function detectRangeCompressionRsiFlush(candles) {
  if (candles.length < 10) return null;
  const ranges = candles.slice(-10).map((c) => c.high - c.low);
  const compressed = ranges.every((r) => r < avg(ranges) * 1.2);
  const rsi = calculateRSI(
    candles.map((c) => c.close),
    14
  );
  const last = candles.at(-1);
  if (
    compressed &&
    (rsi < 30 || rsi > 70) &&
    Math.abs(last.close - last.open) > (last.high - last.low) * 0.5
  ) {
    return { name: "Range Compression + RSI Flush", confidence: 0.55 };
  }
  return null;
}

function detectMaSlopeAcceleration(candles) {
  if (candles.length < 25) return null;
  const closes = candles.map((c) => c.close);
  const ema20Prev = calculateEMA(closes.slice(0, -1), 20);
  const ema20Curr = calculateEMA(closes, 20);
  if (ema20Curr > ema20Prev * 1.005 && closes.at(-1) > ema20Curr) {
    return { name: "MA Slope Acceleration Strategy", confidence: 0.55 };
  }
  return null;
}

function detectVwapRejectionBounce(candles) {
  if (candles.length < 10) return null;
  const vwap = calculateVWAP(candles.slice(-10));
  const last = candles.at(-1);
  const prev = candles.at(-2);
  if (prev.close < vwap && last.close > vwap && last.low > prev.low) {
    return { name: "Volume-Weighted Rejection Bounce", confidence: 0.55 };
  }
  return null;
}

function detectMarketSentimentReversal(candles) {
  if (candles.length < 3) return null;
  const last = candles.at(-1);
  if (
    last.high - last.close > (last.high - last.low) * 0.6 &&
    calculateRSI(
      candles.map((c) => c.close),
      14
    ) > 75
  ) {
    return { name: "Market Sentiment Reversal", confidence: 0.55 };
  }
  return null;
}

// List of all detector functions mapped to their strategy name
export const DETECTORS = [
  detectEmaCrossover,
  detectBreakoutRetest,
  detectHammerDemandZone,
  detectHighVolumeBreakout,
  detectVduPocketPivot,
  detectEmaRibbonCompression,
  detectSupertrendRsi,
  detectMicrotrendPullback,
  detectFibonacciPullback,
  detectBullishDivergence,
  detectDoubleBottomBreakout,
  detectDarkCloudPiercing,
  detectBollingerBounce,
  detectInsideBarBreakout,
  detectSupportResistancePingPong,
  detectVWReversalZone,
  detectGapOpeningRangeBreakout,
  detectVwapBounce,
  detectFlatBaseBreakout,
  detectPreMarketBreakout,
  detectTrendReversalCombo,
  detectAtrExpansionBreakout,
  detectMultiTimeFrameAlignment,
  detectEarningsGapReversal,
  detectCprBreakout,
  detectNewsVolatilityTrap,
  detectRelativeStrength,
  detectLiquidityTrap,
  detectTrendExhaustion,
  detectCompressionBreakout,
  detectOpeningRangeFakeout,
  detectInsideOutsideInside,
  detect50SmaAnchor,
  detectFalseBreakdownReclaim,
  detectMultiCandleTrapBar,
  detectStairStep,
  detectEmaSweepReversal,
  detectVolumeClusterBreakout,
  detectBreakoutFailureReversal,
  detectAdxDiStrength,
  detectHeikinAshiContinuation,
  detectRsiRangeShift,
  detectGapFill,
  detectVcp,
  detectParabolicExhaustion,
  detectEmaSnapback,
  detectInstitutionalFootprintBreakout,
  detectEventVolatilityTrap,
  detectOpeningRangeReversal,
  detectVpaTrapCandle,
  detectDeltaDivergence,
  detectRangeCompressionRsiFlush,
  detectMaSlopeAcceleration,
  detectVwapRejectionBounce,
  detectMarketSentimentReversal,
];

export function evaluateStrategies(
  candles,
  context = {},
  options = { topN: 1, filters: null, config: DEFAULT_CONFIG }
) {
  if (!Array.isArray(candles) || candles.length < 5) return [];
  const cfg = options.config || DEFAULT_CONFIG;
  let results = DETECTORS.map((fn) => fn(candles, context, cfg))
    .filter(Boolean)
    .map((r) => ({ ...STRATEGY_CATALOG[r.name], ...r }));
  if (options.filters) {
    results = applyFilters(results, context, options.filters);
  }
  results.sort((a, b) => b.confidence - a.confidence);
  return options.topN ? results.slice(0, options.topN) : results;
}

function applyFilters(strategies, context, filters) {
  return strategies.filter((s) => {
    if (filters.minRvol && context.rvol && context.rvol < filters.minRvol) {
      return false;
    }
    if (
      filters.session &&
      context.session &&
      context.session !== filters.session
    ) {
      return false;
    }
    return true;
  });
}

export const trendFollowing = [
  {
    name: "EMA Crossover + Volume Spike",
    rules: [
      "Buy when 21 EMA crosses above 50 EMA",
      "Last candle closes above both EMAs",
      "Volume > 1.5x average of last 10 candles",
    ],
    stopLoss: "Recent swing low",
    target: "1.5–2x stop loss distance",
  },
  {
    name: "Supertrend + RSI Filter",
    rules: [
      "Price closes above Supertrend",
      "RSI > 55 and trending up",
      "Volume confirmation optional",
    ],
    notes: "Ideal for trending stocks",
  },
  {
    name: "Breakout + Retest",
    rules: [
      "Price breaks key resistance",
      "Pulls back to resistance-turned-support",
      "Bullish engulfing or inverted hammer forms",
    ],
    notes: "High R:R setups",
  },
  {
    name: "20 EMA Pullback (Microtrend)",
    rules: [
      "Price above 200 EMA (uptrend)",
      "Price pulls back to touch or wick 20 EMA",
      "Bullish pin bar or hammer confirmed by volume",
    ],
  },
  {
    name: "Fibonacci Pullback Strategy",
    rules: [
      "Price retraces to 38.2% or 61.8% Fibonacci level in trend",
      "Look for bullish reversal candle and bounce confirmation",
    ],
    notes: "Common institutional pullback level for structured trades",
  },
];

export const reversalStrategies = [
  {
    name: "Hammer at Demand Zone + ATR Filter",
    rules: [
      "Price falls into marked support zone",
      "Hammer candle forms with small body and long wick",
      "ATR shows sufficient volatility",
    ],
  },
  {
    name: "Bullish Divergence with RSI",
    rules: [
      "Price makes lower low",
      "RSI makes higher low",
      "Enter on bullish engulfing or close above prior high",
    ],
    notes: "Works best near key support",
  },
  {
    name: "Double Bottom with Breakout Confirmation",
    rules: [
      "W pattern forms",
      "Neckline breakout on volume",
      "Enter on candle close above neckline",
    ],
    stopLoss: "Below second low",
  },
  {
    name: "Dark Cloud Cover / Piercing Line Reversal",
    rules: [
      "Two-candle reversal after trend",
      "Dark Cloud Cover (bearish) or Piercing Line (bullish)",
      "Volume and location near support/resistance improve reliability",
    ],
  },
];

export const meanReversionStrategies = [
  {
    name: "Bollinger Band Bounce",
    rules: [
      "Price touches or closes outside lower band",
      "Bullish candle closes back inside bands",
      "Enter on next candle high breakout",
    ],
    stopLoss: "Below band",
    target: "20 SMA",
  },
  {
    name: "Inside Bar Range Breakout",
    rules: [
      "Narrow inside bar inside consolidation",
      "Enter on break of inside bar high/low",
    ],
    notes: "Use tight stop for good risk/reward",
  },
  {
    name: "Support-Resistance Ping Pong",
    rules: [
      "Buy near support with reversal candle",
      "Sell near resistance with rejection candle",
    ],
  },
  {
    name: "Volume-Weighted Reversal Zone (VW-RZ)",
    rules: [
      "Price deviates from VWAP by more than 2% and hits extreme level",
      "Look for sharp wick and volume spike near VWAP rejection area",
    ],
    notes: "Combines mean reversion with VWAP-based fade",
  },
];

export const momentumBreakoutStrategies = [
  {
    name: "Gap Up + Opening Range Breakout",
    rules: [
      "Gap up above previous day's high",
      "Mark first 15‑min high/low",
      "Enter on breakout with volume",
    ],
    target: "1.5x range",
    stopLoss: "Low of breakout candle",
  },
  {
    name: "VWAP Bounce",
    rules: [
      "Trending market",
      "Price pulls back to VWAP",
      "Bullish pin/engulfing at VWAP",
    ],
  },
  {
    name: "High Volume Breakout",
    rules: [
      "Price breaks swing high or consolidation",
      "Volume > 2x 10-period average",
      "No nearby resistance",
    ],
  },
  {
    name: "Flat Base Breakout (Darvas Box)",
    rules: [
      "Narrow range for 5–10 candles",
      "Breaks high of base on big green candle",
      "Confirm with volume or RSI > 60",
    ],
  },
  {
    name: "Pre-Market High/Low Breakout",
    rules: [
      "Use pre-market range such as 9:00–9:15",
      "Trade breakouts from this range after market open with volume",
    ],
    notes: "Great for momentum scalps especially on news-driven gaps",
  },
];

export const smartContextualStrategies = [
  {
    name: "Trend + Reversal Combo",
    rules: [
      "Higher timeframe trending",
      "Lower timeframe shows reversal at pullback",
    ],
    example: "1H uptrend + 5‑min hammer at 20 EMA",
  },
  {
    name: "ATR Expansion Breakout",
    rules: [
      "Consolidation with low ATR",
      "ATR spikes with strong breakout candle",
      "Enter above breakout; SL = ATR of last 5 candles",
    ],
  },
  {
    name: "Multi‑Time Frame Alignment",
    rules: ["1H and 15m EMAs aligned", "5‑min chart gives clean signal"],
    notes: "Filter low quality trades using higher timeframe context",
  },
];

export const advancedTemplates = [
  {
    name: "Earnings Gap Reversal",
    description:
      "Fade the gap after earnings beat/miss using VWAP and volume cues",
  },
  {
    name: "CPR Breakout",
    description:
      "Trade Central Pivot Range breakout with volume and trend bias",
  },
  {
    name: "News-Based Volatility Trap",
    description:
      "Wait for spike candle after news and fade reversal with tight stop",
  },
];

export const additionalStrategies = [
  {
    name: "Relative Strength (Sector vs Stock)",
    rules: [
      "Buy stocks that consistently outperform their sector index",
      "Combine with a momentum pattern like VWAP bounce",
    ],
    example: "ADANIENT outperforming NIFTY_ENERGY",
    notes: "Ranks and prioritizes strong stocks dynamically",
  },
  {
    name: "Liquidity Trap Detection",
    rules: [
      "Low volume period followed by sudden large bullish candle",
      "Use to fade or avoid false breakouts",
    ],
    notes: "Helps filter out bad signals",
  },
  {
    name: "Trend Exhaustion Strategy",
    rules: [
      "Three to five large green candles in a row with RSI above 75",
      "Look for inverted hammer to set up short reversal",
    ],
    notes: "Catches the end of strong moves early",
  },
  {
    name: "Consolidation Compression Breakout",
    rules: [
      "Candle body ranges shrink over time while volume dries up",
      "Enter on volume burst breakout",
    ],
    notes: "Low risk, high reward opportunity",
  },
  {
    name: "Intraday Opening Range Fakeout",
    rules: [
      "Breaks 15‑min high then quickly reverses",
      "Detect the fake breakout and fade it",
    ],
    notes: "Avoid trap moves in volatile stocks",
  },
];

export const expertStrategies = [
  {
    name: "Volume Dry-Up (VDU) + Pocket Pivot",
    rules: [
      "Consolidation with steadily declining volume",
      "Sudden volume and price burst signals pocket pivot breakout",
    ],
    notes: "Popular momentum setup used by Mark Minervini",
  },
  {
    name: "Inside–Outside–Inside Pattern (IOI)",
    rules: [
      "Inside bar followed by an outside bar then another inside bar",
      "Indicates compression and potential trap before breakout",
      "Entry on break of the last inside bar high/low",
    ],
  },
  {
    name: "50 SMA Anchor Setup",
    rules: [
      "Price holds above the 50 SMA for several sessions",
      "Rejects pullback to the 50 SMA with long wick or bullish candle",
      "Combine with relative strength or RSI confirmation",
    ],
  },
  {
    name: "False Breakdown Reclaim (FDR)",
    rules: [
      "Price breaks below clear support forming a trap",
      "Immediately reclaims and closes back above support",
      "Enter on next candle high for intraday reversals",
    ],
  },
  {
    name: "Multi-Candle Trap Bar",
    rules: [
      "Sharp down move followed by doji then bullish engulfing",
      "Entry on break of engulfing candle high",
      "Stop loss below the trap low for tight risk",
    ],
  },
  {
    name: "Stair-Step Strategy",
    rules: [
      "Three or more small green candles each making higher highs",
      "Gradually increasing volume",
      "Enter after the third candle and trail stop-loss",
    ],
  },
  {
    name: "EMA Sweep Reversal",
    rules: [
      "Price cuts through 5 EMA, 13 EMA and 20 EMA before bouncing",
      "Look for final hammer near 50 EMA or VWAP",
      "Enter on bounce confirmation",
    ],
    notes: "Great for exhaustion pullbacks in strong trends",
  },
  {
    name: "Volume Cluster Breakout",
    rules: [
      "Price consolidates inside a tight range with large volume candles",
      "Breakout from this zone tends to have higher success",
      "Volume profile clusters can enhance the signal",
    ],
    notes: "Rare but powerful breakout filter",
  },
  {
    name: "EMA Ribbon Compression",
    rules: [
      "All short term EMAs (5‑50) squeeze together",
      "Price then breaks hard from the compression zone",
    ],
    notes: "Detects transition from range to trend",
  },
  {
    name: "Breakout Failure + Trend Reversal",
    rules: [
      "Price breaks out of a range but quickly fails and closes back inside",
      "Look for RSI divergence or bearish engulfing to confirm",
    ],
    notes: "Useful for fading false breakouts in choppy markets",
  },
  {
    name: "ADX + DI Trend Strength Validator",
    rules: [
      "Use ADX above 25 with DI+ greater than DI‑ for trend confirmation",
      "Combine with pullback or breakout entries",
    ],
    notes: "Adds strength filter to reduce noise",
  },
  {
    name: "Heikin Ashi Trend Continuation",
    rules: [
      "Three or more Heikin Ashi green candles with no lower wick",
      "Enter on break of the next green candle",
      "Optional confirmation with RSI > 60 or VWAP",
    ],
  },
  {
    name: "RSI Range Shift",
    rules: [
      "RSI moves from below 50 to above 60 and stays elevated",
      "Combine with a flag or breakout pattern",
    ],
    notes: "Detects early stage uptrends",
  },
  {
    name: "Gap Fill Strategy",
    rules: [
      "Price gaps up or down then quickly retraces",
      "Look for move that fills the gap with VWAP or volume confirmation",
    ],
    notes: "Works well with a time filter such as after 10:15am",
  },
  {
    name: "Volatility Contraction Pattern (VCP)",
    rules: [
      "Series of narrowing price swings with declining volume",
      "Final contraction breakout occurs on high volume",
      "Optional: detect volume dry-up and three or more contractions",
    ],
    notes: "Mark Minervini momentum setup for explosive breakouts",
  },
  {
    name: "Parabolic Exhaustion Short",
    rules: [
      "Four or more green candles with increasing body and volume",
      "RSI above 80 or price > 3x ATR from mean",
      "Look for shooting star or inverted hammer at the peak",
    ],
    notes: "Helps fade climactic blow-offs especially in small caps",
  },
  {
    name: "EMA Snapback Mean Reversion",
    rules: [
      "Price trades more than 5% away from the 20 EMA intraday",
      "Rejection candle such as an inverted hammer or engulfing",
      "Play mean reversion trade back toward the EMA",
    ],
    notes: "Quick high R:R setups on mean-reverting instruments",
  },
  {
    name: "Institutional Footprint Breakout",
    rules: [
      "Accumulation shown by rising OBV or volume on up days",
      "Price breaks above key resistance on strong volume",
    ],
    notes: "Tracks smart money entry before breakout",
  },
  {
    name: "Event Volatility Trap + Spike Fade",
    rules: [
      "Large wick candle after major event or news",
      "Candle re-enters prior range and fades back",
      "Often pairs with VWAP fade for entry",
    ],
    notes: "Fades overreactions to news or events",
  },
  {
    name: "Opening Range Reversal (ORR)",
    rules: [
      "Price breaks OR high/low in first 30 mins",
      "Fails to sustain and closes back inside the range",
      "Enter on reverse breakout of opposite side with volume spike",
    ],
    // Great for fading early traps and over-extended moves
  },
  {
    name: "Volume Price Analysis (VPA) Trap Candle",
    rules: [
      "Wide-range candle on extreme volume at key level",
      "Followed by small body or inside bar indicating trap",
      "Enter opposite side on confirmation",
    ],
    // Combines price action with volume psychology to spot traps
  },
  {
    name: "Delta Divergence Strategy",
    rules: [
      "Price makes new high but delta or CVD is lower than previous high",
      "Enter short on bearish candle confirmation",
    ],
    // Requires order-flow data to detect fake breakouts
  },
  {
    name: "Range Compression + RSI Flush",
    rules: [
      "RSI flatlines below 30 or above 70 within a tight range",
      "Strong move breaks the range in direction of fresh volume",
    ],
    // Useful for breakout trades after long low-volatility periods
  },
  {
    name: "MA Slope Acceleration Strategy",
    rules: [
      "9 EMA or 20 EMA slope turns sharply upward",
      "Price crosses and holds above for two or more candles",
    ],
    // Captures the early acceleration phase of a trend
  },
  {
    name: "Volume-Weighted Rejection Bounce",
    rules: [
      "Price reclaims VWAP on a strong candle",
      "Enter on pullback with bullish pin and rising volume",
    ],
    // Adds precision to VWAP bounce longs with volume weighting
  },
  {
    name: "Market Sentiment Reversal",
    rules: [
      "Price surges on positive news and forms a large upper wick",
      "Volume clusters at the top with RSI above 75",
    ],
    // Fades irrational spikes caused by news-driven sentiment
  },
];

export const optionalFilters = [
  {
    name: "Relative Volume (RVOL > 2)",
    value: "Filters strong setups",
  },
  {
    name: "No major news (volatility block)",
    value: "Avoids random spikes",
  },
  {
    name: "Sector leader confirmation",
    value: "Follow smart money",
  },
  {
    name: "Market trend alignment",
    value: "Avoids counter-trend setups",
  },
  {
    name: "Auto SL distance validator using ATR",
    value: "Keeps risk/reward tight and consistent",
  },
  {
    name: "SL/Target invalidation logic",
    value: "Avoid entries too far from stop-loss",
  },
  {
    name: "Bid-Ask Spread Width Check",
    value: "Avoids illiquid trades",
  },
  {
    name: "Time-of-Day Filter",
    value: "Skip setups outside preferred trading hours",
  },
  {
    name: "News Sentiment API Filter",
    value: "Exclude trades with negative news flow",
  },
  {
    name: "Pattern Cleanliness Scoring",
    value: "Ensure engulfing patterns engulf body and wick",
  },
  {
    name: "Gap % Size Limit",
    value: "Filter out stocks with extreme gaps",
  },
  {
    name: "Dynamic Position Sizing Filter",
    value: "Use ATR or range to suggest capital allocation",
  },
  {
    name: "Smart ATR/EMA Compression Score",
    value: "Score setups based on tightness and contraction",
  },
  {
    name: "Multi-Candle Risk Exposure Guard",
    value: "Avoid re-entry into multiple setups on same stock",
  },
  {
    name: "SIP Volume Filter",
    value: "Filter trades on sudden intraday price and volume shifts",
  },
  {
    name: "Custom Volatility Regime Filter",
    value: "Use rolling ATR or VIX to enable or disable strategies",
  },
  {
    name: "Institutional Trade Zones (ITZ)",
    value: "Zones derived from historical volume pivots",
  },
  {
    name: "Market Breadth Filter",
    value: "Requires advance/decline ratio above 1.5",
  },
  {
    name: "Volume Profile Node Rejection",
    value: "Use visible range POC rejection to confirm trades",
  },
  {
    name: "Price Inside Liquidity Pool",
    value: "Filter setups occurring within multiple candle highs/lows",
  },
  {
    name: "Execution Speed Filter",
    value: "Allow trades only if volatility is below a threshold",
  },
];

export default [
  ...trendFollowing,
  ...reversalStrategies,
  ...meanReversionStrategies,
  ...momentumBreakoutStrategies,
  ...smartContextualStrategies,
  ...advancedTemplates,
  ...additionalStrategies,
  ...expertStrategies,
];

// Map strategy names to their metadata for quick lookup when evaluating
export const STRATEGY_CATALOG = {};
for (const s of [
  ...trendFollowing,
  ...reversalStrategies,
  ...meanReversionStrategies,
  ...momentumBreakoutStrategies,
  ...smartContextualStrategies,
  ...advancedTemplates,
  ...additionalStrategies,
  ...expertStrategies,
]) {
  STRATEGY_CATALOG[s.name] = s;
}
