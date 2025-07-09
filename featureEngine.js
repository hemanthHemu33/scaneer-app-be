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
  if (!prices || prices.length < length + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = prices.length - length - 1; i < prices.length - 1; i++) {
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
  const last = candles[candles.length - 1];
  const refDate = new Date(last.timestamp || last.date);
  refDate.setHours(0, 0, 0, 0);
  let totalPV = 0,
    totalVolume = 0;
  candles.forEach((c) => {
    const ts = new Date(c.timestamp || c.date);
    if (ts < refDate) return;
    const typicalPrice = (c.high + c.low + c.close) / 3;
    totalPV += typicalPrice * (c.volume || 0);
    totalVolume += c.volume || 0;
  });
  return totalVolume > 0 ? totalPV / totalVolume : null;
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
    rsi,
    atr,
    supertrend,
    avgVolume,
    rvol,
    vwap,
  };
}
