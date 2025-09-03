// util.js
import { getMA } from "./kite.js"; // Reuse kite.js
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

// Default margin percentage used when broker margin or leverage is not supplied
export const DEFAULT_MARGIN_PERCENT = 0.2;
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
  calculateTTMSqueeze,
  calculateZScore,
  calculateElderImpulse,
  calculateDonchianWidth,
  calculateIchimokuBaseLine,
  calculateIchimokuConversionLine,
  calculateAnchoredMomentum,
  calculateATRBands,
  calculateDynamicStopLoss as calcDynamicStopLoss,
  calculateATRTrailingStop,
  calculateLaguerreRSI,
  calculateRSILaguerre,
  calculateTrendIntensityIndex,
  calculateBollingerPB,
  calculateMACDHistogram,
  calculateCoppockCurve,
  calculatePriceOscillator,
  calculateMcGinleyDynamic,
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
  calculateTTMSqueeze,
  calculateZScore,
  calculateElderImpulse,
  calculateDonchianWidth,
  calculateIchimokuBaseLine,
  calculateIchimokuConversionLine,
  calculateAnchoredMomentum,
  calculateATRBands,
  calcDynamicStopLoss,
  calculateATRTrailingStop,
  calculateLaguerreRSI,
  calculateRSILaguerre,
  calculateTrendIntensityIndex,
  calculateBollingerPB,
  calculateMACDHistogram,
  calculateCoppockCurve,
  calculatePriceOscillator,
  calculateMcGinleyDynamic,
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

