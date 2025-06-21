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

export function detectPatterns(candles, atrValue, lookback = 5) {
  if (candles.length < lookback) return null;

  const last = candles[candles.length - 1];
  const lastN = candles.slice(-lookback);
  const highs = lastN.map((c) => c.high);
  const lows = lastN.map((c) => c.low);
  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  const epsilon = 0.1;
  const totalVolume = lastN.reduce((acc, c) => acc + c.volume, 0);
  const avgVolume = totalVolume / lookback;

  if (
    last.close > recentHigh &&
    atrValue &&
    Math.abs(last.close - recentLow) > atrValue * 0.5
  ) {
    return {
      type: "Breakout",
      breakout: last.close,
      stopLoss: recentLow,
      direction: "Long",
      strength: 3,
    };
  }

  if (last.close > recentHigh && last.volume > avgVolume * 1.2)
    return {
      type: "Breakout",
      breakout: last.close,
      stopLoss: recentLow,
      direction: "Long",
      strength: 3,
      confidence: "High",
    };

  if (
    last.high < lastN[lastN.length - 2].high &&
    last.low > lastN[lastN.length - 2].low
  )
    return {
      type: "Inside Bar",
      breakout: last.high,
      stopLoss: last.low,
      direction: "Long",
      strength: 1,
      confidence: "Medium",
    };

  if (
    last.high > lastN[lastN.length - 2].high &&
    last.low < lastN[lastN.length - 2].low &&
    last.close > lastN[lastN.length - 2].close &&
    atrValue &&
    Math.abs(last.close - last.open) > atrValue * 0.3
  )
    return {
      type: "Engulfing Bullish",
      breakout: last.close,
      stopLoss: last.low,
      direction: "Long",
      strength: 2,
      confidence: "High",
    };

  if (
    last.high > lastN[lastN.length - 2].high &&
    last.low < lastN[lastN.length - 2].low &&
    last.close < lastN[lastN.length - 2].close &&
    atrValue &&
    Math.abs(last.open - last.close) > atrValue * 0.3
  )
    return {
      type: "Engulfing Bearish",
      breakout: last.close,
      stopLoss: last.high,
      direction: "Short",
      strength: 2,
      confidence: "High",
    };

  const strongUp = candles.slice(-6, -3).every((c) => c.close > c.open);
  const flagRange = candles
    .slice(-3)
    .every((c) => Math.abs(c.close - c.open) < (c.high - c.low) * 0.5);
  if (strongUp && flagRange && last.close > last.open)
    return {
      type: "Bull Flag",
      breakout: last.high,
      stopLoss: recentLow,
      direction: "Long",
      strength: 2,
      confidence: "Medium",
    };

  const isAscending =
    lows[1] > lows[0] && lows[2] > lows[1] && lows[3] > lows[2];
  const flatTop =
    Math.abs(highs[0] - highs[1]) < epsilon &&
    Math.abs(highs[1] - highs[2]) < epsilon;
  if (isAscending && flatTop)
    return {
      type: "Ascending Triangle",
      breakout: recentHigh,
      stopLoss: recentLow,
      direction: "Long",
      strength: 3,
      confidence: "High",
    };

  const middle = Math.floor(lastN.length / 2);
  const isCup =
    lastN[0].high > lastN[middle].high &&
    lastN[lastN.length - 1].high > lastN[middle].high;
  const isHandle = last.low > lastN[middle].low && last.close > last.open;
  if (isCup && isHandle)
    return {
      type: "Cup and Handle",
      breakout: last.high,
      stopLoss: last.low,
      direction: "Long",
      strength: 2,
      confidence: "High",
    };

  const isFalling = lows[0] > lows[1] && lows[1] > lows[2] && lows[2] > lows[3];
  const isNarrowing = highs[0] - lows[0] > highs[4] - lows[4];
  if (isFalling && isNarrowing && last.close > last.open)
    return {
      type: "Falling Wedge",
      breakout: last.high,
      stopLoss: last.low,
      direction: "Long",
      strength: 2,
      confidence: "High",
    };

  if (Math.abs(lows[3] - lows[4]) < epsilon && last.close > recentHigh)
    return {
      type: "Double Bottom",
      breakout: last.close,
      stopLoss: recentLow,
      direction: "Long",
      strength: 2,
      confidence: "Medium",
    };

  if (Math.abs(highs[3] - highs[4]) < epsilon && last.close < recentLow)
    return {
      type: "Double Top",
      breakout: last.close,
      stopLoss: recentHigh,
      direction: "Short",
      strength: 2,
      confidence: "Medium",
    };

  const vwap = calculateVWAP(candles);
  if (
    Math.abs(last.close - vwap) < (recentHigh - recentLow) * 0.1 &&
    last.volume > avgVolume * 1.2
  )
    return {
      type: "VWAP Reversal",
      breakout: last.close,
      stopLoss: recentLow,
      direction: last.close > vwap ? "Long" : "Short",
      strength: 1,
      confidence: "High",
    };

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
    )
      return {
        type: "Head & Shoulders",
        breakout: candles[l - 1].low,
        stopLoss: head,
        direction: "Short",
        strength: 3,
        confidence: "High",
      };
  }

  return null;
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

export function detectAllPatterns(candles, atrValue, lookback = 5) {
  const patterns = [];
  if (candles.length < lookback) return [];

  const last = candles[candles.length - 1];
  const lastN = candles.slice(-lookback);
  const highs = lastN.map((c) => c.high);
  const lows = lastN.map((c) => c.low);
  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  const totalVolume = lastN.reduce((acc, c) => acc + c.volume, 0);
  const avgVolume = totalVolume / lookback;
  const epsilon = 0.1;

  // ✅ Breakout
  if (
    last.close > recentHigh &&
    atrValue &&
    Math.abs(last.close - recentLow) > atrValue * 0.5
  ) {
    patterns.push({
      type: "Breakout",
      breakout: last.close,
      stopLoss: recentLow,
      direction: "Long",
      strength: 3,
      confidence: "High",
    });
  }

  // ✅ Inside Bar
  if (
    last.high < lastN[lastN.length - 2].high &&
    last.low > lastN[lastN.length - 2].low
  ) {
    patterns.push({
      type: "Inside Bar",
      breakout: last.high,
      stopLoss: last.low,
      direction: "Long",
      strength: 1,
      confidence: "Medium",
    });
  }

  // ✅ Engulfing Bullish
  if (
    last.high > lastN[lastN.length - 2].high &&
    last.low < lastN[lastN.length - 2].low &&
    last.close > lastN[lastN.length - 2].close &&
    Math.abs(last.close - last.open) > atrValue * 0.3
  ) {
    patterns.push({
      type: "Engulfing Bullish",
      breakout: last.close,
      stopLoss: last.low,
      direction: "Long",
      strength: 2,
      confidence: "High",
    });
  }

  // ✅ Engulfing Bearish
  if (
    last.high > lastN[lastN.length - 2].high &&
    last.low < lastN[lastN.length - 2].low &&
    last.close < lastN[lastN.length - 2].close &&
    Math.abs(last.open - last.close) > atrValue * 0.3
  ) {
    patterns.push({
      type: "Engulfing Bearish",
      breakout: last.close,
      stopLoss: last.high,
      direction: "Short",
      strength: 2,
      confidence: "High",
    });
  }

  // ✅ Head & Shoulders
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
        breakout: candles[l - 1].low,
        stopLoss: head,
        direction: "Short",
        strength: 3,
        confidence: "High",
      });
    }
  }

  return patterns;
}
