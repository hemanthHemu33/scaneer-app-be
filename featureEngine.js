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

export function calculateOBV(candles) {
  if (!candles || candles.length < 2) return null;
  let obv = 0;
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const curr = candles[i].close;
    const vol = candles[i].volume || 0;
    if (curr > prev) obv += vol;
    else if (curr < prev) obv -= vol;
  }
  return obv;
}

export function calculateCMF(candles, length = 20) {
  if (!candles || candles.length < length) return null;
  let mfv = 0,
    volSum = 0;
  for (let i = candles.length - length; i < candles.length; i++) {
    const c = candles[i];
    const mfm =
      ((c.close - c.low) - (c.high - c.close)) / (c.high - c.low || 1);
    const vol = c.volume || 0;
    mfv += mfm * vol;
    volSum += vol;
  }
  return volSum === 0 ? 0 : mfv / volSum;
}

export function calculateMFI(candles, length = 14) {
  if (!candles || candles.length < length + 1) return null;
  let posMF = 0,
    negMF = 0;
  for (let i = candles.length - length; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const prevTP =
      (candles[i - 1].high + candles[i - 1].low + candles[i - 1].close) / 3;
    const mf = tp * (candles[i].volume || 0);
    if (tp > prevTP) posMF += mf;
    else if (tp < prevTP) negMF += mf;
  }
  const mr = posMF / (negMF || 1);
  return 100 - 100 / (1 + mr);
}

export function calculateAccumDist(candles) {
  if (!candles || candles.length === 0) return null;
  let ad = 0;
  for (const c of candles) {
    const mfm =
      ((c.close - c.low) - (c.high - c.close)) / (c.high - c.low || 1);
    ad += mfm * (c.volume || 0);
  }
  return ad;
}

export function calculateAnchoredVWAP(candles, anchorIndex = 0) {
  if (!candles || candles.length === 0) return null;
  anchorIndex = Math.max(0, anchorIndex);
  let pv = 0,
    vol = 0;
  for (let i = anchorIndex; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const v = candles[i].volume || 0;
    pv += tp * v;
    vol += v;
  }
  return vol ? pv / vol : null;
}

export function calculatePVI(candles) {
  if (!candles || candles.length < 2) return null;
  let pvi = 1000;
  for (let i = 1; i < candles.length; i++) {
    const prevV = candles[i - 1].volume || 0;
    const currV = candles[i].volume || 0;
    if (currV > prevV) {
      pvi +=
        ((candles[i].close - candles[i - 1].close) / candles[i - 1].close) *
        pvi;
    }
  }
  return pvi;
}

export function calculateNVI(candles) {
  if (!candles || candles.length < 2) return null;
  let nvi = 1000;
  for (let i = 1; i < candles.length; i++) {
    const prevV = candles[i - 1].volume || 0;
    const currV = candles[i].volume || 0;
    if (currV < prevV) {
      nvi +=
        ((candles[i].close - candles[i - 1].close) / candles[i - 1].close) *
        nvi;
    }
  }
  return nvi;
}

export function calculateVolumeOscillator(volumes, short = 14, long = 28) {
  if (!volumes || volumes.length < long) return null;
  const emaShort = calculateEMA(volumes, short);
  const emaLong = calculateEMA(volumes, long);
  return ((emaShort - emaLong) / emaLong) * 100;
}

export function calculateEMV(candles, length = 14) {
  if (!candles || candles.length < length + 1) return null;
  const series = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const distance =
      (curr.high + curr.low) / 2 - (prev.high + prev.low) / 2;
    const boxRatio = (curr.volume || 1) / (curr.high - curr.low || 1);
    series.push(distance / boxRatio);
  }
  const slice = series.slice(-length);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export function calculateVPT(candles) {
  if (!candles || candles.length < 2) return null;
  let vpt = 0;
  for (let i = 1; i < candles.length; i++) {
    vpt +=
      (candles[i].volume || 0) *
      ((candles[i].close - candles[i - 1].close) / candles[i - 1].close);
  }
  return vpt;
}

export function calculateVolumeProfile(candles, buckets = 10) {
  if (!candles || candles.length === 0) return null;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const minP = Math.min(...lows);
  const maxP = Math.max(...highs);
  const step = (maxP - minP) / buckets;
  const profile = Array(buckets).fill(0);
  for (const c of candles) {
    const price = (c.high + c.low) / 2;
    let idx = Math.floor((price - minP) / step);
    if (idx >= buckets) idx = buckets - 1;
    profile[idx] += c.volume || 0;
  }
  return profile;
}

