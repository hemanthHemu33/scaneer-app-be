// STRATEGIES.JS

import {
  calculateEMA,
  calculateRSI,
  calculateSupertrend,
  calculateVWAP,
  calculateAnchoredVWAP,
  getATR,
  computeFeatures,
} from "./featureEngine.js";
import { confirmRetest, detectAllPatterns, sanitizeCandles } from "./util.js";

// Indicator helpers imported above return only the latest scalar value.
// Any indicator series needed by strategies should be generated locally
// (e.g., via `emaSeries`) to keep call sites consistent and predictable.

// Default thresholds used by strategy detectors. These can be overridden
// via the optional `config` parameter in `evaluateStrategies`.
// Default configuration for strategy detectors. Frozen to prevent
// accidental runtime mutation in production deployments.
export const DEFAULT_CONFIG = Object.freeze({
  gapPctMinLong: 1.5,
  gapPctMinShort: 1.5,
  maxGapPct: 10,
  volumeSpikeMultiplier: 1.5,
  rvolMin: 1,
  ribbonCompressionATRx: 0.5,
  rsiOB: 70,
  rsiOS: 30,
  rsiExhaustion: 80,
  vwapMode: "rolling",
  vwapDeviationPct: 0.02,
  insideBarNarrowPct: 0.3,
  requireBreakoutRetest: "soft",
  riskAtrMaxMultiple: 3,
  slAtrMultiple: 1,
  targetAtrMultiples: [1, 2],
  noTradeOpenMins: 10,
  noTradeCloseMins: 10,
  allowPreOpenEntries: false,
  openRangeMins: 30,
  eventRvolMultiplier: 1.5,
  eventSlAtrMultiplier: 1.5,
  regimeAtrZScoreBins: { low: -1, high: 1 },
  maxSpreadPct: 0.5,
  minAvgVolume: 100000,
});

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
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function highest(candles, count) {
  if (!candles.length) return null;
  const slice = candles.slice(-count);
  return Math.max(...slice.map((c) => c.high));
}

function lowest(candles, count) {
  if (!candles.length) return null;
  const slice = candles.slice(-count);
  return Math.min(...slice.map((c) => c.low));
}

const IST_OFFSET_MIN = 330; // IST is UTC+5:30
function istMinutes(ts) {
  const d = new Date(ts);
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + IST_OFFSET_MIN) % 1440;
}
function inIstRange(ts, start, end) {
  const m = istMinutes(ts);
  return m >= start && m < end;
}
const PREOPEN_START = 9 * 60;
const PREOPEN_END = 9 * 60 + 15;
const MARKET_OPEN = PREOPEN_END;
const MARKET_CLOSE = 15 * 60 + 30;

function rangeBetween(candles, startMin, endMin) {
  const window = candles.filter(
    (c) => typeof c.timestamp === "number" && inIstRange(c.timestamp, startMin, endMin)
  );
  if (!window.length) return null;
  return {
    high: Math.max(...window.map((c) => c.high)),
    low: Math.min(...window.map((c) => c.low)),
  };
}

function detectEmaCrossover(candles, _ctx = {}, config = DEFAULT_CONFIG) {
  if (candles.length < 50) return null;
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume || 0);
  const emaSeries21 = emaSeries(closes, 21);
  const emaSeries50 = emaSeries(closes, 50);
  const last = candles.at(-1);
  const avgVol =
    volumes.slice(-10).reduce((a, b) => a + b, 0) /
    Math.min(10, volumes.length);

  if (
    emaSeries21.at(-2) <= emaSeries50.at(-2) &&
    emaSeries21.at(-1) > emaSeries50.at(-1) &&
    last.close > emaSeries21.at(-1) &&
    last.volume > avgVol * config.volumeSpikeMultiplier
  ) {
    return { name: "EMA Crossover + Volume Spike", confidence: 0.8 };
  }
  return null;
}

