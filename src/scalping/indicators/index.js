/** Simple EMA helper returning the last EMA value. */
export function ema(values, period) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const k = 2 / (period + 1);
  return values.reduce((prev, curr, idx) => {
    if (idx === 0 || prev === null) return curr;
    return curr * k + prev * (1 - k);
  }, null);
}

export function vwapFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  let totalVolume = 0;
  let totalPV = 0;
  for (const c of candles) {
    const volume = c.volume ?? 0;
    const typicalPrice = (c.high + c.low + c.close) / 3;
    totalVolume += volume;
    totalPV += typicalPrice * volume;
  }
  return totalVolume > 0 ? totalPV / totalVolume : null;
}

export function slope(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  const first = values[0];
  const last = values[values.length - 1];
  return last - first;
}

export function averageTrueRange(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const sliced = candles.slice(-period - 1);
  const trs = [];
  for (let i = 1; i < sliced.length; i++) {
    const prev = sliced[i - 1];
    const cur = sliced[i];
    const highLow = cur.high - cur.low;
    const highClose = Math.abs(cur.high - prev.close);
    const lowClose = Math.abs(cur.low - prev.close);
    trs.push(Math.max(highLow, highClose, lowClose));
  }
  const k = 1 / trs.length;
  return trs.reduce((sum, v) => sum + v * k, 0);
}