export function calculatePivotPoints(candles) {
  if (!candles || candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const pp = (last.high + last.low + last.close) / 3;
  const r1 = 2 * pp - last.low;
  const s1 = 2 * pp - last.high;
  const r2 = pp + (last.high - last.low);
  const s2 = pp - (last.high - last.low);
  const r3 = last.high + 2 * (pp - last.low);
  const s3 = last.low - 2 * (last.high - pp);
  return { pp, r1, s1, r2, s2, r3, s3 };
}

export function calculateFibonacciRetracements(high, low) {
  if (high == null || low == null) return null;
  const diff = high - low;
  return {
    level23_6: high - diff * 0.236,
    level38_2: high - diff * 0.382,
    level50: high - diff * 0.5,
    level61_8: high - diff * 0.618,
    level78_6: high - diff * 0.786,
  };
}

export function calculateFibonacciExtensions(high, low) {
  if (high == null || low == null) return null;
  const diff = high - low;
  return {
    level127_2: high + diff * 1.272,
    level161_8: high + diff * 1.618,
    level261_8: high + diff * 2.618,
  };
}

export function calculateParabolicSAR(candles, step = 0.02, max = 0.2) {
  if (!candles || candles.length < 2) return null;
  let rising = true;
  let psar = candles[0].low;
  let ep = candles[0].high;
  let af = step;
  for (let i = 1; i < candles.length; i++) {
    psar = psar + af * (ep - psar);
    const curr = candles[i];
    if (rising) {
      if (curr.low < psar) {
        rising = false;
        psar = ep;
        ep = curr.low;
        af = step;
      } else {
        if (curr.high > ep) {
          ep = curr.high;
          af = Math.min(max, af + step);
        }
      }
    } else {
      if (curr.high > psar) {
        rising = true;
        psar = ep;
        ep = curr.high;
        af = step;
      } else {
        if (curr.low < ep) {
          ep = curr.low;
          af = Math.min(max, af + step);
        }
      }
    }
  }
  return psar;
}

export function calculateHeikinAshi(candles) {
  if (!candles || candles.length === 0) return null;
  const ha = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const close = (c.open + c.high + c.low + c.close) / 4;
    const open = i === 0 ? (c.open + c.close) / 2 : (ha[i - 1].open + ha[i - 1].close) / 2;
    const high = Math.max(c.high, open, close);
    const low = Math.min(c.low, open, close);
    ha.push({ open, high, low, close });
  }
  return ha;
}

export function calculateRenko(candles, brickSize) {
  if (!candles || candles.length === 0) return null;
  if (!brickSize) brickSize = getATR(candles, 14) || (candles[0].close * 0.01);
  const bricks = [];
  let lastClose = candles[0].close;
  for (const c of candles) {
    while (Math.abs(c.close - lastClose) >= brickSize) {
      const dir = c.close > lastClose ? 1 : -1;
      lastClose += brickSize * dir;
      bricks.push({ close: lastClose, direction: dir });
    }
  }
  return bricks;
}

export function calculateKagi(prices, reversal = 1) {
  if (!prices || prices.length === 0) return null;
  const lines = [];
  let start = prices[0];
  let prev = prices[0];
  let dir = 0;
  for (let i = 1; i < prices.length; i++) {
    const p = prices[i];
    if (dir >= 0 && p >= prev) {
      prev = p;
    } else if (dir <= 0 && p <= prev) {
      prev = p;
    } else if (dir <= 0 && p >= prev + reversal) {
      lines.push({ open: start, close: prev, direction: -1 });
      start = prev;
      prev = p;
      dir = 1;
    } else if (dir >= 0 && p <= prev - reversal) {
      lines.push({ open: start, close: prev, direction: 1 });
      start = prev;
      prev = p;
      dir = -1;
    }
  }
  lines.push({ open: start, close: prev, direction: dir || 1 });
  return lines;
}