function detectBreakoutRetest(candles, ctx = {}) {
  const cleanCandles = sanitizeCandles(candles);
  if (cleanCandles.length < 7) return null;
  const breakout = Math.max(...cleanCandles.slice(-7, -2).map((c) => c.high));
  const atrCandidate = ctx.atr;
  const atr =
    Number.isFinite(atrCandidate) && atrCandidate > 0
      ? atrCandidate
      : getATR(cleanCandles, 14) || 0;
  if (
    confirmRetest(cleanCandles.slice(-2), breakout, "Long", { atr })
  ) {
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
    .every((v, i) => v > 0 && v <= vols[i]);
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
  const ema5 = calculateEMA(closes, 5);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const spread = Math.max(ema5, ema20, ema50) - Math.min(ema5, ema20, ema50);
  const price = closes.at(-1);
  const atr = getATR(candles, 14) || 0;
  if (
    spread < atr * config.ribbonCompressionATRx &&
    price > Math.max(ema5, ema20, ema50)
  ) {
    return { name: "EMA Ribbon Compression", confidence: 0.65 };
  }
  return null;
}

function detectSupertrendRsi(candles, _ctx = {}, config = DEFAULT_CONFIG) {
  if (candles.length < 20) return null;
  const closes = candles.map((c) => c.close);
  const rsi = calculateRSI(closes, 14);
  const st = calculateSupertrend(candles, 10);
  const last = candles.at(-1);
  if (last.close > st.level && rsi > config.rsiOB) {
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

function detectInsideBarBreakout(candles, _ctx = {}, config = DEFAULT_CONFIG) {
  if (candles.length < 3) return null;
  const [pre, last] = [candles.at(-2), candles.at(-1)];
  if (last.high < pre.high && last.low > pre.low) return null;
  if (
    pre.high - pre.low <
    (highest(candles, 5) - lowest(candles, 5)) * config.insideBarNarrowPct
  ) {
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

function detectVWReversalZone(candles, _ctx = {}, config = DEFAULT_CONFIG) {
  if (candles.length < 10) return null;
  const vwap =
    config.vwapMode === "session"
      ? calculateAnchoredVWAP(candles)
      : calculateVWAP(candles.slice(-10));
  const last = candles.at(-1);
  const deviation = Math.abs(last.close - vwap) / vwap;
  if (
    deviation > config.vwapDeviationPct &&
    last.high - last.low > (highest(candles, 5) - lowest(candles, 5)) * 0.5
  ) {
    return { name: "Volume-Weighted Reversal Zone (VW-RZ)", confidence: 0.6 };
  }
  return null;
}

function detectGapOpeningRangeBreakout(candles) {
  const opening = candles.filter((c) =>
    typeof c.timestamp === 'number' && inIstRange(c.timestamp, MARKET_OPEN, MARKET_OPEN + 15)
  );
  if (!opening.length) return null;
  const first = opening[0];
  const rangeHigh = Math.max(...opening.map((c) => c.high));
  const last = candles.at(-1);
  if (first.open > first.close && last.close > rangeHigh) {
    return { name: "Gap Up + Opening Range Breakout", confidence: 0.6 };
  }
  return null;
}

export function detectGapUpOrDown(
  { dailyHistory, sessionCandles },
  _ctx = {},
  config = DEFAULT_CONFIG
) {
  if (!Array.isArray(dailyHistory) || dailyHistory.length < 2) return null;
  if (!Array.isArray(sessionCandles) || !sessionCandles[0]) return null;
  const yesterdayClose = dailyHistory[dailyHistory.length - 2]?.close;
  const todayOpen = sessionCandles[0].open;
  if (typeof yesterdayClose !== "number" || typeof todayOpen !== "number")
    return null;
  const gapPercent = ((todayOpen - yesterdayClose) / yesterdayClose) * 100;
  if (Math.abs(gapPercent) > config.maxGapPct) return null;
  if (gapPercent >= config.gapPctMinLong)
    return {
      type: "Gap-Up Breakout",
      direction: "Long",
      gapPercent,
      breakout: todayOpen,
      stopLoss: yesterdayClose,
    };
  if (gapPercent <= -config.gapPctMinShort)
    return {
      type: "Gap-Down Reversal",
      direction: "Short",
      gapPercent,
      breakout: todayOpen,
      stopLoss: yesterdayClose,
    };
  return null;
}

export function detectAndScorePattern(
  context = {},
  config = DEFAULT_CONFIG
) {
  const { candles = [], features = null } = context;
  const cleanCandles = sanitizeCandles(candles);
  if (!Array.isArray(cleanCandles) || cleanCandles.length < 5) return null;

  const featureSet = features ?? computeFeatures(cleanCandles);
  if (!featureSet) return null;

  const { ema9, ema21, ema200, rsi } = featureSet;
  const atr = (featureSet?.atr ?? getATR(cleanCandles, 14)) ?? 0;
  const patterns = detectAllPatterns(cleanCandles, atr, 5);
  if (!patterns || patterns.length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const p of patterns) {
    const score = (p.strength || 1) *
      (p.confidence === 'High' ? 1 : p.confidence === 'Medium' ? 0.6 : 0.3);
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  if (!best) return null;

  const last = cleanCandles.at(-1);
  if (typeof best.breakout !== 'number' || isNaN(best.breakout)) {
    best.breakout = last.close;
  }
  if (typeof best.stopLoss !== 'number' || isNaN(best.stopLoss)) {
    best.stopLoss =
      best.direction === 'Long' ? last.low : last.high;
  }

  if (best.type === 'Breakout') {
    const retested = confirmRetest(
      cleanCandles.slice(-2),
      best.breakout,
      best.direction,
      { atr }
    );
    if (config.requireBreakoutRetest === 'hard' && !retested) return null;
  }

  if (
    (best.direction === 'Long' && rsi > config.rsiExhaustion) ||
    (best.direction === 'Short' && rsi < config.rsiOS)
  ) {
    return null;
  }

  if (best.type === 'VWAP Reversal') {
    const slope = ema9 - ema21;
    if (Math.abs(slope) < 0.05) return null;
  }

  if (
    (best.direction === 'Long' && last.close < ema200) ||
    (best.direction === 'Short' && last.close > ema200)
  ) {
    return null;
  }

  return best;
}

function detectVwapBounce(candles, _ctx = {}, config = DEFAULT_CONFIG) {
  if (candles.length < 10) return null;
  const vwap =
    config.vwapMode === "session"
      ? calculateAnchoredVWAP(candles)
      : calculateVWAP(candles.slice(-10));
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const deviation = Math.abs(prev.low - vwap) / vwap;
  if (
    deviation <= config.vwapDeviationPct &&
    last.close > prev.close &&
    last.low > vwap
  ) {
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
  const pre = candles.filter((c) =>
    typeof c.timestamp === 'number' && inIstRange(c.timestamp, PREOPEN_START, PREOPEN_END)
  );
  if (!pre.length) return null;
  const rangeHigh = Math.max(...pre.map((c) => c.high));
  const last = candles.at(-1);
  if (
    typeof last.timestamp === 'number' &&
    istMinutes(last.timestamp) >= MARKET_OPEN &&
    last.close > rangeHigh
  ) {
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
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const pp = (prev.high + prev.low + prev.close) / 3;
  const bc = (prev.high + prev.low) / 2;
  const tc = 2 * pp - bc;
  const cprHigh = Math.max(bc, tc);
  if (last.close > cprHigh && last.close > prev.high) {
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
  const opening = candles.filter((c) =>
    typeof c.timestamp === 'number' && inIstRange(c.timestamp, MARKET_OPEN, MARKET_OPEN + 15)
  );
  if (!opening.length) return null;
  const rangeHigh = Math.max(...opening.map((c) => c.high));
  const last = candles.at(-1);
  if (
    typeof last.timestamp === 'number' &&
    istMinutes(last.timestamp) >= MARKET_OPEN + 15 &&
    last.high > rangeHigh &&
    last.close < rangeHigh
  ) {
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

function detectAtrRangeExpansion(candles) {
  if (candles.length < 15) return null;
  const atr = getATR(candles, 14);
  const diff = highest(candles, 1) - lowest(candles, 1);
  if (diff > atr && atr > 0) {
    return { name: "ATR Range Expansion", confidence: 0.55 };
  }
  return null;
}

function detectMarubozuContinuation(candles) {
  if (candles.length < 4) return null;
  const last3 = candles.slice(-3);
  const noLowerWick = last3.every((c) => c.open <= c.low && c.close >= c.open);
  if (noLowerWick && candles.at(-1).close > candles.at(-2).close) {
    return { name: "Marubozu Trend Continuation", confidence: 0.55 };
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

function detectBreakoutAboveResistance(candles) {
  if (candles.length < 6) return null;
  const prevHigh = highest(candles.slice(-6, -1), 5);
  const last = candles.at(-1);
  const avgVol = avg(candles.slice(-6, -1).map((c) => c.volume || 0));
  if (last.close > prevHigh && last.volume > avgVol) {
    return { name: "Breakout above Resistance", confidence: 0.6 };
  }
  return null;
}

function detectBreakdownBelowSupport(candles) {
  if (candles.length < 6) return null;
  const prevLow = lowest(candles.slice(-6, -1), 5);
  const last = candles.at(-1);
  const avgVol = avg(candles.slice(-6, -1).map((c) => c.volume || 0));
  if (last.close < prevLow && last.volume > avgVol) {
    return { name: "Breakdown below Support", confidence: 0.6 };
  }
  return null;
}

function detectFlatTopBreakout(candles) {
  if (candles.length < 4) return null;
  const last4 = candles.slice(-4);
  const highs = last4.map((c) => c.high);
  const lows = last4.map((c) => c.low);
  const flat = Math.max(...highs.slice(0, 3)) - Math.min(...highs.slice(0, 3)) <
    (highs[3] - lows[3]) * 0.1;
  const risingLows = lows[1] > lows[0] && lows[2] > lows[1];
  if (flat && risingLows && last4.at(-1).close > Math.max(...highs.slice(0, 3))) {
    return { name: "Flat Top Breakout", confidence: 0.55 };
  }
  return null;
}

function detectFlatBottomBreakdown(candles) {
  if (candles.length < 4) return null;
  const last4 = candles.slice(-4);
  const highs = last4.map((c) => c.high);
  const lows = last4.map((c) => c.low);
  const flat = Math.max(...lows.slice(0, 3)) - Math.min(...lows.slice(0, 3)) <
    (highs[3] - lows[3]) * 0.1;
  const fallingHighs = highs[1] < highs[0] && highs[2] < highs[1];
  if (flat && fallingHighs && last4.at(-1).close < Math.min(...lows.slice(0, 3))) {
    return { name: "Flat Bottom Breakdown", confidence: 0.55 };
  }
  return null;
}

function detectFalseBreakoutTrap(candles) {
  if (candles.length < 3) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const recentHigh = highest(candles.slice(-5, -2), 3);
  const recentLow = lowest(candles.slice(-5, -2), 3);
  if (prev.close > recentHigh && last.close < recentHigh) {
    return { name: "False Breakout (Trap)", confidence: 0.55 };
  }
  if (prev.close < recentLow && last.close > recentLow) {
    return { name: "False Breakout (Trap)", confidence: 0.55 };
  }
  return null;
}

function detectGapUpBreakout(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  if (gap > 0.015 && last.close > last.open) {
    return { name: "Gap Up Breakout", confidence: 0.55 };
  }
  return null;
}

function detectGapDownBreakdown(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  if (gap < -0.015 && last.close < last.open) {
    return { name: "Gap Down Breakdown", confidence: 0.55 };
  }
  return null;
}

function detectPrebreakoutConsolidation(candles) {
  if (candles.length < 8) return null;
  const base = candles.slice(-5);
  const range = Math.max(...base.map((c) => c.high)) - Math.min(...base.map((c) => c.low));
  const priorUp = candles.slice(-8, -5).every((c) => c.close >= c.open);
  if (priorUp && range / Math.max(...base.map((c) => c.high)) < 0.02) {
    return { name: "Pre-breakout Consolidation", confidence: 0.55 };
  }
  return null;
}

function detectCupHandleBreakout(candles, ctx = {}) {
  const cleanCandles = sanitizeCandles(candles);
  if (cleanCandles.length < 5) return null;
  const atrCandidate = ctx.atr;
  const atr =
    Number.isFinite(atrCandidate) && atrCandidate > 0
      ? atrCandidate
      : getATR(cleanCandles, 14) || 0;
  const patterns = detectAllPatterns(cleanCandles, atr, 5);
  const cup = patterns.find((p) => p.type === "Cup & Handle");
  if (cup) {
    return { name: "Cup & Handle Breakout", confidence: 0.6 };
  }
  return null;
}

function detectGapUpBullishMarubozu(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  const body = last.high - last.low;
  const bullishMarubozu =
    last.close > last.open &&
    Math.abs(last.open - last.low) <= body * 0.1 &&
    Math.abs(last.high - last.close) <= body * 0.1;
  if (gap > 0.015 && bullishMarubozu) {
    return { name: "Gap Up + Bullish Marubozu", confidence: 0.6 };
  }
  return null;
}

function detectGapUpDoji(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  const doji = Math.abs(last.open - last.close) <= (last.high - last.low) * 0.1;
  if (gap > 0.015 && doji) {
    return { name: "Gap Up + Doji", confidence: 0.55 };
  }
  return null;
}

function detectGapUpBullishEngulfing(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  const bullishEngulf =
    last.close > last.open &&
    prev.close < prev.open &&
    last.open <= prev.close &&
    last.close >= prev.open;
  if (gap > 0.015 && bullishEngulf) {
    return { name: "Gap Up + Bullish Engulfing", confidence: 0.6 };
  }
  return null;
}

function detectGapUpInsideBarRetest(candles) {
  if (candles.length < 3) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (prev.open - candles.at(-3).close) / candles.at(-3).close;
  const inside = last.high <= prev.high && last.low >= prev.low;
  const retest = Math.abs(last.low - prev.high) / prev.high < 0.005;
  if (gap > 0.015 && inside && retest) {
    return { name: "Gap Up + Inside Bar Retest", confidence: 0.55 };
  }
  return null;
}

function detectGapUpContinuation(candles) {
  if (candles.length < 3) return null;
  const first = candles.at(-3);
  const second = candles.at(-2);
  const last = candles.at(-1);
  const gap = (second.open - first.close) / first.close;
  if (gap > 0.015 && second.close > second.open && last.close > second.close) {
    return { name: "Gap Up + Continuation", confidence: 0.55 };
  }
  return null;
}

function detectBreakawayGapBullish(candles) {
  if (candles.length < 5) return null;
  const baseHigh = Math.max(...candles.slice(-5, -1).map((c) => c.high));
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  if (gap > 0.02 && last.open > baseHigh) {
    return { name: "Breakaway Gap (Bullish)", confidence: 0.6 };
  }
  return null;
}

function detectRunawayGap(candles) {
  if (candles.length < 4) return null;
  const prevGap = (candles.at(-3).open - candles.at(-4).close) / candles.at(-4).close;
  const newGap = (candles.at(-1).open - candles.at(-2).close) / candles.at(-2).close;
  if (prevGap > 0.015 && newGap > 0.015 && candles.at(-1).close > candles.at(-2).close) {
    return { name: "Runaway Gap", confidence: 0.55 };
  }
  return null;
}

function detectGapUpPullbackBounce(candles) {
  if (candles.length < 3) return null;
  const first = candles.at(-3);
  const pull = candles.at(-2);
  const last = candles.at(-1);
  const gap = (first.open - candles.at(-4)?.close) / (candles.at(-4)?.close || first.open);
  if (gap > 0.015 && pull.close < pull.open && last.close > pull.high) {
    return { name: "Gap Up + Pullback + Bounce", confidence: 0.55 };
  }
  return null;
}

function detectGapUpHighVolume(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  const avgVol = avg(candles.slice(-6, -1).map((c) => c.volume || 0));
  if (gap > 0.015 && last.volume > avgVol * 1.5) {
    return { name: "Gap Up + High Volume Confirmation", confidence: 0.55 };
  }
  return null;
}

function detectGapUpRsiMacdBullish(candles, ctx = {}) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  const { features = computeFeatures(candles) } = ctx;
  const rsiOk = features?.rsi > 50;
  const macdOk = features?.macd?.histogram > 0;
  if (gap > 0.015 && rsiOk && macdOk) {
    return { name: "Gap Up + RSI/MACD Bullish Divergence", confidence: 0.55 };
  }
  return null;
}

function detectGapUpSupportHold(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  const hold = last.low <= prev.high && last.close > last.open;
  if (gap > 0.015 && hold) {
    return { name: "Gap Up + Support Zone Hold", confidence: 0.55 };
  }
  return null;
}

function detectGapUpTrendlineBreakout(candles) {
  if (candles.length < 4) return null;
  const prevHighs = candles.slice(-4, -1).map((c) => c.high);
  const descending = prevHighs.every((v, i, arr) => i === 0 || v < arr[i - 1]);
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  if (descending && gap > 0.015 && last.close > prev.high) {
    return { name: "Gap Up + Trendline Breakout", confidence: 0.55 };
  }
  return null;
}

function detectGapUpCupHandleBreakout(candles) {
  const cup = detectCupHandleBreakout(candles);
  if (!cup) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  if (gap > 0.015) {
    return { name: "Gap Up + Cup and Handle Breakout", confidence: 0.6 };
  }
  return null;
}

function detectGapUpRetestGapZone(candles) {
  if (candles.length < 3) return null;
  const gapOpen = candles.at(-3).open;
  const gapPrevClose = candles.at(-4)?.close || gapOpen;
  const gap = (gapOpen - gapPrevClose) / gapPrevClose;
  const pull = candles.at(-2);
  const last = candles.at(-1);
  const retest = pull.low <= gapOpen && pull.low >= gapPrevClose;
  if (gap > 0.015 && retest && last.close > pull.close) {
    return { name: "Gap Up + Retest of Gap Zone", confidence: 0.55 };
  }
  return null;
}

function detectGapDownBearishMarubozu(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  const body = last.high - last.low;
  const bearishMarubozu =
    last.close < last.open &&
    Math.abs(last.open - last.high) <= body * 0.1 &&
    Math.abs(last.low - last.close) <= body * 0.1;
  if (gap < -0.015 && bearishMarubozu) {
    return { name: "Gap Down + Bearish Marubozu", confidence: 0.6 };
  }
  return null;
}

function detectGapDownDoji(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  const doji = Math.abs(last.open - last.close) <= (last.high - last.low) * 0.1;
  if (gap < -0.015 && doji) {
    return { name: "Gap Down + Doji", confidence: 0.55 };
  }
  return null;
}

function detectGapDownBearishEngulfing(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  const bearishEngulf =
    last.close < last.open &&
    prev.close > prev.open &&
    last.open >= prev.close &&
    last.close <= prev.open;
  if (gap < -0.015 && bearishEngulf) {
    return { name: "Gap Down + Bearish Engulfing", confidence: 0.6 };
  }
  return null;
}

function detectGapDownInsideBarBreakdown(candles) {
  if (candles.length < 3) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (prev.open - candles.at(-3).close) / candles.at(-3).close;
  const inside = last.high <= prev.high && last.low >= prev.low;
  const retest = Math.abs(last.high - prev.low) / prev.low < 0.005;
  if (gap < -0.015 && inside && retest && last.close < last.open) {
    return { name: "Gap Down + Inside Bar Breakdown", confidence: 0.55 };
  }
  return null;
}

function detectGapDownContinuation(candles) {
  if (candles.length < 3) return null;
  const first = candles.at(-3);
  const second = candles.at(-2);
  const last = candles.at(-1);
  const gap = (second.open - first.close) / first.close;
  if (gap < -0.015 && second.close < second.open && last.close < second.close) {
    return { name: "Gap Down + Continuation", confidence: 0.55 };
  }
  return null;
}

function detectBreakawayGapBearish(candles) {
  if (candles.length < 5) return null;
  const baseLow = Math.min(...candles.slice(-5, -1).map((c) => c.low));
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  if (gap < -0.02 && last.open < baseLow) {
    return { name: "Breakaway Gap (Bearish)", confidence: 0.6 };
  }
  return null;
}

function detectExhaustionGap(candles) {
  if (candles.length < 3) return null;
  const before = candles.at(-3);
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (prev.open - before.close) / before.close;
  if (gap < -0.015 && prev.close < prev.open && last.close > prev.close) {
    return { name: "Exhaustion Gap", confidence: 0.55 };
  }
  return null;
}

function detectGapDownRetestBreakdown(candles) {
  if (candles.length < 3) return null;
  const before = candles.at(-3);
  const gapCandle = candles.at(-2);
  const last = candles.at(-1);
  const gap = (gapCandle.open - before.close) / before.close;
  const retest = last.high >= gapCandle.open;
  if (gap < -0.015 && retest && last.close < gapCandle.low) {
    return { name: "Gap Down + Retest + Breakdown", confidence: 0.55 };
  }
  return null;
}

function detectGapDownHighVolume(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  const avgVol = avg(candles.slice(-6, -1).map((c) => c.volume || 0));
  if (gap < -0.015 && last.volume > avgVol * 1.5) {
    return { name: "Gap Down + High Volume Confirmation", confidence: 0.55 };
  }
  return null;
}

function detectGapDownRsiMacdBearish(candles, ctx = {}) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  const { features = computeFeatures(candles) } = ctx;
  const rsiOk = features?.rsi < 50;
  const macdOk = features?.macd?.histogram < 0;
  if (gap < -0.015 && rsiOk && macdOk) {
    return { name: "Gap Down + RSI/MACD Bearish Divergence", confidence: 0.55 };
  }
  return null;
}

function detectGapDownResistanceHold(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  const hold = last.high >= prev.low && last.close < last.open;
  if (gap < -0.015 && hold) {
    return { name: "Gap Down + Resistance Zone Hold", confidence: 0.55 };
  }
  return null;
}

function detectGapDownTrendlineBreakdown(candles) {
  if (candles.length < 4) return null;
  const prevLows = candles.slice(-4, -1).map((c) => c.low);
  const ascending = prevLows.every((v, i, arr) => i === 0 || v > arr[i - 1]);
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  if (ascending && gap < -0.015 && last.close < prev.low) {
    return { name: "Gap Down + Trendline Breakdown", confidence: 0.55 };
  }
  return null;
}

function detectGapDownHeadShouldersBreakdown(candles) {
  if (candles.length < 4) return null;
  const left = candles.at(-4);
  const head = candles.at(-3);
  const right = candles.at(-2);
  const last = candles.at(-1);
  const isHs =
    head.high > left.high &&
    head.high > right.high &&
    Math.abs(left.high - right.high) / head.high < 0.05;
  const neckline = Math.min(left.low, right.low);
  const gap = (last.open - right.close) / right.close;
  if (isHs && gap < -0.015 && last.close < neckline) {
    return { name: "Gap Down + Head and Shoulders Breakdown", confidence: 0.6 };
  }
  return null;
}

function detectGapDownRetestGapZone(candles) {
  if (candles.length < 3) return null;
  const gapOpen = candles.at(-3).open;
  const gapPrevClose = candles.at(-4)?.close || gapOpen;
  const gap = (gapOpen - gapPrevClose) / gapPrevClose;
  const pull = candles.at(-2);
  const last = candles.at(-1);
  const retest = pull.high >= gapOpen && pull.high <= gapPrevClose;
  if (gap < -0.015 && retest && last.close < pull.close) {
    return { name: "Gap Down + Retest of Gap Zone", confidence: 0.55 };
  }
  return null;
}

function detectGapFillReversal(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  if (gap > 0.015 && last.close < prev.close) {
    return { name: "Gap Fill Reversal (Bearish)", confidence: 0.55 };
  }
  if (gap < -0.015 && last.close > prev.close) {
    return { name: "Gap Fill Reversal (Bullish)", confidence: 0.55 };
  }
  return null;
}

function detectIslandReversalTop(candles) {
  if (candles.length < 3) return null;
  const [a, b, c] = candles.slice(-3);
  if (b.low > a.high && c.high < b.low) {
    return { name: "Island Reversal Top", confidence: 0.55 };
  }
  return null;
}

function detectIslandReversalBottom(candles) {
  if (candles.length < 3) return null;
  const [a, b, c] = candles.slice(-3);
  if (b.high < a.low && c.low > b.high) {
    return { name: "Island Reversal Bottom", confidence: 0.55 };
  }
  return null;
}

function detectBullTrapAfterGapUp(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  if (
    gap > 0.015 &&
    last.high > prev.high &&
    last.close < prev.high &&
    last.close < last.open
  ) {
    return { name: "Bull Trap After Gap Up", confidence: 0.55 };
  }
  return null;
}

function detectBearTrapAfterGapDown(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  if (
    gap < -0.015 &&
    last.low < prev.low &&
    last.close > prev.low &&
    last.close > last.open
  ) {
    return { name: "Bear Trap After Gap Down", confidence: 0.55 };
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
    last.high - last.low > (prev.high - prev.low) * 1.5 &&
    last.close < prev.close
  ) {
    return { name: "Event Volatility Trap + Spike Fade", confidence: 0.55 };
  }
  return null;
}

function detectOpeningRangeReversal(candles) {
  const opening = candles.filter((c) =>
    typeof c.timestamp === 'number' && inIstRange(c.timestamp, MARKET_OPEN, MARKET_OPEN + 30)
  );
  if (!opening.length) return null;
  const rangeHigh = Math.max(...opening.map((c) => c.high));
  const rangeLow = Math.min(...opening.map((c) => c.low));
  const last = candles.at(-1);
  if (typeof last.timestamp !== 'number') return null;
  const m = istMinutes(last.timestamp);
  if (m >= MARKET_OPEN + 30 && last.high > rangeHigh && last.close < rangeHigh) {
    return { name: "Opening Range Reversal (ORR)", confidence: 0.55 };
  }
  if (m >= MARKET_OPEN + 30 && last.low < rangeLow && last.close > rangeLow) {
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

function detectDeltaDivergence(candles, ctx = {}) {
  if (!ctx.hasOrderFlowDelta || candles.length < 3) return null;
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

function detectTtmSqueezeBreakout(candles, ctx = {}) {
  const { features = computeFeatures(candles) } = ctx;
  const squeeze = features?.ttmSqueeze;
  const hist = features?.macdHist;
  if (squeeze && !squeeze.squeezeOn && hist > 0) {
    return { name: "TTM Squeeze Breakout", confidence: 0.6 };
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
  detectAtrRangeExpansion,
  detectMarubozuContinuation,
  detectRsiRangeShift,
  detectGapFill,
  detectVcp,
  detectBreakoutAboveResistance,
  detectBreakdownBelowSupport,
  detectFlatTopBreakout,
  detectFlatBottomBreakdown,
  detectFalseBreakoutTrap,
  detectGapUpBreakout,
  detectGapDownBreakdown,
  detectPrebreakoutConsolidation,
  detectCupHandleBreakout,
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
  detectTtmSqueezeBreakout,
  detectGapUpBullishMarubozu,
  detectGapUpDoji,
  detectGapUpBullishEngulfing,
  detectGapUpInsideBarRetest,
  detectGapUpContinuation,
  detectBreakawayGapBullish,
  detectRunawayGap,
  detectGapUpPullbackBounce,
  detectGapUpHighVolume,
  detectGapUpRsiMacdBullish,
  detectGapUpSupportHold,
  detectGapUpTrendlineBreakout,
  detectGapUpCupHandleBreakout,
  detectGapUpRetestGapZone,
  detectGapDownBearishMarubozu,
  detectGapDownDoji,
  detectGapDownBearishEngulfing,
  detectGapDownInsideBarBreakdown,
  detectGapDownContinuation,
  detectBreakawayGapBearish,
  detectExhaustionGap,
  detectGapDownRetestBreakdown,
  detectGapDownHighVolume,
  detectGapDownRsiMacdBearish,
  detectGapDownResistanceHold,
  detectGapDownTrendlineBreakdown,
  detectGapDownHeadShouldersBreakdown,
  detectGapDownRetestGapZone,
  detectGapFillReversal,
  detectIslandReversalTop,
  detectIslandReversalBottom,
  detectAnchoredVwapBreakout,
  detectGapEngulfingConfluence,
  detectBullTrapAfterGapUp,
  detectBearTrapAfterGapDown,
];

function computeTrendAlignment(direction, features = {}) {
  const { ema9, ema21, ema50, ema200 } = features;
  if ([ema9, ema21, ema50, ema200].every((n) => typeof n === "number")) {
    const up = ema9 > ema21 && ema21 > ema50 && ema50 > ema200;
    const down = ema9 < ema21 && ema21 < ema50 && ema50 < ema200;
    if (direction === "Long") return up ? 1 : down ? 0 : 0.5;
    if (direction === "Short") return down ? 1 : up ? 0 : 0.5;
  }
  return 0.5;
}

function mapRvolScore(rvol) {
  return typeof rvol === "number" ? Math.min(Math.max(rvol, 0) / 2, 1) : 0.5;
}

function computeRiskQuality(entry, stopLoss, atr) {
  if (!entry || !stopLoss || !atr) return 0.5;
  const risk = Math.abs(entry - stopLoss);
  const ratio = risk / atr;
  return Math.max(0, Math.min(1 - Math.min(ratio, 2) / 2, 1));
}

function computeRegimeFit(type = "", regime) {
  if (!regime) return 0.7;
  const t = type.toLowerCase();
  if (regime === "high") {
    if (t.includes("breakout") || t.includes("momentum")) return 1;
    if (t.includes("mean") || t.includes("reversion")) return 0.3;
    return 0.6;
  }
  if (regime === "low") {
    if (t.includes("mean") || t.includes("reversion")) return 1;
    if (t.includes("breakout") || t.includes("momentum")) return 0.3;
    return 0.6;
  }
  return 0.7;
}

function computeTimeOfDayScore(ts) {
  if (typeof ts !== "number") return 0.8;
  const m = istMinutes(ts);
  if (m >= MARKET_OPEN + 15 && m <= MARKET_OPEN + 90) return 1;
  if (m <= MARKET_CLOSE - 60 && m > MARKET_OPEN + 90) return 0.8;
  return 0.6;
}

function computeDetectorScore(raw, candles, features, context, entry, stopLoss, atr, config) {
  const patternQuality = raw.patternQuality ?? raw.meta?.patternQuality ?? 0.5;
  const trendAlign = computeTrendAlignment(raw.direction || "Long", features);
  const rvolScore = mapRvolScore(context.rvol ?? features.rvol);
  const riskQuality = computeRiskQuality(entry, stopLoss, atr);
  const regimeFit = computeRegimeFit(raw.type || raw.name, context.regime);
  const todScore = computeTimeOfDayScore(candles.at(-1)?.timestamp);
  const rsScore = typeof (context.rsScore ?? features.rsScore) === "number"
    ? Math.max(0, Math.min(context.rsScore ?? features.rsScore, 1))
    : 0.5;

  let base =
    patternQuality * 0.2 +
    trendAlign * 0.15 +
    rvolScore * 0.15 +
    riskQuality * 0.15 +
    regimeFit * 0.15 +
    todScore * 0.1 +
    rsScore * 0.1;

  let penalty = 0;
  if (context.spreadPct && context.spreadPct > config.maxSpreadPct) penalty += 0.1;
  if (context.newsImpact || context.badNews) penalty += 0.2;
  if (raw.meta?.missingRetest) penalty += 0.05;
  const rsi = features.rsi14 ?? features.rsi;
  if (typeof rsi === "number" && (rsi > config.rsiExhaustion || rsi < config.rsiOS)) penalty += 0.05;
  return Math.max(0, Math.min(base - penalty, 1));
}

function normalizeResult(
  raw,
  candles,
  features = {},
  atr,
  context = {},
  config = DEFAULT_CONFIG
) {
  if (!raw || typeof raw !== "object") return null;
  const closes = features.closes || candles.map(c => c.close);
  const price = raw.entry ?? closes.at(-1);
  const dir = raw.direction || "Long";
  const usedAtr = Math.min(
    atr || 0,
    (context.avgAtr || atr || 0) * config.riskAtrMaxMultiple
  );
  const entry = price;
  const stopLoss =
    raw.stopLoss !== undefined
      ? raw.stopLoss
      : dir === "Long"
      ? entry - usedAtr * config.slAtrMultiple
      : entry + usedAtr * config.slAtrMultiple;
  const targets =
    raw.targets ||
    config.targetAtrMultiples.reduce((acc, m, i) => {
      acc[`T${i + 1}`] =
        dir === "Long" ? entry + usedAtr * m : entry - usedAtr * m;
      return acc;
    }, {});
  const confidence = raw.confidence ?? 0.5;
  const score =
    raw.score ??
    computeDetectorScore(
      raw,
      candles,
      features,
      context,
      entry,
      stopLoss,
      usedAtr,
      config
    );
  const meta = {
    atr: usedAtr,
    rvol: context.rvol,
    preMarketRange: context.preMarketRange,
    openRange: context.openRange,
    ...(raw.meta || {}),
    ...(context.meta || {}),
  };
  return {
    name: raw.name,
    type: raw.type || "Event",
    direction: dir,
    entry,
    stopLoss,
    targets,
    confidence,
    score,
    meta,
    refs: raw.refs || {},
  };
}

export function evaluateStrategies(
  candles,
  context = {},
  options = { topN: 1, filters: null, config: DEFAULT_CONFIG }
) {
  if (!Array.isArray(candles) || candles.length < 5) return [];
  let cfg = { ...(options.config || DEFAULT_CONFIG) };
  if (context.isRestricted) return [];
  const isEvent = context.isEventDay || context.isWeeklyExpiry;
  if (context.rvol) {
    if (
      isEvent &&
      context.rvol < cfg.rvolMin * (cfg.eventRvolMultiplier || 1)
    )
      return [];
    if (!isEvent && context.rvol < cfg.rvolMin) return [];
  }
  if (context.spreadPct && context.spreadPct > cfg.maxSpreadPct) return [];
  if (context.avgVolume && context.avgVolume < cfg.minAvgVolume) return [];
  if (isEvent) {
    cfg = {
      ...cfg,
      slAtrMultiple: cfg.slAtrMultiple * (cfg.eventSlAtrMultiplier || 1),
    };
  }
  const lastTs = candles.at(-1)?.timestamp;
  if (typeof lastTs === "number") {
    const m = istMinutes(lastTs);
    if (m < MARKET_OPEN) {
      if (!cfg.allowPreOpenEntries) return [];
    } else if (
      m < MARKET_OPEN + cfg.noTradeOpenMins ||
      m > MARKET_CLOSE - cfg.noTradeCloseMins
    ) {
      return [];
    }
  }
  const preRange = rangeBetween(candles, PREOPEN_START, PREOPEN_END);
  const openRange = rangeBetween(
    candles,
    MARKET_OPEN,
    MARKET_OPEN + cfg.openRangeMins
  );
  const computedFeatures = computeFeatures(candles) || {};
  const atrCandidate =
    options?.atr ??
    context?.atr ??
    computedFeatures?.atr ??
    computedFeatures?.atr14;
  const atr =
    Number.isFinite(atrCandidate) && atrCandidate > 0
      ? atrCandidate
      : getATR(candles, 14) || 0;
  const features = { ...computedFeatures, atr };
  const ctx = { ...context, atr };
  if (preRange) ctx.preMarketRange = preRange;
  if (openRange) ctx.openRange = openRange;
  if (typeof features.zScore === "number") {
    const bins = cfg.regimeAtrZScoreBins || {};
    ctx.regime =
      features.zScore <= bins.low
        ? "low"
        : features.zScore >= bins.high
        ? "high"
        : "normal";
  }
  let results = DETECTORS.map((fn) => fn(candles, { ...ctx, features }, cfg))
    .filter(Boolean)
    .map((r) =>
      normalizeResult(
        { ...(STRATEGY_CATALOG[r.name] || {}), ...r },
        candles,
        features,
        atr,
        ctx,
        cfg
      )
    );
  if (options.filters) {
    results = applyFilters(results, ctx, options.filters);
  }
  const merged = {};
  for (const r of results) {
    const key = r.name;
    if (merged[key]) {
      merged[key].confidence = Math.max(merged[key].confidence, r.confidence);
      merged[key].score = Math.max(merged[key].score, r.score);
      merged[key].meta = { ...merged[key].meta, ...r.meta };
      merged[key].refs = { ...merged[key].refs, ...r.refs };
    } else {
      merged[key] = { ...r };
    }
  }
  const deduped = Object.values(merged);
  deduped.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return deduped;
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
  {
    name: "Gap Fill Reversal (Bearish)",
    rules: ["Gap up fades and closes below prior close"],
  },
  {
    name: "Gap Fill Reversal (Bullish)",
    rules: ["Gap down fills and closes above prior close"],
  },
  {
    name: "Island Reversal Top",
    rules: ["Gap up followed by gap down creating an island"],
  },
  {
    name: "Island Reversal Bottom",
    rules: ["Gap down followed by gap up creating an island"],
  },
  {
    name: "Bull Trap After Gap Up",
    rules: ["Gap up above prior high then reverses lower"],
  },
  {
    name: "Bear Trap After Gap Down",
    rules: ["Gap down below prior low then reverses higher"],
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
  {
    name: "TTM Squeeze Breakout",
    rules: [
      "Squeeze condition off and MACD histogram turns positive",
      "Enter on strong candle close beyond consolidation",
    ],
  },
  {
    name: "Breakout above Resistance",
    rules: [
      "Price closes above recent resistance level",
      "Volume expands on breakout",
    ],
  },
  {
    name: "Breakdown below Support",
    rules: [
      "Price closes below recent support level",
      "Volume expands on breakdown",
    ],
  },
  {
    name: "Flat Top Breakout",
    rules: [
      "Equal highs with rising lows",
      "Breakout candle closes above resistance",
    ],
  },
  {
    name: "Flat Bottom Breakdown",
    rules: [
      "Equal lows with falling highs",
      "Breakdown candle closes below support",
    ],
  },
  {
    name: "False Breakout (Trap)",
    rules: [
      "Breaks key level but immediately reverses",
      "Next candle closes back inside range",
    ],
  },
  {
    name: "Gap Up Breakout",
    rules: [
      "Opens above prior close by >1.5%",
      "Closes strong after the gap",
    ],
  },
  {
    name: "Gap Down Breakdown",
    rules: [
      "Opens below prior close by >1.5%",
      "Continues lower after the gap",
    ],
  },
  {
    name: "Pre-breakout Consolidation",
    rules: [
      "Tight range after small uptrend",
      "Look for expansion breakout",
    ],
  },
  {
    name: "Cup & Handle Breakout",
    rules: [
      "Cup & Handle pattern forms",
      "Breakout of handle high with volume",
    ],
  },
  {
    name: "Gap Up + Bullish Marubozu",
    rules: ["Gap up above prior close", "Bullish Marubozu candle"],
  },
  {
    name: "Gap Up + Doji",
    rules: ["Gap up open", "Doji candle indicates indecision"],
  },
  {
    name: "Gap Up + Bullish Engulfing",
    rules: ["Gap up", "Bullish engulfing of prior candle"],
  },
  {
    name: "Gap + Engulfing (Confluence)",
    rules: [
      "Gap open aligns with engulfing candle in same direction",
    ],
  },
  {
    name: "Gap Up + Inside Bar Retest",
    rules: ["Gap up then inside bar retests prior high"],
  },
  {
    name: "Gap Up + Continuation",
    rules: ["Gap up followed by bullish continuation"],
  },
  {
    name: "Breakaway Gap (Bullish)",
    rules: ["Large gap above consolidation"],
  },
  {
    name: "Runaway Gap",
    rules: ["Second gap during strong trend"],
  },
  {
    name: "Gap Up + Pullback + Bounce",
    rules: ["Gap up", "Pullback candle", "Next candle bounces"],
  },
  {
    name: "Gap Up + High Volume Confirmation",
    rules: ["Gap up with volume >1.5x average"],
  },
  {
    name: "Gap Up + RSI/MACD Bullish Divergence",
    rules: ["Gap up", "RSI > 50", "MACD histogram positive"],
  },
  {
    name: "Gap Up + Support Zone Hold",
    rules: ["Gap holds above prior resistance"],
  },
  {
    name: "Gap Up + Trendline Breakout",
    rules: ["Gap up breaks descending trendline"],
  },
  {
    name: "Gap Up + Cup and Handle Breakout",
    rules: ["Gap up coincides with Cup & Handle breakout"],
  },
  {
    name: "Gap Up + Retest of Gap Zone",
    rules: ["Gap up", "Pullback retests gap zone", "Bounce"],
  },
  {
    name: "Gap Down + Bearish Marubozu",
    rules: ["Gap down", "Bearish Marubozu candle"],
  },
  {
    name: "Gap Down + Doji",
    rules: ["Gap down open", "Doji candle"],
  },
  {
    name: "Gap Down + Bearish Engulfing",
    rules: ["Gap down", "Bearish engulfing of prior candle"],
  },
  {
    name: "Gap Down + Inside Bar Breakdown",
    rules: ["Gap down then inside bar breaks lower"],
  },
  {
    name: "Gap Down + Continuation",
    rules: ["Gap down followed by bearish continuation"],
  },
  {
    name: "Breakaway Gap (Bearish)",
    rules: ["Large gap below consolidation"],
  },
  {
    name: "Exhaustion Gap",
    rules: ["Gap down then immediate bullish reversal"],
  },
  {
    name: "Gap Down + Retest + Breakdown",
    rules: ["Gap down", "Retest gap", "Next candle breaks lower"],
  },
  {
    name: "Gap Down + High Volume Confirmation",
    rules: ["Gap down with volume >1.5x average"],
  },
  {
    name: "Gap Down + RSI/MACD Bearish Divergence",
    rules: ["Gap down", "RSI < 50", "MACD histogram negative"],
  },
  {
    name: "Gap Down + Resistance Zone Hold",
    rules: ["Gap holds below prior support"],
  },
  {
    name: "Gap Down + Trendline Breakdown",
    rules: ["Gap down breaks ascending trendline"],
  },
  {
    name: "Gap Down + Head and Shoulders Breakdown",
    rules: ["H&S pattern", "Gap down below neckline"],
  },
  {
    name: "Gap Down + Retest of Gap Zone",
    rules: ["Gap down", "Pullback retests gap zone", "Fall"],
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
    name: "ATR Range Expansion",
    rules: [
      "Current candle range exceeds previous ATR",
      "Signals potential trend strength after volatility expansion",
    ],
    notes: "Adds strength filter to reduce noise",
  },
  {
    name: "Marubozu Trend Continuation",
    rules: [
      "Three or more bullish candles with no lower wick",
      "Enter on break of the next candle high",
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

function detectAnchoredVwapBreakout(candles) {
  if (candles.length < 50) return null;
  const closes = candles.map(c => c.close);
  const ema200 = calculateEMA(closes, 200);
  const anchored = calculateAnchoredVWAP(candles);
  const last = candles.at(-1);
  const prev = candles.at(-2);
  if (
    anchored &&
    last.close > anchored &&
    prev.close <= anchored &&
    Math.abs(anchored - ema200) / ema200 < 0.01
  ) {
    return { name: 'Anchored VWAP Breakout', confidence: 0.6 };
  }
  return null;
}

function detectGapEngulfingConfluence(candles) {
  if (candles.length < 2) return null;
  const prev = candles.at(-2);
  const last = candles.at(-1);
  const gap = (last.open - prev.close) / prev.close;
  const engulfBull =
    last.close > last.open && prev.close < prev.open && last.open <= prev.close && last.close >= prev.open;
  const engulfBear =
    last.close < last.open && prev.close > prev.open && last.open >= prev.close && last.close <= prev.open;
  if ((gap > 0.01 && engulfBull) || (gap < -0.01 && engulfBear)) {
    return { name: 'Gap + Engulfing (Confluence)', confidence: 0.6 };
  }
  return null;
}
