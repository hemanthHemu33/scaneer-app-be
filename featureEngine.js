// featureEngine.js
// Provides indicator calculations and feature aggregation

// Simple in-memory cache for EMA values keyed by optional id
const emaCache = new Map();

export function calculateEMA(prices, length, key) {
  if (!prices || prices.length === 0) return null;
  const k = 2 / (length + 1);
  let ema;
  let start = 0;
  if (key && emaCache.has(key)) {
    const cached = emaCache.get(key);
    ema = cached.value;
    start = cached.index + 1;
  } else {
    ema = prices[0];
  }
  for (let i = start; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  if (key) emaCache.set(key, { value: ema, index: prices.length - 1 });
  return ema;
}

export function calculateRSI(prices, length) {
  if (!prices || prices.length < 2) return null;
  const lookback = Math.min(length, prices.length - 1);
  let gains = 0,
    losses = 0;
  for (let i = prices.length - lookback - 1; i < prices.length - 1; i++) {
    const diff = prices[i + 1] - prices[i];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const rs = gains / (losses || 1);
  return 100 - 100 / (1 + rs);
}

export function calculateSupertrend(candles, atrLength = 14) {
  const lastCandle = candles[candles.length - 1];
  return {
    signal: lastCandle.close > lastCandle.open ? "Buy" : "Sell",
    level: lastCandle.close,
  };
}

export function getATR(data, period = 14) {
  if (!data || data.length < 2) return null;
  const len = Math.min(period, data.length - 1);
  let trSum = 0;
  for (let i = data.length - len; i < data.length; i++) {
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
  return trSum / len;
}

export function calculateVWAP(candles) {
  if (!candles || candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const refDate = new Date(last.timestamp || last.date);
  refDate.setHours(0, 0, 0, 0);
  const fallbackTP = (last.high + last.low + last.close) / 3;
  let totalPV = 0,
    totalVolume = 0,
    count = 0;
  candles.forEach((c) => {
    const ts = new Date(c.timestamp || c.date);
    if (ts < refDate) return;
    const typicalPrice = (c.high + c.low + c.close) / 3;
    if (c.volume && c.volume > 0) {
      totalPV += typicalPrice * c.volume;
      totalVolume += c.volume;
    } else {
      totalPV += typicalPrice;
      count += 1;
    }
  });
  if (totalVolume > 0) return totalPV / totalVolume;
  return count > 0 ? totalPV / count : fallbackTP;
}

export function calculateSMA(prices, length) {
  if (!prices || prices.length < length) return null;
  const slice = prices.slice(-length);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / length;
}

export function calculateWMA(prices, length) {
  if (!prices || prices.length < length) return null;
  const slice = prices.slice(-length);
  const weights = slice.map((_, i) => i + 1);
  const denom = weights.reduce((a, b) => a + b, 0);
  const num = slice.reduce((sum, p, i) => sum + p * weights[i], 0);
  return num / denom;
}

export function calculateHMA(prices, length) {
  if (!prices || prices.length < length) return null;
  const wmaHalf = calculateWMA(prices, Math.round(length / 2));
  const wmaFull = calculateWMA(prices, length);
  const diff = 2 * wmaHalf - wmaFull;
  const temp = prices.slice();
  temp[temp.length - 1] = diff;
  return calculateWMA(temp, Math.round(Math.sqrt(length)));
}

export function calculateDEMA(prices, length) {
  if (!prices || prices.length < length) return null;
  const ema = calculateEMA(prices, length);
  const emaOfEma = calculateEMA(prices.map((_p, i) => calculateEMA(prices.slice(0, i + 1), length)), length);
  return 2 * ema - emaOfEma;
}

export function calculateTEMA(prices, length) {
  if (!prices || prices.length < length) return null;
  const ema1 = calculateEMA(prices, length);
  const ema2 = calculateEMA(prices.map((_p, i) => calculateEMA(prices.slice(0, i + 1), length)), length);
  const ema3 = calculateEMA(
    prices.map((_p, i) => calculateEMA(prices.slice(0, i + 1).map((_q, j) => calculateEMA(prices.slice(0, j + 1), length)), length)),
    length
  );
  return 3 * (ema1 - ema2) + ema3;
}

export function calculateMACD(prices, shortLength = 12, longLength = 26, signalLength = 9) {
  if (!prices || prices.length < longLength) return null;
  const emaShort = calculateEMA(prices, shortLength);
  const emaLong = calculateEMA(prices, longLength);
  const macdLine = emaShort - emaLong;
  const signal = calculateEMA(prices.slice(-signalLength).map((_p, i) => {
    const subset = prices.slice(-(signalLength - i));
    return calculateEMA(subset, shortLength) - calculateEMA(subset, longLength);
  }), signalLength);
  const histogram = macdLine - signal;
  return { macd: macdLine, signal, histogram };
}

export function calculateADX(candles, period = 14) {
  if (!candles || candles.length <= period) return null;
  let trSum = 0,
    plusSum = 0,
    minusSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const up = curr.high - prev.high;
    const down = prev.low - curr.low;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    trSum += tr;
    plusSum += up > down && up > 0 ? up : 0;
    minusSum += down > up && down > 0 ? down : 0;
  }
  const plusDI = (plusSum / trSum) * 100;
  const minusDI = (minusSum / trSum) * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  return { adx: dx, plusDI, minusDI };
}

export function calculateVortex(candles, period = 14) {
  if (!candles || candles.length <= period) return null;
  let sumTR = 0,
    sumPlus = 0,
    sumMinus = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    sumTR += tr;
    sumPlus += Math.abs(curr.high - prev.low);
    sumMinus += Math.abs(curr.low - prev.high);
  }
  const viPlus = sumPlus / sumTR;
  const viMinus = sumMinus / sumTR;
  return { viPlus, viMinus };
}

export function calculateIchimoku(candles) {
  if (!candles || candles.length < 52) return null;
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const close = candles[candles.length - 1].close;
  const periodHigh = (arr, length) => Math.max(...arr.slice(-length));
  const periodLow = (arr, length) => Math.min(...arr.slice(-length));
  const tenkan = (periodHigh(highs, 9) + periodLow(lows, 9)) / 2;
  const kijun = (periodHigh(highs, 26) + periodLow(lows, 26)) / 2;
  const spanA = (tenkan + kijun) / 2;
  const spanB = (periodHigh(highs, 52) + periodLow(lows, 52)) / 2;
  const chikou = close;
  return { tenkan, kijun, spanA, spanB, chikou };
}

export function calculateMAEnvelopes(prices, length, pct = 0.025) {
  const ma = calculateSMA(prices, length);
  if (ma == null) return null;
  const upper = ma * (1 + pct);
  const lower = ma * (1 - pct);
  return { upper, lower, ma };
}

export function calculateLinearRegression(prices, length) {
  if (!prices || prices.length < length) return null;
  const y = prices.slice(-length);
  const x = y.map((_, i) => i + 1);
  const n = y.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
  const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = sumY / n - slope * (sumX / n);
  const prediction = slope * n + intercept;
  return { slope, intercept, prediction };
}

export function resetIndicatorCache() {
  emaCache.clear();
}

export function computeFeatures(candles = []) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume || 0);

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const sma50 = calculateSMA(closes, 50);
  const wma50 = calculateWMA(closes, 50);
  const hma50 = calculateHMA(closes, 50);
  const dema50 = calculateDEMA(closes, 50);
  const tema50 = calculateTEMA(closes, 50);
  const macd = calculateMACD(closes);
  const { adx, plusDI, minusDI } = calculateADX(candles, 14) || {};
  const vortex = calculateVortex(candles, 14);
  const ichimoku = calculateIchimoku(candles);
  const maEnv = calculateMAEnvelopes(closes, 20);
  const linearReg = calculateLinearRegression(closes, 20);
  const rsi = calculateRSI(closes, 14);
  const atr = getATR(candles, 14);
  const supertrend = calculateSupertrend(candles, 50);
  const vwap = calculateVWAP(candles);

  const avgVolume =
    volumes.length > 1
      ? volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1)
      : volumes[0] || 0;
  const rvol = avgVolume ? volumes.at(-1) / avgVolume : 1;

  return {
    ema9,
    ema21,
    ema50,
    ema200,
    sma50,
    wma50,
    hma50,
    dema50,
    tema50,
    macd,
    adx,
    plusDI,
    minusDI,
    vortex,
    ichimoku,
    maEnv,
    linearReg,
    rsi,
    atr,
    supertrend,
    avgVolume,
    rvol,
    vwap,
  };
}
