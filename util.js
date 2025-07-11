// util.js
import { getMA } from "./kite.js"; // Reuse kite.js
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);
import {
  calculateEMA,
  calculateRSI,
  calculateSupertrend,
  calculateVWAP,
  getATR,
  calculateSMA,
  calculateWMA,
  calculateHMA,
  calculateDEMA,
  calculateTEMA,
  calculateMACD,
  calculateADX,
  calculateVortex,
  calculateIchimoku,
  calculateMAEnvelopes,
  calculateLinearRegression,
  calculateStochastic,
  calculateCCI,
  calculateROC,
  calculateMomentum,
  calculateWilliamsR,
  calculateTRIX,
  calculateUltimateOscillator,
  calculateCMO,
  calculateConnorsRSI,
  calculateForceIndex,
  calculateKlinger,
  calculateSTC,
  calculateTSI,
  calculateStdDev,
  calculateBollingerBands,
  calculateKeltnerChannels,
  calculateDonchianChannels,
  calculateChaikinVolatility,
  calculateHistoricalVolatility,
  calculateFractalChaosBands,
  calculateEnvelopes,
  resetIndicatorCache,
} from "./featureEngine.js";

export {
  calculateEMA,
  calculateRSI,
  calculateSupertrend,
  calculateVWAP,
  getATR,
  calculateSMA,
  calculateWMA,
  calculateHMA,
  calculateDEMA,
  calculateTEMA,
  calculateMACD,
  calculateADX,
  calculateVortex,
  calculateIchimoku,
  calculateMAEnvelopes,
  calculateLinearRegression,
  calculateStochastic,
  calculateCCI,
  calculateROC,
  calculateMomentum,
  calculateWilliamsR,
  calculateTRIX,
  calculateUltimateOscillator,
  calculateCMO,
  calculateConnorsRSI,
  calculateForceIndex,
  calculateKlinger,
  calculateSTC,
  calculateTSI,
  calculateStdDev,
  calculateBollingerBands,
  calculateKeltnerChannels,
  calculateDonchianChannels,
  calculateChaikinVolatility,
  calculateHistoricalVolatility,
  calculateFractalChaosBands,
  calculateEnvelopes,
  resetIndicatorCache,
};

export function calculateMA(prices, length) {
  if (prices.length < length) return null;
  const sum = prices.slice(-length).reduce((a, b) => a + b, 0);
  return sum / length;
}
// LIST OF PATTERN DETECTION FUNCTIONS
// These functions analyze candle data to detect various patterns.
// Calculate EMA with optional memoisation key. When a key is provided the
// function reuses the last computed EMA value for that key to avoid
// recalculating from the start of the array on every tick.

export function getMAForSymbol(symbol, period) {
  return getMA(symbol, period);
}

export function toISTISOString(date = new Date()) {
  return dayjs(date).tz("Asia/Kolkata").format();
}

export function toISTDate(date = new Date()) {
  return dayjs(date).tz("Asia/Kolkata").format("YYYY-MM-DD");
}

export function convertTickTimestampsToIST(tick = {}) {
  const t = { ...tick };
  if (t.last_trade_time) t.last_trade_time = toISTISOString(t.last_trade_time);
  if (t.exchange_timestamp)
    t.exchange_timestamp = toISTISOString(t.exchange_timestamp);
  return t;
}

export function analyzeHigherTimeframe(
  candles,
  emaLength = 50,
  atrLength = 14
) {
  if (!candles || candles.length < emaLength) return null;
  const closes = candles.map((c) => c.close);
  const ema = calculateEMA(closes, emaLength);
  const supertrend = calculateSupertrend(candles, atrLength);
  return { ema, supertrend };
}

export function debounceSignal(
  signalHistory,
  symbol,
  direction,
  strategy = "default",
  windowMs = 180000
) {
  const now = Date.now();
  const symHist = signalHistory[symbol] || {};
  const stratHist = symHist[strategy] || [];
  const conflicting = stratHist.find(
    (sig) => now - sig.timestamp < windowMs && sig.direction !== direction
  );
  if (conflicting) return false;
  symHist[strategy] = stratHist.filter((sig) => now - sig.timestamp < windowMs);
  symHist[strategy].push({ direction, timestamp: now });
  signalHistory[symbol] = symHist;
  return true;
}

export function calculateExpiryMinutes({ atr, rvol }) {
  const base = 5;
  const atrFactor = atr ? Math.min(Math.max(atr, 1), 4) : 1;
  const volumeFactor = rvol && rvol > 1 ? 1 + Math.min(rvol - 1, 1) : 1;
  return base * atrFactor * volumeFactor;
}