export function calculatePointFigure(prices, boxSize = 1, reversal = 3) {
  if (!prices || prices.length === 0) return null;
  const cols = [];
  let type = null;
  let top = prices[0];
  let bottom = prices[0];
  for (const price of prices) {
    if (type == null) {
      type = price >= prices[0] ? 'X' : 'O';
    }
    if (type === 'X') {
      if (price >= top + boxSize) {
        top = price;
      } else if (price <= top - boxSize * reversal) {
        cols.push({ type: 'X', high: top, low: bottom });
        type = 'O';
        bottom = price;
        top = price;
      }
    } else {
      if (price <= bottom - boxSize) {
        bottom = price;
      } else if (price >= bottom + boxSize * reversal) {
        cols.push({ type: 'O', high: top, low: bottom });
        type = 'X';
        top = price;
        bottom = price;
      }
    }
  }
  cols.push({ type, high: top, low: bottom });
  return cols;
}

export function calculateZigZag(prices, deviation = 5) {
  if (!prices || prices.length < 2) return null;
  const pts = [];
  let last = prices[0];
  let lastIdx = 0;
  let dir = null;
  for (let i = 1; i < prices.length; i++) {
    const p = prices[i];
    const change = ((p - last) / last) * 100;
    if (dir === null) {
      if (Math.abs(change) >= deviation) {
        dir = change > 0 ? 1 : -1;
        last = p;
        lastIdx = i;
        pts.push({ index: lastIdx, price: p });
      }
    } else if (dir === 1) {
      if (p > last) {
        last = p;
        lastIdx = i;
        pts[pts.length - 1] = { index: lastIdx, price: p };
      } else if (((last - p) / last) * 100 >= deviation) {
        dir = -1;
        last = p;
        lastIdx = i;
        pts.push({ index: lastIdx, price: p });
      }
    } else {
      if (p < last) {
        last = p;
        lastIdx = i;
        pts[pts.length - 1] = { index: lastIdx, price: p };
      } else if (((p - last) / last) * 100 >= deviation) {
        dir = 1;
        last = p;
        lastIdx = i;
        pts.push({ index: lastIdx, price: p });
      }
    }
  }
  return pts;
}

export function calculateMedianPrice(candle) {
  if (!candle) return null;
  return (candle.high + candle.low) / 2;
}

export function calculateTypicalPrice(candle) {
  if (!candle) return null;
  return (candle.high + candle.low + candle.close) / 3;
}

export function calculateWeightedClose(candle) {
  if (!candle) return null;
  return (candle.high + candle.low + 2 * candle.close) / 4;
}

export function calculateTTMSqueeze(
  candles,
  bbLength = 20,
  kcLength = 20,
  mult = 1.5
) {
  const closes = candles.map((c) => c.close);
  const bb = calculateBollingerBands(closes, bbLength, mult);
  const kc = calculateKeltnerChannels(candles, kcLength, mult, 1);
  if (!bb || !kc) return null;
  const squeezeOn = bb.upper <= kc.upper && bb.lower >= kc.lower;
  return { squeezeOn, width: bb.upper - bb.lower };
}

export function calculateZScore(prices, length = 20) {
  if (!prices || prices.length < length) return null;
  const slice = prices.slice(-length);
  const mean = slice.reduce((a, b) => a + b, 0) / length;
  const variance = slice.reduce((s, p) => s + (p - mean) ** 2, 0) / length;
  const sd = Math.sqrt(variance) || 1;
  return (prices.at(-1) - mean) / sd;
}

export function calculateElderImpulse(candles) {
  if (!candles || candles.length < 26) return null;
  const closes = candles.map((c) => c.close);
  const ema13 = calculateEMA(closes, 13);
  const ema26 = calculateEMA(closes, 26);
  const macd = calculateMACD(closes);
  if (!macd) return null;
  if (ema13 > ema26 && macd.histogram > 0) return 'Bullish';
  if (ema13 < ema26 && macd.histogram < 0) return 'Bearish';
  return 'Neutral';
}

export function calculateDonchianWidth(candles, length = 20) {
  const dc = calculateDonchianChannels(candles, length);
  if (!dc) return null;
  return (dc.upper - dc.lower) / (dc.middle || 1);
}

export function calculateIchimokuBaseLine(candles) {
  if (!candles || candles.length < 26) return null;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const high = Math.max(...highs.slice(-26));
  const low = Math.min(...lows.slice(-26));
  return (high + low) / 2;
}

export function calculateIchimokuConversionLine(candles) {
  if (!candles || candles.length < 9) return null;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const high = Math.max(...highs.slice(-9));
  const low = Math.min(...lows.slice(-9));
  return (high + low) / 2;
}

