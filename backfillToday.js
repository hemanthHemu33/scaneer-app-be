import "./env.js";
import db from "./db.js";
import { ensureLoad as ensureInstrumentMap, tokenSymbolMap } from "./mapping.js";
import { fallbackFetch } from "./fallbackFetcher.js";
import { canonToken } from "./canon.js";
import { ingestTick as ingestAlignedTick, flushOpenCandles } from "./aligner.js";
import { logError } from "./logger.js";

function getSessionRange() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(9, 15, 0, 0);
  const end = new Date(now);
  end.setHours(15, 31, 0, 0);
  return { start, end };
}

function formatMinute(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:00`;
}

function formatSession(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function rebuildSessionData(start, end) {
  const docs = await db
    .collection("aligned_ticks")
    .find({ minute: { $gte: start, $lt: end } })
    .toArray();

  if (!docs.length) {
    console.log("⚠️ No aligned ticks found for today. Skipping session rebuild.");
    return;
  }

  const ops = docs.map((doc) => {
    const minute = new Date(doc.minute);
    return {
      updateOne: {
        filter: { token: doc.token, ts: minute },
        update: {
          $set: {
            token: doc.token,
            symbol: doc.symbol,
            ts: minute,
            minute: formatMinute(minute),
            session: formatSession(minute),
            open: doc.open,
            high: doc.high,
            low: doc.low,
            close: doc.close,
            volume: doc.volume,
            trades: doc.trades || 0,
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        upsert: true,
      },
    };
  });

  await db.collection("session_data").bulkWrite(ops, { ordered: false });
  console.log(`✅ Rebuilt session_data with ${docs.length} candles.`);
}

async function backfillToday() {
  const { start, end } = getSessionRange();
  await ensureInstrumentMap(db);

  const cursor = db
    .collection("tick_data")
    .find({ timestamp: { $gte: start, $lt: end } })
    .sort({ timestamp: 1 });

  let processed = 0;

  try {
    for await (const tick of cursor) {
      const tokenStr = canonToken(tick.instrument_token || tick.token);
      if (!tokenStr) continue;
      let symbol = tokenSymbolMap.get(tokenStr);
      if (!symbol) {
        try {
          const resolved = await fallbackFetch(tokenStr, null, db);
          symbol = resolved?.symbol;
        } catch (err) {
          logError("backfill.resolve", err, { token: tokenStr });
        }
      }
      if (!symbol) continue;
      ingestAlignedTick({ token: tokenStr, symbol, tick });
      processed += 1;
    }

    await flushOpenCandles({ force: true });
    console.log(`✅ Ingested ${processed} ticks into aligner.`);
    await rebuildSessionData(start, end);
  } catch (err) {
    logError("backfillToday", err);
  }
}

backfillToday()
  .then(() => {
    console.log("✅ Backfill complete");
    process.exit(0);
  })
  .catch((err) => {
    logError("backfillToday.main", err);
    process.exit(1);
  });
