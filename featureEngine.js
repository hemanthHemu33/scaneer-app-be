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

function emaSeries(data, length) {
  const k = 2 / (length + 1);
  const series = [];
  let ema = data[0];
  series.push(ema);
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    series.push(ema);
  }
  return series;
}

export function calculateStochastic(candles, kPeriod = 14, dPeriod = 3) {
  if (!candles || candles.length < kPeriod) return null;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const hh = Math.max(...highs.slice(-kPeriod));
  const ll = Math.min(...lows.slice(-kPeriod));
  const k = ((closes.at(-1) - ll) / (hh - ll)) * 100;
  const kVals = [];
  for (let i = candles.length - kPeriod; i < candles.length; i++) {
    const h = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
    const l = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
    kVals.push(((closes[i] - l) / (h - l)) * 100);
  }
  const d = kVals.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod;
  return { k, d };
}

export function calculateCCI(candles, length = 20) {
  if (!candles || candles.length < length) return null;
  const tps = candles.map((c) => (c.high + c.low + c.close) / 3);
  const sma = calculateSMA(tps, length);
  const meanDev =
    tps.slice(-length).reduce((sum, tp) => sum + Math.abs(tp - sma), 0) /
    length;
  const lastTp = tps.at(-1);
  return (lastTp - sma) / (0.015 * meanDev);
}

export function calculateROC(prices, length = 12) {
  if (!prices || prices.length <= length) return null;
  const prev = prices[prices.length - 1 - length];
  return ((prices.at(-1) - prev) / prev) * 100;
}

export function calculateMomentum(prices, length = 10) {
  if (!prices || prices.length <= length) return null;
  return prices.at(-1) - prices[prices.length - 1 - length];
}

export function calculateWilliamsR(candles, length = 14) {
  if (!candles || candles.length < length) return null;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const hh = Math.max(...highs.slice(-length));
  const ll = Math.min(...lows.slice(-length));
  const close = candles.at(-1).close;
  return ((hh - close) / (hh - ll)) * -100;
}

export function calculateTRIX(prices, length = 15) {
  if (!prices || prices.length < length + 2) return null;
  const ema1 = emaSeries(prices, length);
  const ema2 = emaSeries(ema1, length);
  const ema3 = emaSeries(ema2, length);
  const curr = ema3.at(-1);
  const prev = ema3.at(-2);
  return ((curr - prev) / prev) * 100;
}

export function calculateUltimateOscillator(
  candles,
  s = 7,
  m = 14,
  l = 28
) {
  if (!candles || candles.length < l + 1) return null;
  const bp = [];
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].close;
    const curr = candles[i];
    bp.push(curr.close - Math.min(curr.low, prevClose));
    tr.push(Math.max(curr.high, prevClose) - Math.min(curr.low, prevClose));
  }
  const sum = (arr, n) => arr.slice(-n).reduce((a, b) => a + b, 0);
  const avg1 = sum(bp, s) / sum(tr, s);
  const avg2 = sum(bp, m) / sum(tr, m);
  const avg3 = sum(bp, l) / sum(tr, l);
  return ((4 * avg1 + 2 * avg2 + avg3) / 7) * 100;
}

export function calculateCMO(prices, length = 14) {
  if (!prices || prices.length < length + 1) return null;
  let up = 0,
    down = 0;
  for (let i = prices.length - length; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) up += diff;
    else down -= diff;
  }
  const denom = up + down;
  return denom === 0 ? 0 : ((up - down) / denom) * 100;
}