export function calculateAnchoredMomentum(candles, anchorIndex = 0) {
  if (!candles || candles.length === 0) return null;
  anchorIndex = Math.max(0, Math.min(anchorIndex, candles.length - 1));
  const anchor = candles[anchorIndex].close;
  const last = candles.at(-1).close;
  return ((last - anchor) / anchor) * 100;
}

export function calculateATRBands(candles, length = 14, mult = 2) {
  if (!candles || candles.length < length + 1) return null;
  const atr = getATR(candles, length);
  const close = candles.at(-1).close;
  return { upper: close + mult * atr, lower: close - mult * atr };
}

export function calculateDynamicStopLoss(candles, length = 14, mult = 3) {
  if (!candles || candles.length < length + 1) return null;
  const atr = getATR(candles, length);
  const close = candles.at(-1).close;
  return close - mult * atr;
}

export function calculateATRTrailingStop(candles, length = 14, mult = 3) {
  return calculateDynamicStopLoss(candles, length, mult);
}

export function calculateLaguerreRSI(prices, gamma = 0.5) {
  if (!prices || prices.length < 2) return null;
  let l0 = 0,
    l1 = 0,
    l2 = 0,
    l3 = 0;
  for (const p of prices) {
    const prevL0 = l0,
      prevL1 = l1,
      prevL2 = l2;
    l0 = (1 - gamma) * p + gamma * prevL0;
    l1 = -(1 - gamma) * l0 + prevL0 + gamma * prevL1;
    l2 = -(1 - gamma) * l1 + prevL1 + gamma * prevL2;
    l3 = -(1 - gamma) * l2 + prevL2 + gamma * l3;
  }
  const cu = (l0 - l1 > 0 ? l0 - l1 : 0) + (l1 - l2 > 0 ? l1 - l2 : 0) + (l2 - l3 > 0 ? l2 - l3 : 0);
  const cd = (l0 - l1 < 0 ? l1 - l0 : 0) + (l1 - l2 < 0 ? l2 - l1 : 0) + (l2 - l3 < 0 ? l3 - l2 : 0);
  if (cu + cd === 0) return 50;
  return (cu / (cu + cd)) * 100;
}

export const calculateRSILaguerre = calculateLaguerreRSI;

export function calculateTrendIntensityIndex(prices, length = 20) {
  if (!prices || prices.length < length) return null;
  const sma = calculateSMA(prices, length);
  let up = 0,
    sum = 0;
  for (let i = prices.length - length; i < prices.length; i++) {
    const diff = prices[i] - sma;
    if (diff > 0) up += diff;
    sum += Math.abs(diff);
  }
  return sum === 0 ? 0 : (up / sum) * 100;
}

export function calculateBollingerPB(prices, length = 20, mult = 2) {
  const bb = calculateBollingerBands(prices, length, mult);
  if (!bb) return null;
  return (prices.at(-1) - bb.lower) / (bb.upper - bb.lower);
}

export function calculateMACDHistogram(prices, shortL = 12, longL = 26, signalL = 9) {
  const res = calculateMACD(prices, shortL, longL, signalL);
  return res ? res.histogram : null;
}

export function calculateCoppockCurve(prices, r1 = 11, r2 = 14, wmaLen = 10) {
  if (!prices || prices.length < Math.max(r1, r2) + wmaLen) return null;
  const sum = [];
  for (let i = prices.length - wmaLen; i < prices.length; i++) {
    const r1v = ((prices[i] - prices[i - r1]) / prices[i - r1]) * 100;
    const r2v = ((prices[i] - prices[i - r2]) / prices[i - r2]) * 100;
    sum.push(r1v + r2v);
  }
  return calculateWMA(sum, wmaLen);
}

export function calculatePriceOscillator(prices, shortL = 12, longL = 26) {
  if (!prices || prices.length < longL) return null;
  const shortEma = calculateEMA(prices, shortL);
  const longEma = calculateEMA(prices, longL);
  return ((shortEma - longEma) / longEma) * 100;
}

export function calculateMcGinleyDynamic(prices, length = 10, k = 0.6) {
  if (!prices || prices.length === 0) return null;
  let md = prices[0];
  for (let i = 1; i < prices.length; i++) {
    md = md + (prices[i] - md) / (k * length * Math.pow(prices[i] / md, 4));
  }
  return md;
}

