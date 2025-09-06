import db from "./db.js";

export const candleHistory = {};
const loaders = {};
const MAX_CANDLES = 300;

export function getCandleHistory(token) {
  return candleHistory[String(token)] || [];
}

export async function ensureCandleHistory(token) {
  const tokenStr = String(token);
  if (candleHistory[tokenStr] && candleHistory[tokenStr].length) {
    return candleHistory[tokenStr];
  }
  if (!loaders[tokenStr]) {
    loaders[tokenStr] = (async () => {
      const doc = await db
        .collection("historical_session_data")
        .findOne({ token: Number(tokenStr) });
      const data = doc?.candles || doc?.data || [];
      candleHistory[tokenStr] = data.map((c) => ({
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        timestamp: new Date(c.date),
      }));
      candleHistory[tokenStr] = candleHistory[tokenStr].slice(-MAX_CANDLES);
      delete loaders[tokenStr];
      return candleHistory[tokenStr];
    })();
  }
  return loaders[tokenStr];
}

export function pushCandle(token, candle, max = MAX_CANDLES) {
  const tokenStr = String(token);
  if (!candleHistory[tokenStr]) candleHistory[tokenStr] = [];
  candleHistory[tokenStr].push(candle);
  if (candleHistory[tokenStr].length > max) {
    candleHistory[tokenStr] = candleHistory[tokenStr].slice(-max);
  }
  return candleHistory[tokenStr];
}

export function pushCandles(token, candles, max = MAX_CANDLES) {
  const tokenStr = String(token);
  if (!candleHistory[tokenStr]) candleHistory[tokenStr] = [];
  candleHistory[tokenStr].push(...candles);
  if (candleHistory[tokenStr].length > max) {
    candleHistory[tokenStr] = candleHistory[tokenStr].slice(-max);
  }
  return candleHistory[tokenStr];
}

export function clearCandleHistory() {
  for (const token in candleHistory) delete candleHistory[token];
}

export async function preloadCandleHistory(tokens) {
  const query = tokens && tokens.length ? { token: { $in: tokens.map(Number) } } : {};
  const docs = await db
    .collection("historical_session_data")
    .find(query)
    .toArray();
  for (const doc of docs) {
    const tokenStr = String(doc.token);
    const data = doc.candles || doc.data || [];
    pushCandles(
      tokenStr,
      data.map((c) => ({
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        timestamp: new Date(c.date),
      })),
      MAX_CANDLES
    );
  }
}
