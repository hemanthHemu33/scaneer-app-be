import cron from "node-cron";
import db from "../db.js";
import { logError } from "../logger.js";
import {
  startLiveFeed,
  isMarketOpen,
  isLiveFeedRunning,
  initSession,
  preloadStockData,
} from "../kite.js";
import { trackOpenPositions } from "../portfolioContext.js";
import { createLiveFeedMonitor } from "../../liveFeedMonitor.js";

async function ensureUniverseSeeded(db) {
  const col = db.collection("stock_symbols");
  const doc = await col.findOne({});
  if (!doc || !Array.isArray(doc.symbols) || doc.symbols.length === 0) {
    const seed = ["RELIANCE", "HDFCBANK", "INFY"];
    await col.updateOne({}, { $set: { symbols: seed } }, { upsert: true });
    console.log("🌱 Seeded stock_symbols with defaults:", seed);
  } else {
    console.log("✅ Universe present:", doc.symbols.length, "symbols");
  }
}

const liveFeedMonitor = createLiveFeedMonitor({
  isMarketOpen,
  isLiveFeedRunning,
  startLiveFeed,
  logger: console,
});

export async function runStartup(io) {
  try {
    await ensureUniverseSeeded(db);

    const token = await initSession();
    if (!token) {
      console.warn("⚠️ No Kite session; live feed will not start.");
    } else if (isMarketOpen()) {
      if (!isLiveFeedRunning()) {
        console.log("🕒 Market open; starting live feed…");
        startLiveFeed(io);
      } else {
        console.log("🟢 Market open; live feed already running.");
      }
    } else {
      console.log("⛔ Market closed: not starting live feed.");
    }
  } catch (e) {
    logError("server.listen init", e);
  }

  if (process.env.NODE_ENV !== "test") {
    const dummyBroker = { getPositions: async () => [] };
    trackOpenPositions(dummyBroker);
    setInterval(() => trackOpenPositions(dummyBroker), 60 * 1000);
  }

  cron.schedule("30 8 * * 1-5", () => preloadStockData(), {
    timezone: "Asia/Kolkata",
  });

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes >= 510 && minutes <= 540) preloadStockData();

  liveFeedMonitor.evaluate(io);
  liveFeedMonitor.start(io);
}

export function stopLiveFeedMonitor() {
  liveFeedMonitor.stop();
}
