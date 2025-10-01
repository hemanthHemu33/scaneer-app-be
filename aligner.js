import db from "./db.js";
import { canonToken } from "./canon.js";
import { logError } from "./logger.js";
import { incrementMetric } from "./metrics.js";

const MINUTE_MS = 60 * 1000;
export const WATERMARK_MS = 3000;

const openBuckets = new Map(); // token -> Map(minuteMs -> bucket)
const finalizedCandles = [];

function ensureTokenBuckets(token) {
  const tokenStr = canonToken(token);
  if (!openBuckets.has(tokenStr)) {
    openBuckets.set(tokenStr, new Map());
  }
  return openBuckets.get(tokenStr);
}

function getMinuteStart(timestamp) {
  const ts = timestamp ? new Date(timestamp) : new Date();
  const minute = new Date(ts);
  minute.setSeconds(0, 0);
  return minute.getTime();
}

function formatMinuteIST(minuteMs) {
  return (
    new Date(minuteMs)
      .toLocaleString("en-CA", {
        timeZone: "Asia/Kolkata",
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
      .replace(", ", "T") + ":00"
  );
}

function getSessionDate(minuteMs) {
  const d = new Date(minuteMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function finalizeBucket(bucket) {
  if (!bucket || !bucket.ticks.length) return;
  const { token, symbol, minuteMs } = bucket;
  const prices = bucket.ticks
    .map((tick) => Number(tick.last_price))
    .filter((price) => Number.isFinite(price));
  if (!prices.length) return;

  const open = prices[0];
  const close = prices[prices.length - 1];
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const volume = bucket.ticks.reduce((sum, tick) => {
    const qty = Number(
      tick.last_traded_quantity ?? tick.volume ?? tick.volume_traded ?? 0
    );
    if (!Number.isFinite(qty)) return sum;
    return sum + qty;
  }, 0);
  const trades = bucket.ticks.length;
  const minuteDate = new Date(minuteMs);

  finalizedCandles.push({
    token: Number(token),
    tokenStr: token,
    symbol,
    minute: minuteDate,
    minuteIST: formatMinuteIST(minuteMs),
    session: getSessionDate(minuteMs),
    open,
    high,
    low,
    close,
    volume,
    trades,
    tickCount: bucket.ticks.length,
    lastTick: bucket.ticks[bucket.ticks.length - 1],
    createdAt: new Date(),
  });
  incrementMetric("candles1mFormed");
}

function finalizeBucketsUntil(cutoffMs) {
  for (const [token, buckets] of openBuckets.entries()) {
    for (const [minuteMs, bucket] of buckets.entries()) {
      if (minuteMs <= cutoffMs) {
        finalizeBucket(bucket);
        buckets.delete(minuteMs);
      }
    }
    if (buckets.size === 0) {
      openBuckets.delete(token);
    }
  }
}

function finalizeReadyBuckets(nowMs = Date.now()) {
  const cutoff = nowMs - WATERMARK_MS - MINUTE_MS;
  for (const [token, buckets] of openBuckets.entries()) {
    for (const [minuteMs, bucket] of buckets.entries()) {
      if (minuteMs <= cutoff) {
        finalizeBucket(bucket);
        buckets.delete(minuteMs);
      }
    }
    if (buckets.size === 0) {
      openBuckets.delete(token);
    }
  }
}

export function ingestTick({ token, symbol, tick }) {
  const tokenStr = canonToken(token);
  if (!tokenStr || !symbol) return;
  const ts = tick.timestamp || tick.last_trade_time || Date.now();
  const minuteMs = getMinuteStart(ts);
  const buckets = ensureTokenBuckets(tokenStr);
  if (!buckets.has(minuteMs)) {
    buckets.set(minuteMs, {
      token: tokenStr,
      symbol,
      minuteMs,
      ticks: [],
    });
  }
  const bucket = buckets.get(minuteMs);
  bucket.ticks.push(tick);
  bucket.lastSeen = Date.now();
  finalizeReadyBuckets(Date.now());
}

export async function persistAlignedCandleBatch() {
  if (!finalizedCandles.length) return;
  const toPersist = finalizedCandles.splice(0);
  const alignedOps = toPersist.map((doc) => ({
    updateOne: {
      filter: { token: doc.token, minute: doc.minute },
      update: {
        $set: {
          token: doc.token,
          symbol: doc.symbol,
          minute: doc.minute,
          minuteIST: doc.minuteIST,
          session: doc.session,
          open: doc.open,
          high: doc.high,
          low: doc.low,
          close: doc.close,
          volume: doc.volume,
          trades: doc.trades,
          tickCount: doc.tickCount,
          lastTick: doc.lastTick,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: doc.createdAt },
      },
      upsert: true,
    },
  }));

  const sessionOps = toPersist.map((doc) => ({
    updateOne: {
      filter: { token: doc.token, ts: doc.minute },
      update: {
        $set: {
          token: doc.token,
          symbol: doc.symbol,
          ts: doc.minute,
          minute: doc.minuteIST,
          session: doc.session,
          open: doc.open,
          high: doc.high,
          low: doc.low,
          close: doc.close,
          volume: doc.volume,
          trades: doc.trades,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: doc.createdAt },
      },
      upsert: true,
    },
  }));

  try {
    if (alignedOps.length) {
      await db.collection("aligned_ticks").bulkWrite(alignedOps, { ordered: false });
    }
    if (sessionOps.length) {
      await db.collection("session_data").bulkWrite(sessionOps, { ordered: false });
    }
  } catch (err) {
    logError("aligner.persistAlignedCandleBatch", err);
  }
}

export async function flushOpenCandles({ force = false } = {}) {
  if (force) {
    finalizeBucketsUntil(Number.POSITIVE_INFINITY);
  } else {
    finalizeReadyBuckets(Date.now());
  }
  await persistAlignedCandleBatch();
}

export async function finalizeEOD(reference = new Date()) {
  const eod = new Date(reference);
  eod.setHours(15, 30, 0, 0);
  finalizeBucketsUntil(eod.getTime());
  await persistAlignedCandleBatch();
}

export function getOpenBucketsSnapshot() {
  const snapshot = [];
  for (const [token, buckets] of openBuckets.entries()) {
    for (const bucket of buckets.values()) {
      snapshot.push({ token, minute: new Date(bucket.minuteMs), ticks: bucket.ticks.length });
    }
  }
  return snapshot;
}