export function detectAllPatterns(candles, atrValue, lookback = 5) {
  const patterns = [];
  if (candles.length < lookback) return [];

  const last = candles[candles.length - 1];
  const lastN = candles.slice(-lookback);
  const highs = lastN.map((c) => c.high);
  const lows = lastN.map((c) => c.low);
  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  const epsilon = 0.1;
  const vwapPeriod = Math.min(candles.length, 20);
  const vwap = calculateVWAP(candles.slice(-vwapPeriod));
  const prevVWAP =
    candles.length > vwapPeriod
      ? calculateVWAP(candles.slice(-(vwapPeriod + 1), -1))
      : vwap;

  // --- Single Candle Reversal ---
  const isDoji =
    Math.abs(last.open - last.close) < (last.high - last.low) * 0.1;
  const isHammer =
    last.close > last.open &&
    last.open - last.low > 2 * (last.high - last.close);
  const isInvertedHammer =
    last.close > last.open &&
    last.high - last.close > 2 * (last.close - last.low);
  const isShootingStar =
    last.open > last.close &&
    last.high - last.open > 2 * (last.open - last.low);

  if (isDoji)
    patterns.push({
      type: "Doji",
      direction: "Indecision",
      strength: 1,
      confidence: "Medium",
    });
  if (isHammer)
    patterns.push({
      type: "Hammer",
      direction: "Long",
      strength: 2,
      confidence: "High",
    });
  if (isInvertedHammer)
    patterns.push({
      type: "Inverted Hammer",
      direction: "Long",
      strength: 2,
      confidence: "Medium",
    });
  if (isShootingStar)
    patterns.push({
      type: "Shooting Star",
      direction: "Short",
      strength: 2,
      confidence: "High",
    });

  // --- Multi-Candle Reversal ---
  if (candles.length >= 3) {
    const [c1, c2, c3] = candles.slice(-3);
    const morningStar =
      c1.close < c1.open && isDoji && c3.close > c3.open && c3.close > c1.open;
    const eveningStar =
      c1.close > c1.open && isDoji && c3.close < c3.open && c3.close < c1.open;

    const piercingLine =
      c1.close < c1.open &&
      c2.open < c1.low &&
      c2.close > (c1.open + c1.close) / 2;
    const darkCloudCover =
      c1.close > c1.open &&
      c2.open > c1.high &&
      c2.close < (c1.open + c1.close) / 2;

    if (morningStar)
      patterns.push({
        type: "Morning Star",
        direction: "Long",
        strength: 3,
        confidence: "High",
      });
    if (eveningStar)
      patterns.push({
        type: "Evening Star",
        direction: "Short",
        strength: 3,
        confidence: "High",
      });
    if (piercingLine)
      patterns.push({
        type: "Piercing Line",
        direction: "Long",
        strength: 2,
        confidence: "Medium",
      });
    if (darkCloudCover)
      patterns.push({
        type: "Dark Cloud Cover",
        direction: "Short",
        strength: 2,
        confidence: "Medium",
      });
  }

  // Harami
  const prev = candles[candles.length - 2];
  const haramiBullish =
    last.open > last.close && last.high < prev.high && last.low > prev.low;
  const haramiBearish =
    last.open < last.close && last.high < prev.high && last.low > prev.low;
  if (haramiBullish)
    patterns.push({
      type: "Bullish Harami",
      direction: "Long",
      strength: 2,
      confidence: "Medium",
    });
  if (haramiBearish)
    patterns.push({
      type: "Bearish Harami",
      direction: "Short",
      strength: 2,
      confidence: "Medium",
    });

  // Three Soldiers / Crows
  if (candles.length >= 4) {
    const [c1, c2, c3] = candles.slice(-4, -1);
    const threeSoldiers = [c1, c2, c3].every((c) => c.close > c.open);
    const threeCrows = [c1, c2, c3].every((c) => c.close < c.open);
    if (threeSoldiers)
      patterns.push({
        type: "Three White Soldiers",
        direction: "Long",
        strength: 3,
        confidence: "High",
      });
    if (threeCrows)
      patterns.push({
        type: "Three Black Crows",
        direction: "Short",
        strength: 3,
        confidence: "High",
      });
  }

  // --- Continuation Patterns ---
  if (candles.length >= 6) {
    const flagConsolidation = candles
      .slice(-3)
      .every((c) => Math.abs(c.close - c.open) < (c.high - c.low) * 0.5);
    const priorUp = candles.slice(-6, -3).every((c) => c.close > c.open);
    const priorDown = candles.slice(-6, -3).every((c) => c.close < c.open);

    if (priorUp && flagConsolidation && last.close > last.open) {
      patterns.push({
        type: "Bull Flag",
        direction: "Long",
        strength: 2,
        confidence: "Medium",
      });
    }
    if (priorDown && flagConsolidation && last.close < last.open) {
      patterns.push({
        type: "Bear Flag",
        direction: "Short",
        strength: 2,
        confidence: "Medium",
      });
    }
  }

  const isAscending = lows[1] > lows[0] && lows[2] > lows[1];
  const flatTop =
    Math.abs(highs[0] - highs[1]) < epsilon &&
    Math.abs(highs[1] - highs[2]) < epsilon;
  if (isAscending && flatTop) {
    patterns.push({
      type: "Ascending Triangle",
      direction: "Long",
      breakout: recentHigh,
      stopLoss: recentLow,
      strength: 3,
      confidence: "High",
    });
  }

  const isDescending = highs[1] < highs[0] && highs[2] < highs[1];
  const flatBottom =
    Math.abs(lows[0] - lows[1]) < epsilon &&
    Math.abs(lows[1] - lows[2]) < epsilon;
  if (isDescending && flatBottom) {
    patterns.push({
      type: "Descending Triangle",
      direction: "Short",
      breakout: recentLow,
      stopLoss: recentHigh,
      strength: 3,
      confidence: "High",
    });
  }

  const isCup = lastN[0].high > lastN[2].high && lastN[4].high > lastN[2].high;
  const isHandle = last.low > lastN[2].low && last.close > last.open;
  if (isCup && isHandle) {
    patterns.push({
      type: "Cup & Handle",
      direction: "Long",
      breakout: last.high,
      stopLoss: last.low,
      strength: 2,
      confidence: "High",
    });
  }

  const isFalling = lows[0] > lows[1] && lows[1] > lows[2];
  const isNarrowing = highs[0] - lows[0] > highs[2] - lows[2];
  if (isFalling && isNarrowing && last.close > last.open) {
    patterns.push({
      type: "Falling Wedge",
      direction: "Long",
      breakout: last.high,
      stopLoss: last.low,
      strength: 2,
      confidence: "High",
    });
  }

  const isRising =
    lows[0] < lows[1] &&
    lows[1] < lows[2] &&
    highs[0] < highs[1] &&
    highs[1] < highs[2];
  const isTightening = highs[2] - lows[2] < highs[0] - lows[0];
  if (isRising && isTightening && last.close < last.open) {
    patterns.push({
      type: "Rising Wedge",
      direction: "Short",
      breakout: last.low,
      stopLoss: last.high,
      strength: 2,
      confidence: "High",
    });
  }

  const len = lastN.length;
  const lowLast = lows[len - 1];
  const lowPrev = lows[len - 2];
  const lowPrev2 = lows[len - 3];
  const highLast = highs[len - 1];
  const highPrev = highs[len - 2];
  const highPrev2 = highs[len - 3];

  if (
    Math.abs(lowPrev2 - lowPrev) < epsilon &&
    Math.abs(lowPrev - lowLast) < epsilon
  ) {
    patterns.push({
      type: "Triple Bottom",
      direction: "Long",
      breakout: last.high,
      stopLoss: recentLow,
      strength: 3,
      confidence: "Medium",
    });
  }

  // Double Bottom
  if (Math.abs(lowPrev - lowLast) < epsilon && highPrev < highLast - epsilon) {
    patterns.push({
      type: "Double Bottom",
      direction: "Long",
      breakout: last.high,
      stopLoss: recentLow,
      strength: 2,
      confidence: "Medium",
    });
  }

  if (
    Math.abs(highPrev2 - highPrev) < epsilon &&
    Math.abs(highPrev - highLast) < epsilon
  ) {
    patterns.push({
      type: "Triple Top",
      direction: "Short",
      breakout: last.low,
      stopLoss: recentHigh,
      strength: 3,
      confidence: "Medium",
    });
  }

  // Double Top
  if (Math.abs(highPrev - highLast) < epsilon && lowPrev > lowLast + epsilon) {
    patterns.push({
      type: "Double Top",
      direction: "Short",
      breakout: last.low,
      stopLoss: recentHigh,
      strength: 2,
      confidence: "Medium",
    });
  }

  const isSymTriangle =
    Math.abs(highs[0] - highs[2]) > epsilon &&
    Math.abs(lows[0] - lows[2]) > epsilon &&
    highs[0] > highs[1] &&
    highs[1] > highs[2] &&
    lows[0] < lows[1] &&
    lows[1] < lows[2];

  if (isSymTriangle) {
    patterns.push({
      type: "Symmetrical Triangle",
      direction: "Neutral",
      breakout: last.close,
      stopLoss: recentLow,
      strength: 2,
      confidence: "Medium",
    });
  }

  // VWAP Reversal
  if (candles.length >= 2 && vwap) {
    const prevClose = candles[candles.length - 2].close;
    const crossUp = prevClose < prevVWAP && last.close > vwap;
    const crossDown = prevClose > prevVWAP && last.close < vwap;
    if (crossUp) {
      patterns.push({
        type: "VWAP Reversal",
        direction: "Long",
        breakout: last.high,
        stopLoss: last.low,
        strength: 2,
        confidence: "Medium",
      });
    } else if (crossDown) {
      patterns.push({
        type: "VWAP Reversal",
        direction: "Short",
        breakout: last.low,
        stopLoss: last.high,
        strength: 2,
        confidence: "Medium",
      });
    }
  }

  // --- Classic Patterns ---
  if (
    last.close > recentHigh &&
    atrValue &&
    Math.abs(last.close - recentLow) > atrValue * 0.5
  ) {
    patterns.push({
      type: "Breakout",
      direction: "Long",
      breakout: last.close,
      stopLoss: recentLow,
      strength: 3,
      confidence: "High",
    });
  }

  if (last.high < lastN[3].high && last.low > lastN[3].low) {
    patterns.push({
      type: "Inside Bar",
      direction: "Long",
      breakout: last.high,
      stopLoss: last.low,
      strength: 1,
      confidence: "Medium",
    });
  }

  if (
    last.high > lastN[3].high &&
    last.low < lastN[3].low &&
    last.close > lastN[3].close &&
    Math.abs(last.close - last.open) > atrValue * 0.3
  ) {
    patterns.push({
      type: "Engulfing Bullish",
      direction: "Long",
      breakout: last.close,
      stopLoss: last.low,
      strength: 2,
      confidence: "High",
    });
  }

  if (
    last.high > lastN[3].high &&
    last.low < lastN[3].low &&
    last.close < lastN[3].close &&
    Math.abs(last.open - last.close) > atrValue * 0.3
  ) {
    patterns.push({
      type: "Engulfing Bearish",
      direction: "Short",
      breakout: last.close,
      stopLoss: last.high,
      strength: 2,
      confidence: "High",
    });
  }

  if (candles.length >= 7) {
    const l = candles.length;
    const left = candles[l - 7].high;
    const head = candles[l - 4].high;
    const right = candles[l - 1].high;
    if (
      head > left &&
      head > right &&
      Math.abs(left - right) < (head - Math.min(left, right)) * 0.3 &&
      atrValue &&
      head - Math.min(left, right) > atrValue * 0.6
    ) {
      patterns.push({
        type: "Head & Shoulders",
        direction: "Short",
        breakout: candles[l - 1].low,
        stopLoss: head,
        strength: 3,
        confidence: "High",
      });
    }
  }

  if (candles.length >= 7) {
    const l = candles.length;
    const left = candles[l - 7].low;
    const head = candles[l - 4].low;
    const right = candles[l - 1].low;
    if (
      head < left &&
      head < right &&
      Math.abs(left - right) < (Math.max(left, right) - head) * 0.3 &&
      atrValue &&
      Math.max(left, right) - head > atrValue * 0.6
    ) {
      patterns.push({
        type: "Inverse Head & Shoulders",
        direction: "Long",
        breakout: candles[l - 1].high,
        stopLoss: head,
        strength: 3,
        confidence: "High",
      });
    }
  }

  return patterns;
}

export function confirmRetest(candles, breakout, direction = "Long") {
  if (!Array.isArray(candles) || candles.length < 2 || !breakout) return false;
  const test = candles[candles.length - 2];
  const confirm = candles[candles.length - 1];
  const thresh = breakout * 0.002;
  const touched =
    direction === "Long"
      ? test.low <= breakout + thresh && test.high >= breakout - thresh
      : test.high >= breakout - thresh && test.low <= breakout + thresh;
  if (!touched) return false;
  const volumeOk =
    typeof confirm.volume === "number" &&
    typeof test.volume === "number" &&
    confirm.volume >= test.volume;
  const wickPct =
    direction === "Long"
      ? (breakout - test.low) / Math.max(test.high - test.low, 1)
      : (test.high - breakout) / Math.max(test.high - test.low, 1);
  const wickOk = wickPct > 0.25;
  const body = Math.abs(confirm.close - confirm.open);
  const range = confirm.high - confirm.low || 1;
  const bodyOk = body > range * 0.5;
  const closeStrong =
    direction === "Long"
      ? confirm.close > confirm.open && confirm.close > breakout
      : confirm.close < confirm.open && confirm.close < breakout;
  return touched && closeStrong && (volumeOk || wickOk || bodyOk);
}
