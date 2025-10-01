// candleCache.js
import db from "./db.js";
export const candleHistory = {};
const loaders = {};

// One cap to rule them all (import this in other files)
export const HISTORY_CAP = Number(process.env.HISTORY_CAP) || 300;

function toDateSafe(v) {
  if (v instanceof Date) return v;
  const d = new Date(v);
  if (!Number.isNaN(+d)) return d;
  // fallback for strings like "YYYY-MM-DDTHH:MM:00"
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    const d2 = new Date(v.replace(" ", "T"));
    if (!Number.isNaN(+d2)) return d2;
  }
  return new Date(); // last resort (shouldn't happen often)
}

function minuteKey(ts) {
  const d = new Date(toDateSafe(ts));
  d.setSeconds(0, 0);
  return d.getTime();
}

function normalizeCandle(c) {
  const ts = c.timestamp ?? c.date ?? c.ts ?? c.minute ?? Date.now();
  return {
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume) || 0,
    timestamp: toDateSafe(ts),
  };
}

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

      const raw = doc?.candles || doc?.data || [];
      // normalize, dedupe-by-minute, sort asc, cap
      const mapByMin = new Map();
      for (const r of raw) {
        const c = normalizeCandle({ ...r, timestamp: r.date ?? r.timestamp });
        mapByMin.set(minuteKey(c.timestamp), c);
      }
      const arr = Array.from(mapByMin.values()).sort(
        (a, b) => +a.timestamp - +b.timestamp
      );
      candleHistory[tokenStr] =
        arr.length > HISTORY_CAP ? arr.slice(-HISTORY_CAP) : arr;

      delete loaders[tokenStr];
      return candleHistory[tokenStr];
    })();
  }
  return loaders[tokenStr];
}

// Upsert one candle (by minute), keep sorted, trim to cap
export function pushCandle(token, candle, max = HISTORY_CAP) {
  const tokenStr = String(token);
  const c = normalizeCandle(candle);
  const key = minuteKey(c.timestamp);

  const arr = candleHistory[tokenStr] || (candleHistory[tokenStr] = []);
  const n = arr.length;

  // Fast path: replace last if same minute
  if (n && minuteKey(arr[n - 1].timestamp) === key) {
    arr[n - 1] = c;
  } else {
    // Check if minute exists somewhere (late finalizer)
    let idx = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (minuteKey(arr[i].timestamp) === key) {
        idx = i;
        break;
      }
      if (+arr[i].timestamp < +c.timestamp) break; // small shortcut
    }
    if (idx >= 0) {
      arr[idx] = c;
    } else if (!n || +arr[n - 1].timestamp <= +c.timestamp) {
      arr.push(c);
    } else {
      // Insert keeping ascending time order
      let i = n - 1;
      while (i >= 0 && +arr[i].timestamp > +c.timestamp) i--;
      arr.splice(i + 1, 0, c);
    }
  }

  if (arr.length > max) {
    candleHistory[tokenStr] = arr.slice(-max);
  }
  return candleHistory[tokenStr];
}

export function pushCandles(token, candles, max = HISTORY_CAP) {
  for (const c of candles || []) {
    pushCandle(token, c, max);
  }
  return candleHistory[String(token)];
}

export function clearCandleHistory() {
  for (const token in candleHistory) delete candleHistory[token];
}

export async function preloadCandleHistory(tokens) {
  const query =
    tokens && tokens.length ? { token: { $in: tokens.map(Number) } } : {};
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
        timestamp: c.date ?? c.timestamp,
      })),
      HISTORY_CAP
    );
  }
}