export function calculateConnorsRSI(
  prices,
  rsiLength = 3,
  streakLength = 2,
  rankLength = 100
) {
  if (!prices || prices.length < Math.max(rsiLength, streakLength, rankLength) + 2)
    return null;
  const rsi = calculateRSI(prices, rsiLength);

  const streaks = [];
  for (let i = prices.length - streakLength - 1; i < prices.length - 1; i++) {
    let streak = 0;
    for (let j = i - streakLength + 1; j <= i; j++) {
      const diff = prices[j + 1] - prices[j];
      if (diff > 0) streak = streak >= 0 ? streak + 1 : 1;
      else if (diff < 0) streak = streak <= 0 ? streak - 1 : -1;
      else streak = 0;
    }
    streaks.push(streak);
  }
  const rsiStreak = calculateRSI(streaks.map((v, i) => i === 0 ? 0 : streaks[i] - streaks[i - 1]), streakLength);

  const changes = [];
  for (let i = prices.length - rankLength; i < prices.length; i++) {
    if (i <= 0) continue;
    changes.push(((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
  }
  const lastChange = changes.at(-1);
  const rank =
    changes.filter((c) => c < lastChange).length / (changes.length || 1) * 100;

  return (rsi + rsiStreak + rank) / 3;
}

export function calculateForceIndex(candles, length = 13) {
  if (!candles || candles.length < length + 1) return null;
  const fiSeries = [];
  for (let i = 1; i < candles.length; i++) {
    fiSeries.push(
      (candles[i].close - candles[i - 1].close) * (candles[i].volume || 0)
    );
  }
  const ema = emaSeries(fiSeries, length);
  return ema.at(-1);
}

export function calculateKlinger(candles, short = 34, long = 55) {
  if (!candles || candles.length < long + 1) return null;
  const vf = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const dm = curr.high - curr.low;
    const cm = Math.abs(curr.close - prev.close);
    const trend = curr.close > prev.close ? 1 : curr.close < prev.close ? -1 : 0;
    vf.push(trend * dm * (curr.volume || 0));
  }
  const emaShort = emaSeries(vf, short).at(-1);
  const emaLong = emaSeries(vf, long).at(-1);
  const signal = emaSeries(vf, 13).at(-1);
  return { oscillator: emaShort - emaLong, signal };
}

export function calculateSTC(prices, short = 23, long = 50, cycle = 10) {
  if (!prices || prices.length < long + cycle) return null;
  const macdSeries = [];
  let emaShort = prices[0];
  let emaLong = prices[0];
  const kShort = 2 / (short + 1);
  const kLong = 2 / (long + 1);
  for (let i = 0; i < prices.length; i++) {
    emaShort = prices[i] * kShort + emaShort * (1 - kShort);
    emaLong = prices[i] * kLong + emaLong * (1 - kLong);
    macdSeries.push(emaShort - emaLong);
  }
  const stoch = calculateStochastic(
    macdSeries.map((v) => ({ high: v, low: v, close: v })),
    cycle,
    3
  );
  return stoch ? stoch.d : null;
}

export function calculateTSI(prices, r = 25, s = 13) {
  if (!prices || prices.length < r + s + 1) return null;
  const diff = [];
  for (let i = 1; i < prices.length; i++) {
    diff.push(prices[i] - prices[i - 1]);
  }
  const absDiff = diff.map((v) => Math.abs(v));
  const ema1 = emaSeries(diff, r);
  const ema2 = emaSeries(ema1, s);
  const ema1Abs = emaSeries(absDiff, r);
  const ema2Abs = emaSeries(ema1Abs, s);
  if (!ema2Abs.at(-1)) return null;
  return (ema2.at(-1) / ema2Abs.at(-1)) * 100;
}

export function calculateStdDev(prices, length) {
  if (!prices || prices.length < length) return null;
  const slice = prices.slice(-length);
  const mean = slice.reduce((a, b) => a + b, 0) / length;
  const variance = slice.reduce((sum, p) => sum + (p - mean) ** 2, 0) / length;
  return Math.sqrt(variance);
}

export function calculateBollingerBands(prices, length = 20, mult = 2) {
  const ma = calculateSMA(prices, length);
  const sd = calculateStdDev(prices, length);
  if (ma == null || sd == null) return null;
  return { upper: ma + mult * sd, lower: ma - mult * sd, middle: ma };
}

export function calculateKeltnerChannels(
  candles,
  emaLength = 20,
  atrLength = 10,
  mult = 2
) {
  if (!candles || candles.length < Math.max(emaLength, atrLength)) return null;
  const closes = candles.map((c) => c.close);
  const ema = calculateEMA(closes, emaLength);
  const atr = getATR(candles, atrLength);
  if (ema == null || atr == null) return null;
  return { upper: ema + mult * atr, lower: ema - mult * atr, middle: ema };
}

export function calculateDonchianChannels(candles, length = 20) {
  if (!candles || candles.length < length) return null;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const upper = Math.max(...highs.slice(-length));
  const lower = Math.min(...lows.slice(-length));
  const middle = (upper + lower) / 2;
  return { upper, lower, middle };
}

export function calculateChaikinVolatility(
  candles,
  emaLength = 10,
  rocLength = 10
) {
  if (!candles || candles.length < emaLength + rocLength) return null;
  const hlDiff = candles.map((c) => c.high - c.low);
  const ema = emaSeries(hlDiff, emaLength);
  const curr = ema.at(-1);
  const prev = ema[ema.length - 1 - rocLength];
  if (prev == null) return null;
  return ((curr - prev) / prev) * 100;
}

export function calculateHistoricalVolatility(
  prices,
  length = 20,
  periodsPerYear = 252
) {
  if (!prices || prices.length < length + 1) return null;
  const logs = [];
  for (let i = prices.length - length - 1; i < prices.length - 1; i++) {
    logs.push(Math.log(prices[i + 1] / prices[i]));
  }
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const variance = logs.reduce((s, r) => s + (r - mean) ** 2, 0) / logs.length;
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear) * 100;
}

export function calculateFractalChaosBands(candles, length = 2) {
  if (!candles || candles.length < length * 2 + 1) return null;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  let upper = null,
    lower = null;
  for (let i = length; i < candles.length - length; i++) {
    const hSlice = highs.slice(i - length, i + length + 1);
    const lSlice = lows.slice(i - length, i + length + 1);
    if (highs[i] === Math.max(...hSlice)) upper = highs[i];
    if (lows[i] === Math.min(...lSlice)) lower = lows[i];
  }
  if (upper == null) upper = Math.max(...highs.slice(-length));
  if (lower == null) lower = Math.min(...lows.slice(-length));
  return { upper, lower };
}

export function calculateEnvelopes(prices, length = 20, pct = 0.025) {
  return calculateMAEnvelopes(prices, length, pct);
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
  const stochastic = calculateStochastic(candles);
  const cci = calculateCCI(candles);
  const roc = calculateROC(closes);
  const momentum = calculateMomentum(closes);
  const williamsR = calculateWilliamsR(candles);
  const trix = calculateTRIX(closes);
  const ultOsc = calculateUltimateOscillator(candles);
  const cmo = calculateCMO(closes);
  const connorsRsi = calculateConnorsRSI(closes);
  const forceIndex = calculateForceIndex(candles);
  const klinger = calculateKlinger(candles);
  const stc = calculateSTC(closes);
  const tsi = calculateTSI(closes);
  const bollinger = calculateBollingerBands(closes);
  const keltner = calculateKeltnerChannels(candles);
  const donchian = calculateDonchianChannels(candles);
  const chaikinVol = calculateChaikinVolatility(candles);
  const stdDev = calculateStdDev(closes, 20);
  const histVol = calculateHistoricalVolatility(closes);
  const fractalChaos = calculateFractalChaosBands(candles);
  const envelopes = calculateEnvelopes(closes);
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
    stochastic,
    cci,
    roc,
    momentum,
    williamsR,
    trix,
    ultOsc,
    cmo,
    connorsRsi,
    forceIndex,
    klinger,
    stc,
    tsi,
    bollinger,
    keltner,
    donchian,
    chaikinVol,
    stdDev,
    histVol,
    fractalChaos,
    envelopes,
    atr,
    supertrend,
    avgVolume,
    rvol,
    vwap,
  };
}