export async function getMAForSymbol(symbol, period) {
  return await getMA(symbol, period);
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
  const bodySize = Math.abs(last.close - last.open);
  const isHangingMan =
    bodySize > 0 &&
    Math.min(last.open, last.close) - last.low > 2 * bodySize &&
    last.high - Math.max(last.open, last.close) <= bodySize * 0.3;

  const marubozuBullish =
    last.close > last.open &&
    Math.abs(last.open - last.low) < epsilon &&
    Math.abs(last.high - last.close) < epsilon;
  const marubozuBearish =
    last.close < last.open &&
    Math.abs(last.high - last.open) < epsilon &&
    Math.abs(last.close - last.low) < epsilon;
  const beltHoldBullish =
    last.close > last.open &&
    Math.abs(last.open - last.low) < epsilon &&
    last.close - last.open > (last.high - last.low) * 0.6;
  const beltHoldBearish =
    last.close < last.open &&
    Math.abs(last.open - last.high) < epsilon &&
    last.open - last.close > (last.high - last.low) * 0.6;

  let kickerBullish = false;
  let kickerBearish = false;
  if (candles.length >= 2) {
    const prevCandle = candles[candles.length - 2];
    kickerBullish =
      prevCandle.close < prevCandle.open &&
      last.open > prevCandle.open &&
      last.close > last.open;
    kickerBearish =
      prevCandle.close > prevCandle.open &&
      last.open < prevCandle.open &&
      last.close < last.open;
  }

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
  if (isHangingMan)
    patterns.push({
      type: "Hanging Man",
      direction: "Short",
      strength: 2,
      confidence: "Medium",
    });
  if (marubozuBullish)
    patterns.push({
      type: "Marubozu (Bullish)",
      direction: "Long",
      strength: 2,
      confidence: "Medium",
    });
  if (marubozuBearish)
    patterns.push({
      type: "Marubozu (Bearish)",
      direction: "Short",
      strength: 2,
      confidence: "Medium",
    });
  if (beltHoldBullish)
    patterns.push({
      type: "Belt Hold (Bullish)",
      direction: "Long",
      strength: 2,
      confidence: "Medium",
    });
  if (beltHoldBearish)
    patterns.push({
      type: "Belt Hold (Bearish)",
      direction: "Short",
      strength: 2,
      confidence: "Medium",
    });
  if (kickerBullish)
    patterns.push({
      type: "Kicker Pattern (Bullish)",
      direction: "Long",
      strength: 3,
      confidence: "High",
    });
  if (kickerBearish)
    patterns.push({
      type: "Kicker Pattern (Bearish)",
      direction: "Short",
      strength: 3,
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
  const haramiCrossBullish =
    isDoji &&
    prev.open > prev.close &&
    last.high <= prev.open &&
    last.low >= prev.close;
  if (haramiCrossBullish)
    patterns.push({
      type: "Bullish Harami Cross",
      direction: "Long",
      strength: 2,
      confidence: "Medium",
    });
  const haramiCrossBearish =
    isDoji &&
    prev.open < prev.close &&
    last.high <= prev.close &&
    last.low >= prev.open;
  if (haramiCrossBearish)
    patterns.push({
      type: "Bearish Harami Cross",
      direction: "Short",
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
  const tweezerBottom =
    prev.close < prev.open &&
    last.close > last.open &&
    Math.abs(prev.low - last.low) < epsilon;
  if (tweezerBottom)
    patterns.push({
      type: "Tweezer Bottom",
      direction: "Long",
      strength: 2,
      confidence: "Medium",
    });
  const tweezerTop =
    prev.close > prev.open &&
    last.close < last.open &&
    Math.abs(prev.high - last.high) < epsilon;
  if (tweezerTop)
    patterns.push({
      type: "Tweezer Top",
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

  if (candles.length >= 5) {
    const [r1, r2, r3, r4, r5] = candles.slice(-5);
    const risingThreeMethods =
      r1.close > r1.open &&
      [r2, r3, r4].every(
        (c) =>
          c.close < c.open && c.high <= r1.high && c.low >= r1.low
      ) &&
      r5.close > r5.open &&
      r5.close > r1.close;
    if (risingThreeMethods)
      patterns.push({
        type: "Rising Three Methods",
        direction: "Long",
        strength: 3,
        confidence: "High",
      });

    const fallingThreeMethods =
      r1.close < r1.open &&
      [r2, r3, r4].every(
        (c) =>
          c.close > c.open && c.high <= r1.high && c.low >= r1.low
      ) &&
      r5.close < r5.open &&
      r5.close < r1.close;
    if (fallingThreeMethods)
      patterns.push({
        type: "Falling Three Methods",
        direction: "Short",
        strength: 3,
        confidence: "High",
      });

    const matHoldBullish =
      r1.close > r1.open &&
      r2.open > r1.close &&
      [r2, r3, r4].every((c) => c.close < c.open && c.low > r1.low) &&
      r5.close > r5.open &&
      r5.close > r2.open;
    if (matHoldBullish)
      patterns.push({
        type: "Mat Hold Pattern (Bullish)",
        direction: "Long",
        strength: 3,
        confidence: "High",
      });

    const matHoldBearish =
      r1.close < r1.open &&
      r2.open < r1.close &&
      [r2, r3, r4].every((c) => c.close > c.open && c.high < r1.high) &&
      r5.close < r5.open &&
      r5.close < r2.open;
    if (matHoldBearish)
      patterns.push({
        type: "Mat Hold Pattern (Bearish)",
        direction: "Short",
        strength: 3,
        confidence: "High",
      });

    const breakawayBullish =
      r1.open > r1.close &&
      r2.open < r1.close &&
      r2.close < r1.close &&
      r3.close < r2.close &&
      r4.close < r3.close &&
      r5.close > r4.close &&
      r5.close > r1.open;
    if (breakawayBullish)
      patterns.push({
        type: "Breakaway (Bullish)",
        direction: "Long",
        strength: 3,
        confidence: "High",
      });

    const breakawayBearish =
      r1.close > r1.open &&
      r2.open > r1.close &&
      r2.close > r1.close &&
      r3.close > r2.close &&
      r4.close > r3.close &&
      r5.close < r4.close &&
      r5.close < r1.open;
    if (breakawayBearish)
      patterns.push({
        type: "Breakaway (Bearish)",
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

  const isCup =
    (lastN[0]?.high ?? 0) > (lastN[2]?.high ?? 0) &&
    (lastN[4]?.high ?? 0) > (lastN[2]?.high ?? 0);
  const isHandle =
    lastN[2] && last.low > lastN[2].low && last.close > last.open;
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

  if (lastN.length >= 5) {
    const isRoundingTop =
      highs[0] < highs[1] &&
      highs[1] < highs[2] &&
      highs[2] > highs[3] &&
      highs[3] > highs[4] &&
      lows[0] < lows[1] &&
      lows[1] < lows[2] &&
      lows[2] > lows[3] &&
      lows[3] > lows[4];

    if (isRoundingTop) {
      patterns.push({
        type: "Rounding Top",
        direction: "Short",
        breakout: recentLow,
        stopLoss: highs[2],
        strength: 2,
        confidence: "Medium",
      });
    }

    const isRoundingBottom =
      highs[0] > highs[1] &&
      highs[1] > highs[2] &&
      highs[2] < highs[3] &&
      highs[3] < highs[4] &&
      lows[0] > lows[1] &&
      lows[1] > lows[2] &&
      lows[2] < lows[3] &&
      lows[3] < lows[4];

    if (isRoundingBottom) {
      patterns.push({
        type: "Rounding Bottom",
        direction: "Long",
        breakout: recentHigh,
        stopLoss: lows[2],
        strength: 2,
        confidence: "Medium",
      });
    }
  }

  if (candles.length >= 3) {
    const [a, b, c] = candles.slice(-3);
    const rangeA = a.high - a.low;
    const rangeB = b.high - b.low;
    const rangeC = c.high - c.low;

    const broadeningTop =
      c.high > b.high &&
      b.high > a.high &&
      c.low < b.low &&
      b.low < a.low &&
      rangeB > rangeA &&
      rangeC > rangeB;

    if (broadeningTop) {
      patterns.push({
        type: "Broadening Top",
        direction: "Short",
        breakout: c.low,
        stopLoss: c.high,
        strength: 2,
        confidence: "Medium",
      });
    }

    const broadeningBottom =
      c.high < b.high &&
      b.high < a.high &&
      c.low > b.low &&
      b.low > a.low &&
      rangeB > rangeA &&
      rangeC > rangeB;

    if (broadeningBottom) {
      patterns.push({
        type: "Broadening Bottom",
        direction: "Long",
        breakout: c.high,
        stopLoss: c.low,
        strength: 2,
        confidence: "Medium",
      });
    }

    const saucerBottom =
      a.close < a.open &&
      b.close < b.open &&
      b.low >= a.low &&
      c.close > c.open &&
      c.close > b.close;

    if (saucerBottom) {
      patterns.push({
        type: "Saucer Bottom",
        direction: "Long",
        breakout: c.high,
        stopLoss: Math.min(a.low, b.low),
        strength: 1,
        confidence: "Medium",
      });
    }
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

  // Pennant
  if (candles.length >= 6) {
    const priorUp = candles.slice(-6, -3).every((c) => c.close > c.open);
    const priorDown = candles.slice(-6, -3).every((c) => c.close < c.open);
    const cons = candles.slice(-3);
    const cHighs = cons.map((c) => c.high);
    const cLows = cons.map((c) => c.low);
    const tightening = cHighs[0] > cHighs[1] && cHighs[1] > cHighs[2] && cLows[0] < cLows[1] && cLows[1] < cLows[2];
    if (priorUp && tightening && last.close > last.open) {
      patterns.push({
        type: "Pennant (Bullish)",
        direction: "Long",
        breakout: Math.max(...cHighs),
        stopLoss: Math.min(...cLows),
        strength: 2,
        confidence: "Medium",
      });
    }
    if (priorDown && tightening && last.close < last.open) {
      patterns.push({
        type: "Pennant (Bearish)",
        direction: "Short",
        breakout: Math.min(...cLows),
        stopLoss: Math.max(...cHighs),
        strength: 2,
        confidence: "Medium",
      });
    }
  }

  // Rectangle
  if (candles.length >= 6) {
    const rect = candles.slice(-4);
    const rHigh = Math.max(...rect.map((c) => c.high));
    const rLow = Math.min(...rect.map((c) => c.low));
    const withinRange = rect.every(
      (c) => Math.abs(c.high - rHigh) < epsilon && Math.abs(c.low - rLow) < epsilon
    );
    const priorUp = candles.slice(-6, -4).every((c) => c.close > c.open);
    const priorDown = candles.slice(-6, -4).every((c) => c.close < c.open);
    if (withinRange && priorUp) {
      patterns.push({
        type: "Rectangle (Bullish)",
        direction: "Long",
        breakout: rHigh,
        stopLoss: rLow,
        strength: 2,
        confidence: "Medium",
      });
    } else if (withinRange && priorDown) {
      patterns.push({
        type: "Rectangle (Bearish)",
        direction: "Short",
        breakout: rLow,
        stopLoss: rHigh,
        strength: 2,
        confidence: "Medium",
      });
    }
  }

  // Channel Up / Down
  if (candles.length >= 4) {
    const [c1, c2, c3, c4] = candles.slice(-4);
    const up = c1.high < c2.high && c2.high < c3.high && c3.high < c4.high &&
      c1.low < c2.low && c2.low < c3.low && c3.low < c4.low;
    const down = c1.high > c2.high && c2.high > c3.high && c3.high > c4.high &&
      c1.low > c2.low && c2.low > c3.low && c3.low > c4.low;
    const widthOk = Math.abs((c4.high - c4.low) - (c1.high - c1.low)) < (c1.high - c1.low) * 0.3;
    if (up && widthOk) {
      patterns.push({
        type: "Channel Up",
        direction: "Long",
        breakout: c4.high,
        stopLoss: c4.low,
        strength: 2,
        confidence: "Medium",
      });
    } else if (down && widthOk) {
      patterns.push({
        type: "Channel Down",
        direction: "Short",
        breakout: c4.low,
        stopLoss: c4.high,
        strength: 2,
        confidence: "Medium",
      });
    }
  }

  // Measured Move
  if (candles.length >= 7) {
    const [a, b, c, d, e, f, g] = candles.slice(-7);
    const leg1 = b.close - a.open;
    const leg2 = g.close - d.close;
    const upMove = a.close < b.close && b.close > c.close && d.close < e.close && e.close < f.close && leg2 > 0;
    const downMove = a.close > b.close && b.close < c.close && d.close > e.close && e.close > f.close && leg2 < 0;
    if (upMove && Math.abs(leg2 - leg1) / Math.abs(leg1) < 0.5) {
      patterns.push({
        type: "Measured Move Up",
        direction: "Long",
        breakout: g.close,
        stopLoss: c.low,
        strength: 2,
        confidence: "Medium",
      });
    } else if (downMove && Math.abs(leg2 - leg1) / Math.abs(leg1) < 0.5) {
      patterns.push({
        type: "Measured Move Down",
        direction: "Short",
        breakout: g.close,
        stopLoss: c.high,
        strength: 2,
        confidence: "Medium",
      });
    }
  }

  // Trendline Break
  if (candles.length >= 4) {
    const [h1, h2, h3] = highs.slice(-3);
    const [l1, l2, l3] = lows.slice(-3);
    if (h1 > h2 && h2 > h3 && last.close > h2) {
      patterns.push({
        type: "Trendline Break (Bullish)",
        direction: "Long",
        breakout: last.close,
        stopLoss: recentLow,
        strength: 2,
        confidence: "Medium",
      });
    }
    if (l1 < l2 && l2 < l3 && last.close < l2) {
      patterns.push({
        type: "Trendline Break (Bearish)",
        direction: "Short",
        breakout: last.close,
        stopLoss: recentHigh,
        strength: 2,
        confidence: "Medium",
      });
    }
  }

  // High/Low Base
  if (candles.length >= 6) {
    const base = candles.slice(-4);
    const baseHigh = Math.max(...base.map((c) => c.high));
    const baseLow = Math.min(...base.map((c) => c.low));
    const tight = base.every((c) => c.high - c.low < (recentHigh - recentLow) * 0.3);
    const priorUp = candles.slice(-6, -4).every((c) => c.close > c.open);
    const priorDown = candles.slice(-6, -4).every((c) => c.close < c.open);
    if (tight && priorUp && Math.abs(baseHigh - recentHigh) < epsilon) {
      patterns.push({
        type: "High Base",
        direction: "Long",
        breakout: baseHigh,
        stopLoss: baseLow,
        strength: 2,
        confidence: "Medium",
      });
    } else if (tight && priorDown && Math.abs(baseLow - recentLow) < epsilon) {
      patterns.push({
        type: "Low Base",
        direction: "Short",
        breakout: baseLow,
        stopLoss: baseHigh,
        strength: 2,
        confidence: "Medium",
      });
    }
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

  if (lastN.length > 3 && last.high < lastN[3].high && last.low > lastN[3].low) {
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
    lastN.length > 3 &&
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
    lastN.length > 3 &&
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

  // --- Price Action Swing Structures ---
  if (candles.length >= 3) {
    const [p1, p2, p3] = candles.slice(-3);
    if (
      p2.high > p1.high &&
      p3.high > p2.high &&
      p2.low > p1.low &&
      p3.low > p2.low
    ) {
      patterns.push({
        type: "HH-HL Structure",
        direction: "Long",
        strength: 1,
        confidence: "Medium",
      });
    }
    if (
      p2.high < p1.high &&
      p3.high < p2.high &&
      p2.low < p1.low &&
      p3.low < p2.low
    ) {
      patterns.push({
        type: "LH-LL Structure",
        direction: "Short",
        strength: 1,
        confidence: "Medium",
      });
    }
  }

  // --- Inside/Outside Bar Patterns ---
  if (candles.length >= 3) {
    const base = candles[candles.length - 3];
    const inside = candles[candles.length - 2];
    if (inside.high < base.high && inside.low > base.low) {
      if (last.close > inside.high) {
        patterns.push({
          type: "Inside Bar Breakout (Bullish)",
          direction: "Long",
          breakout: last.close,
          stopLoss: inside.low,
          strength: 2,
          confidence: "Medium",
        });
      } else if (last.close < inside.low) {
        patterns.push({
          type: "Inside Bar Breakout (Bearish)",
          direction: "Short",
          breakout: last.close,
          stopLoss: inside.high,
          strength: 2,
          confidence: "Medium",
        });
      }
    }
  }

  if (candles.length >= 2) {
    const prev = candles[candles.length - 2];
    if (last.high > prev.high && last.low < prev.low) {
      if (last.close > prev.open) {
        patterns.push({
          type: "Outside Bar Bullish Reversal",
          direction: "Long",
          strength: 2,
          confidence: "Medium",
        });
      }
      if (last.close < prev.open) {
        patterns.push({
          type: "Outside Bar Bearish Reversal",
          direction: "Short",
          strength: 2,
          confidence: "Medium",
        });
      }
    }
  }

  // --- Break of Structure & Change of Character ---
  if (candles.length >= lookback + 1) {
    const prevClose = candles[candles.length - 2].close;
    if (last.close > recentHigh && prevClose <= recentHigh) {
      patterns.push({
        type: "Break of Structure (Bullish)",
        direction: "Long",
        breakout: last.close,
        stopLoss: recentLow,
        strength: 2,
        confidence: "High",
      });
    }
    if (last.close < recentLow && prevClose >= recentLow) {
      patterns.push({
        type: "Break of Structure (Bearish)",
        direction: "Short",
        breakout: last.close,
        stopLoss: recentHigh,
        strength: 2,
        confidence: "High",
      });
    }
  }

  if (candles.length >= 4) {
    const [c1, c2, c3, c4] = candles.slice(-4);
    if (c3.high > c2.high && c3.low > c2.low && c4.close < c3.low) {
      patterns.push({
        type: "Change of Character (Bearish)",
        direction: "Short",
        strength: 2,
        confidence: "High",
      });
    }
    if (c3.high < c2.high && c3.low < c2.low && c4.close > c3.high) {
      patterns.push({
        type: "Change of Character (Bullish)",
        direction: "Long",
        strength: 2,
        confidence: "High",
      });
    }
  }

  // --- Swing Failure Pattern ---
  if (last.high > recentHigh && last.close <= recentHigh) {
    patterns.push({
      type: "Swing Failure Pattern (Bearish)",
      direction: "Short",
      breakout: recentHigh,
      stopLoss: last.high,
      strength: 2,
      confidence: "Medium",
    });
  }
  if (last.low < recentLow && last.close >= recentLow) {
    patterns.push({
      type: "Swing Failure Pattern (Bullish)",
      direction: "Long",
      breakout: recentLow,
      stopLoss: last.low,
      strength: 2,
      confidence: "Medium",
    });
  }

  // --- Order Block Reversal ---
  if (candles.length >= 3) {
    const base = candles[candles.length - 3];
    const mid = candles[candles.length - 2];
    if (base.close > base.open && mid.low >= base.low && last.close < base.low) {
      patterns.push({
        type: "Order Block Reversal (Bearish)",
        direction: "Short",
        breakout: last.close,
        stopLoss: base.high,
        strength: 3,
        confidence: "Medium",
      });
    }
    if (base.close < base.open && mid.high <= base.high && last.close > base.high) {
      patterns.push({
        type: "Order Block Reversal (Bullish)",
        direction: "Long",
        breakout: last.close,
        stopLoss: base.low,
        strength: 3,
        confidence: "Medium",
      });
    }
  }

  // --- Fair Value Gap ---
  if (candles.length >= 3) {
    const g1 = candles[candles.length - 3];
    const g2 = candles[candles.length - 2];
    const gapUp = g2.low > g1.high && last.low > g2.high;
    const gapDown = g2.high < g1.low && last.high < g2.low;
    if (gapUp) {
      patterns.push({
        type: "Fair Value Gap (Up)",
        direction: "Long",
        strength: 1,
        confidence: "Medium",
      });
    }
    if (gapDown) {
      patterns.push({
        type: "Fair Value Gap (Down)",
        direction: "Short",
        strength: 1,
        confidence: "Medium",
      });
    }
  }

  // --- Supply / Demand Zones ---
  if (candles.length >= 5) {
    const last5Highs = candles.slice(-5).map((c) => c.high);
    const last5Lows = candles.slice(-5).map((c) => c.low);
    const highRange = Math.max(...last5Highs) - Math.min(...last5Highs);
    const lowRange = Math.max(...last5Lows) - Math.min(...last5Lows);
    if (highRange < atrValue) {
      patterns.push({
        type: "Supply Zone",
        direction: "Short",
        strength: 1,
        confidence: "Low",
      });
    }
    if (lowRange < atrValue) {
      patterns.push({
        type: "Demand Zone",
        direction: "Long",
        strength: 1,
        confidence: "Low",
      });
    }
  }

  // --- Liquidity Sweep / Stop Hunt ---
  if (candles.length >= 2) {
    const priorHigh = Math.max(...candles.slice(0, -1).map((c) => c.high));
    const priorLow = Math.min(...candles.slice(0, -1).map((c) => c.low));
    if (last.high > priorHigh && last.close <= priorHigh) {
      patterns.push({
        type: "Liquidity Sweep (Up)",
        direction: "Short",
        strength: 2,
        confidence: "Medium",
      });
    }
    if (last.low < priorLow && last.close >= priorLow) {
      patterns.push({
        type: "Liquidity Sweep (Down)",
        direction: "Long",
        strength: 2,
        confidence: "Medium",
      });
    }
  }

  // --- Additional Swing Patterns ---
  if (candles.length >= 5) {
    const [p1, p2, p3, p4, p5] = candles.slice(-5);
    const bullishWolfe =
      p1.low > p2.low &&
      p3.low > p1.low &&
      p4.low < p3.low &&
      p5.low > p4.low &&
      p5.high > p3.high;
    const bearishWolfe =
      p1.high < p2.high &&
      p3.high < p2.high &&
      p4.high > p3.high &&
      p5.high < p4.high &&
      p5.low < p3.low;
    if (bullishWolfe) {
      patterns.push({
        type: "Wolfe Wave (Bullish)",
        direction: "Long",
        strength: 3,
        confidence: "Low",
      });
    } else if (bearishWolfe) {
      patterns.push({
        type: "Wolfe Wave (Bearish)",
        direction: "Short",
        strength: 3,
        confidence: "Low",
      });
    }

    const XA = p2.close - p1.close;
    const AB = p3.close - p2.close;
    const BC = p4.close - p3.close;
    const CD = p5.close - p4.close;
    const abxa = Math.abs(AB / (XA || 1));
    const bcab = Math.abs(BC / (AB || 1));
    const cdxa = Math.abs(CD / (XA || 1));
    const harmonicCheck = (range, [min, max]) => range >= min && range <= max;
    const patternsMap = [
      { name: "Gartley", ab: [0.6, 0.7], bc: [0.5, 0.9], cd: [0.7, 0.9] },
      { name: "Bat", ab: [0.4, 0.6], bc: [0.5, 1.0], cd: [0.8, 1.0] },
      { name: "Butterfly", ab: [0.7, 0.8], bc: [0.3, 0.9], cd: [1.2, 1.7] },
      { name: "Crab", ab: [0.3, 0.6], bc: [0.3, 1.0], cd: [1.6, 2.0] },
      { name: "Shark", ab: [0.4, 0.6], bc: [1.1, 1.6], cd: [0.8, 1.2] },
      { name: "Cypher", ab: [0.3, 0.4], bc: [1.2, 1.4], cd: [0.7, 0.9] },
    ];
    for (const h of patternsMap) {
      if (
        harmonicCheck(abxa, h.ab) &&
        harmonicCheck(bcab, h.bc) &&
        harmonicCheck(cdxa, h.cd)
      ) {
        patterns.push({
          type: `${h.name} Pattern`,
          direction: CD > 0 ? "Long" : "Short",
          strength: 2,
          confidence: "Low",
        });
        break;
      }
    }

    const impulseUp =
      p1.close < p2.close &&
      p2.close > p3.close &&
      p3.close > p1.close &&
      p4.close > p2.close &&
      p5.close > p4.close;
    const impulseDown =
      p1.close > p2.close &&
      p2.close < p3.close &&
      p3.close < p1.close &&
      p4.close < p2.close &&
      p5.close < p4.close;
    if (impulseUp) {
      patterns.push({
        type: "Elliott Wave Impulse (Bullish)",
        direction: "Long",
        strength: 2,
        confidence: "Low",
      });
    } else if (impulseDown) {
      patterns.push({
        type: "Elliott Wave Impulse (Bearish)",
        direction: "Short",
        strength: 2,
        confidence: "Low",
      });
    }
  }

  if (candles.length >= 3) {
    const [a, b, c] = candles.slice(-3);
    if (b.high > a.high && b.high > c.high && b.low > a.low && b.low > c.low) {
      patterns.push({
        type: "Fractal Top", 
        direction: "Short",
        strength: 1,
        confidence: "Low",
      });
    }
    if (b.low < a.low && b.low < c.low && b.high < a.high && b.high < c.high) {
      patterns.push({
        type: "Fractal Bottom",
        direction: "Long",
        strength: 1,
        confidence: "Low",
      });
    }
  }

  if (candles.length >= 6) {
    const slice = candles.slice(-6);
    const highsSeq = slice.map(c => c.high);
    const lowsSeq = slice.map(c => c.low);
    const expand = highsSeq[1] > highsSeq[0] && lowsSeq[1] < lowsSeq[0] && highsSeq[2] > highsSeq[1] && lowsSeq[2] < lowsSeq[1];
    const contract = highsSeq[5] < highsSeq[4] && lowsSeq[5] > lowsSeq[4] && highsSeq[4] < highsSeq[3] && lowsSeq[4] > lowsSeq[3];
    if (expand && contract) {
      patterns.push({
        type: "Diamond Top",
        direction: "Short",
        strength: 3,
        confidence: "Low",
      });
    }
    const expandB = highsSeq[1] < highsSeq[0] && lowsSeq[1] > lowsSeq[0] && highsSeq[2] < highsSeq[1] && lowsSeq[2] > lowsSeq[1];
    const contractB = highsSeq[5] > highsSeq[4] && lowsSeq[5] < lowsSeq[4] && highsSeq[4] > highsSeq[3] && lowsSeq[4] < lowsSeq[3];
    if (expandB && contractB) {
      patterns.push({
        type: "Diamond Bottom",
        direction: "Long",
        strength: 3,
        confidence: "Low",
      });
    }
  }

  if (candles.length >= 4) {
    const [w1, w2, w3, w4] = candles.slice(-4);
    const sharpRise = w1.close > w1.open && w2.close > w1.close * 1.03;
    const breakdown = w3.close < w2.low && w4.close < w3.close;
    if (sharpRise && breakdown) {
      patterns.push({
        type: "Bump and Run Reversal",
        direction: "Short",
        strength: 2,
        confidence: "Low",
      });
    }
  }

  if (candles.length >= 3) {
    const [i1, i2, i3] = candles.slice(-3);
    const gapUp = i2.low > i1.high && i3.high < i2.low;
    const gapDown = i2.high < i1.low && i3.low > i2.high;
    if (gapUp) {
      patterns.push({
        type: "Island Reversal (Bearish)",
        direction: "Short",
        strength: 2,
        confidence: "Low",
      });
      patterns.push({
        type: "Island Reversal Top",
        direction: "Short",
        strength: 2,
        confidence: "Low",
      });
    } else if (gapDown) {
      patterns.push({
        type: "Island Reversal (Bullish)",
        direction: "Long",
        strength: 2,
        confidence: "Low",
      });
      patterns.push({
        type: "Island Reversal Bottom",
        direction: "Long",
        strength: 2,
        confidence: "Low",
      });
    }
  }

  if (candles.length >= 4) {
    const [d1, d2, d3, d4] = candles.slice(-4);
    const dropPct = (d2.close - d1.close) / Math.abs(d1.close);
    const bouncePct = (d3.close - d2.close) / Math.abs(d2.close);
    const fail = d4.close < d2.close;
    if (dropPct < -0.1 && bouncePct > 0 && bouncePct < 0.5 && fail) {
      patterns.push({
        type: "Dead Cat Bounce",
        direction: "Short",
        strength: 2,
        confidence: "Low",
      });
    }
  }

  if (candles.length >= 3) {
    const [b1, b2, b3] = candles.slice(-3);
    if (b2.high > Math.max(b1.high, b3.high) && b3.close < b1.close) {
      patterns.push({
        type: "Bull Trap",
        direction: "Short",
        strength: 2,
        confidence: "Low",
      });
      const prevClose = b1.close;
      const gap = (b2.open - prevClose) / prevClose;
      if (gap > 0.015 && b3.close < b1.high && b3.close < b2.open) {
        patterns.push({
          type: "Bull Trap After Gap Up",
          direction: "Short",
          strength: 2,
          confidence: "Medium",
        });
      }
    }
    if (b2.low < Math.min(b1.low, b3.low) && b3.close > b1.close) {
      patterns.push({
        type: "Bear Trap",
        direction: "Long",
        strength: 2,
        confidence: "Low",
      });
      const prevClose = b1.close;
      const gap = (b2.open - prevClose) / prevClose;
      if (gap < -0.015 && b3.close > b1.low && b3.close > b2.open) {
        patterns.push({
          type: "Bear Trap After Gap Down",
          direction: "Long",
          strength: 2,
          confidence: "Medium",
        });
      }
    }
  }

  if (candles.length >= 2) {
    const prev = candles[candles.length - 2];
    const last = candles[candles.length - 1];
    const gap = (last.open - prev.close) / prev.close;
    if (gap > 0.015 && last.close < prev.close && last.close < last.open) {
      patterns.push({
        type: "Gap Fill Reversal (Bearish)",
        direction: "Short",
        strength: 2,
        confidence: "Medium",
      });
    }
    if (gap < -0.015 && last.close > prev.close && last.close > last.open) {
      patterns.push({
        type: "Gap Fill Reversal (Bullish)",
        direction: "Long",
        strength: 2,
        confidence: "Medium",
      });
    }
  }

  if (candles.length >= 3) {
    const [c1, c2, c3] = candles.slice(-3);
    const up = c1.close < c2.close && c2.close < c3.close && c3.high - c3.low > (c2.high - c2.low) * 1.5;
    const down = c1.close > c2.close && c2.close > c3.close && c3.high - c3.low > (c2.high - c2.low) * 1.5;
    if (up) {
      patterns.push({
        type: "Climax Top",
        direction: "Short",
        strength: 2,
        confidence: "Low",
      });
    }
    if (down) {
      patterns.push({
        type: "Climax Bottom",
        direction: "Long",
        strength: 2,
        confidence: "Low",
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

// Calculate stop-loss distance based on ATR and setup type
export function atrStopLossDistance(atr, setupType = "conservative") {
  if (!atr) return 0;
  const mult =
    setupType === "breakout" || setupType === "high" ? 2 : 1.5;
  return atr * mult;
}

// Estimate margin required for a trade given price, quantity and leverage
export function calculateRequiredMargin({
  price,
  qty,
  lotSize = 1,
  leverage = 0,
  brokerMargin = undefined,
}) {
  if (!price || !qty) return 0;
  const pct =
    typeof brokerMargin === "number"
      ? brokerMargin
      : leverage > 0
      ? 1 / leverage
      : DEFAULT_MARGIN_PERCENT;
  return price * qty * lotSize * pct;
}

// Determine if recent candles show strong HH-HL or LH-LL structure
export function isStrongPriceAction(candles = []) {
  if (candles.length < 3) return false;
  const [p1, p2, p3] = candles.slice(-3);
  const bullish = p2.high > p1.high && p3.high > p2.high && p2.low > p1.low && p3.low > p2.low;
  const bearish = p2.high < p1.high && p3.high < p2.high && p2.low < p1.low && p3.low < p2.low;
  return bullish || bearish;
}

// Measure wick noise on a candle as wick/body ratio
export function getWickNoise(candle = {}) {
  if (!candle || candle.high === undefined) return 0;
  const body = Math.abs((candle.close ?? 0) - (candle.open ?? 0)) || 1;
  const upper = (candle.high ?? 0) - Math.max(candle.close ?? 0, candle.open ?? 0);
  const lower = Math.min(candle.close ?? 0, candle.open ?? 0) - (candle.low ?? 0);
  const wick = Math.max(upper, lower);
  return wick / body;
}

// Check if ATR series is stable (std dev relative to mean below threshold)
export function isAtrStable(candles = [], period = 14, threshold = 0.3) {
  if (candles.length <= period) return true;
  const atrValues = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    atrValues.push(getATR(candles.slice(0, i + 1), period));
  }
  const mean = atrValues.reduce((a, b) => a + b, 0) / atrValues.length;
  const variance = atrValues.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / atrValues.length;
  const std = Math.sqrt(variance);
  return mean === 0 ? true : std / mean < threshold;
}

// Determine if entry is outside the middle consolidation zone
export function isAwayFromConsolidation(candles = [], entry, lookback = 10) {
  if (!entry || candles.length < lookback) return true;
  const recent = candles.slice(-lookback);
  const high = Math.max(...recent.map(c => c.high));
  const low = Math.min(...recent.map(c => c.low));
  const range = high - low;
  if (!range) return true;
  const zoneLow = low + range * 0.2;
  const zoneHigh = high - range * 0.2;
  return entry < zoneLow || entry > zoneHigh;
}

export function aggregateCandles(candles = [], interval = 5) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const grouped = [];
  for (let i = 0; i < candles.length; i += interval) {
    const chunk = candles.slice(i, i + interval);
    if (chunk.length === 0) continue;
    const open = chunk[0].open;
    const close = chunk[chunk.length - 1].close;
    const high = Math.max(...chunk.map(c => c.high));
    const low = Math.min(...chunk.map(c => c.low));
    const volume = chunk.reduce((s, c) => s + (c.volume || 0), 0);
    grouped.push({ open, high, low, close, volume });
  }
  return grouped;
}

export function patternConfluenceAcrossTimeframes(candles = [], patternType) {
  if (!Array.isArray(candles) || candles.length < 10) return false;
  const lowerPatterns = detectAllPatterns(candles, 1, 5);
  if (!lowerPatterns.find(p => p.type === patternType)) return false;
  const agg5 = aggregateCandles(candles, 5);
  const aggPatterns = detectAllPatterns(agg5, 1, 5);
  return aggPatterns.some(p => p.type === patternType);
}