export function resetIndicatorCache() {
  emaCache.clear();
}

export function calculateEMASlope(prices, length = 21) {
  if (!prices || prices.length <= length) return 0;
  const prev = calculateEMA(prices.slice(0, -1), length);
  const curr = calculateEMA(prices, length);
  return curr - prev;
}

export function classifyVolatility(atr, price) {
  if (!atr || !price) return 'Medium';
  const ratio = atr / price;
  if (ratio > 0.05) return 'High';
  if (ratio < 0.02) return 'Low';
  return 'Medium';
}

export function computeFeatures(candles = []) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
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
  const emaSlope = calculateEMASlope(closes, 21);
  const trendStrength = adx ?? Math.abs((emaSlope / (ema21 || 1)) * 100);
  const volatilityClass = classifyVolatility(atr, closes.at(-1));
  const supertrend = calculateSupertrend(candles, 50);
  const vwap = calculateVWAP(candles);
  const pivot = calculatePivotPoints(candles);
  const fibRetracements = calculateFibonacciRetracements(Math.max(...highs), Math.min(...lows));
  const fibExtensions = calculateFibonacciExtensions(Math.max(...highs), Math.min(...lows));
  const psar = calculateParabolicSAR(candles);
  const heikinAshi = calculateHeikinAshi(candles);
  const renko = calculateRenko(candles);
  const kagi = calculateKagi(closes);
  const pointFigure = calculatePointFigure(closes);
  const zigzag = calculateZigZag(closes);
  const medianPrice = calculateMedianPrice(candles.at(-1));
  const typicalPrice = calculateTypicalPrice(candles.at(-1));
  const weightedClose = calculateWeightedClose(candles.at(-1));
  const anchoredVwap = calculateAnchoredVWAP(candles);
  const obv = calculateOBV(candles);
  const cmf = calculateCMF(candles);
  const mfi = calculateMFI(candles);
  const adl = calculateAccumDist(candles);
  const pvi = calculatePVI(candles);
  const nvi = calculateNVI(candles);
  const volOsc = calculateVolumeOscillator(volumes);
  const emv = calculateEMV(candles);
  const vpt = calculateVPT(candles);
  const volumeProfile = calculateVolumeProfile(candles);

  const ttmSqueeze = calculateTTMSqueeze(candles);
  const zScore = calculateZScore(closes);
  const elderImpulse = calculateElderImpulse(candles);
  const donchianWidth = calculateDonchianWidth(candles);
  const ichimokuBase = calculateIchimokuBaseLine(candles);
  const ichimokuConversion = calculateIchimokuConversionLine(candles);
  const anchoredMomentum = calculateAnchoredMomentum(candles);
  const atrBands = calculateATRBands(candles);
  const dynamicStop = calculateDynamicStopLoss(candles);
  const atrTrailingStop = calculateATRTrailingStop(candles);
  const laguerreRsi = calculateLaguerreRSI(closes);
  const rsiLaguerre = calculateRSILaguerre(closes);
  const trendIntensity = calculateTrendIntensityIndex(closes);
  const bollingerPB = calculateBollingerPB(closes);
  const macdHist = calculateMACDHistogram(closes);
  const coppock = calculateCoppockCurve(closes);
  const priceOsc = calculatePriceOscillator(closes);
  const mcGinley = calculateMcGinleyDynamic(closes);

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
    anchoredVwap,
    obv,
    cmf,
    mfi,
    adl,
    pvi,
    nvi,
    volOsc,
    emv,
    vpt,
    volumeProfile,
    ttmSqueeze,
    zScore,
    elderImpulse,
    donchianWidth,
    ichimokuBase,
    ichimokuConversion,
    anchoredMomentum,
    atrBands,
    dynamicStop,
    atrTrailingStop,
    laguerreRsi,
    rsiLaguerre,
    trendIntensity,
    bollingerPB,
    macdHist,
    coppock,
    priceOsc,
    mcGinley,
    emaSlope,
    trendStrength,
    volatilityClass,
    avgVolume,
    rvol,
    vwap,
    pivot,
    fibRetracements,
    fibExtensions,
    psar,
    heikinAshi,
    renko,
    kagi,
    pointFigure,
    zigzag,
    medianPrice,
    typicalPrice,
    weightedClose,
  };
}
