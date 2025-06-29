// util.js
import { getMA } from "./kite.js"; // Reuse kite.js

export function calculateMA(prices, length) {
  if (prices.length < length) return null;
  const sum = prices.slice(-length).reduce((a, b) => a + b, 0);
  return sum / length;
}

export function calculateEMA(prices, length) {
  const k = 2 / (length + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

export function calculateRSI(prices, length) {
  let gains = 0,
    losses = 0;
  for (let i = prices.length - length; i < prices.length - 1; i++) {
    const diff = prices[i + 1] - prices[i];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const rs = gains / (losses || 1);
  return 100 - 100 / (1 + rs);
}

export function calculateSupertrend(candles, atrLength) {
  const lastCandle = candles[candles.length - 1];
  return {
    signal: lastCandle.close > lastCandle.open ? "Buy" : "Sell",
    level: lastCandle.close,
  };
}

export function getMAForSymbol(symbol, period) {
  return getMA(symbol, period);
}

export function getATR(data, period = 14) {
  if (!data || data.length < period) return null;
  let trSum = 0;
  for (let i = 1; i < period; i++) {
    const high = data[i].high,
      low = data[i].low,
      prevClose = data[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trSum += tr;
  }
  return trSum / period;
}

export function calculateVWAP(candles) {
  if (!candles || candles.length === 0) return null;
  let totalPV = 0,
    totalVolume = 0;
  candles.forEach((c) => {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    totalPV += typicalPrice * c.volume;
    totalVolume += c.volume;
  });
  return totalVolume > 0 ? totalPV / totalVolume : null;
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
  windowMs = 180000
) {
  const now = Date.now();
  const history = signalHistory[symbol] || [];
  const conflicting = history.find(
    (sig) => now - sig.timestamp < windowMs && sig.direction !== direction
  );
  if (conflicting) return false;
  signalHistory[symbol] = history.filter(
    (sig) => now - sig.timestamp < windowMs
  );
  signalHistory[symbol].push({ direction, timestamp: now });
  return true;
}

export function calculateExpiryMinutes({ atr, rvol }) {
  const base = 5;
  const atrFactor = atr ? Math.min(Math.max(atr, 1), 4) : 1;
  const volumeFactor = rvol && rvol > 1 ? 1 + Math.min(rvol - 1, 1) : 1;
  return base * atrFactor * volumeFactor;
}

// export function detectAllPatterns(candles, atrValue, lookback = 5) {
//   const patterns = [];
//   if (candles.length < lookback) return [];

//   const last = candles[candles.length - 1];
//   const lastN = candles.slice(-lookback);
//   const highs = lastN.map((c) => c.high);
//   const lows = lastN.map((c) => c.low);
//   const recentHigh = Math.max(...highs);
//   const recentLow = Math.min(...lows);
//   const totalVolume = lastN.reduce((acc, c) => acc + c.volume, 0);
//   const avgVolume = totalVolume / lookback;
//   const epsilon = 0.1;

//   // ✅ Breakout
//   if (
//     last.close > recentHigh &&
//     atrValue &&
//     Math.abs(last.close - recentLow) > atrValue * 0.5
//   ) {
//     patterns.push({
//       type: "Breakout",
//       breakout: last.close,
//       stopLoss: recentLow,
//       direction: "Long",
//       strength: 3,
//       confidence: "High",
//     });
//   }

//   // ✅ Inside Bar
//   if (
//     last.high < lastN[lastN.length - 2].high &&
//     last.low > lastN[lastN.length - 2].low
//   ) {
//     patterns.push({
//       type: "Inside Bar",
//       breakout: last.high,
//       stopLoss: last.low,
//       direction: "Long",
//       strength: 1,
//       confidence: "Medium",
//     });
//   }

//   // ✅ Engulfing Bullish
//   if (
//     last.high > lastN[lastN.length - 2].high &&
//     last.low < lastN[lastN.length - 2].low &&
//     last.close > lastN[lastN.length - 2].close &&
//     Math.abs(last.close - last.open) > atrValue * 0.3
//   ) {
//     patterns.push({
//       type: "Engulfing Bullish",
//       breakout: last.close,
//       stopLoss: last.low,
//       direction: "Long",
//       strength: 2,
//       confidence: "High",
//     });
//   }

//   // ✅ Engulfing Bearish
//   if (
//     last.high > lastN[lastN.length - 2].high &&
//     last.low < lastN[lastN.length - 2].low &&
//     last.close < lastN[lastN.length - 2].close &&
//     Math.abs(last.open - last.close) > atrValue * 0.3
//   ) {
//     patterns.push({
//       type: "Engulfing Bearish",
//       breakout: last.close,
//       stopLoss: last.high,
//       direction: "Short",
//       strength: 2,
//       confidence: "High",
//     });
//   }

//   // ✅ Head & Shoulders
//   if (candles.length >= 7) {
//     const l = candles.length;
//     const left = candles[l - 7].high;
//     const head = candles[l - 4].high;
//     const right = candles[l - 1].high;

//     if (
//       head > left &&
//       head > right &&
//       Math.abs(left - right) < (head - Math.min(left, right)) * 0.3 &&
//       atrValue &&
//       head - Math.min(left, right) > atrValue * 0.6
//     ) {
//       patterns.push({
//         type: "Head & Shoulders",
//         breakout: candles[l - 1].low,
//         stopLoss: head,
//         direction: "Short",
//         strength: 3,
//         confidence: "High",
//       });
//     }
//   }

//   return patterns;
// }

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
