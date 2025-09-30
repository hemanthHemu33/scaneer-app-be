// Index.js
import "./env.js";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { analyzeCandles, getSignalHistory } from "./scanner.js";
import cron from "node-cron";
import {
  startLiveFeed,
  updateInstrumentTokens,
  setTickInterval,
  isMarketOpen,
  isLiveFeedRunning,
  setStockSymbol,
  removeStockSymbol,
  initSession,
  fetchHistoricalIntradayData,
  getSupportResistanceLevels,
  rebuildThreeMinCandlesFromOneMin,
  resetDatabase,
  preloadStockData,
  kc,
  tickBuffer,
  lastTickTs,
  getInstrumentTokenCount,
} from "./kite.js";
import { createLiveFeedMonitor } from "./liveFeedMonitor.js";
import {
  trackOpenPositions,
  checkExposureLimits,
  preventReEntry,
  resolveSignalConflicts,
  notifyExposureEvents,
} from "./portfolioContext.js";
import { fetchAIData } from "./openAI.js";
import db from "./db.js";
import { Console } from "console";
import { addSignal } from "./signalManager.js";
import { logSignalCreated } from "./auditLogger.js";
import {
  detectMarketRegime,
  applyVIXThresholds,
  handleEconomicEvents,
  supportUserOverrides,
  marketContext,
} from "./smartStrategySelector.js";
import { selectTopSignal } from "./signalRanker.js";
import { logTrade } from "./tradeLogger.js";
import { logError } from "./logger.js";

const apiSecret = process.env.KITE_API_SECRET;

const app = express();
const server = http.createServer(app);

// const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL) || 100000;

const allowedOrigins = [
  "https://scanner-app-fe.onrender.com",
  "http://localhost:5600",
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "DELETE"],
  credentials: true,
};

app.use(cors(corsOptions));

const io = new Server(server, { cors: corsOptions });

app.use(express.json());

const liveFeedMonitor = createLiveFeedMonitor({
  isMarketOpen,
  isLiveFeedRunning,
  startLiveFeed,
  logger: console,
});

let shuttingDown = false;

const stopLiveFeedMonitor = () => {
  liveFeedMonitor.stop();
};

const handleShutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopLiveFeedMonitor();
  if (server.listening) {
    server.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
  const exitTimer = setTimeout(() => process.exit(0), 1000);
  exitTimer.unref?.();
};

process.once("SIGINT", handleShutdown);
process.once("SIGTERM", handleShutdown);
process.once("beforeExit", stopLiveFeedMonitor);
server.on("close", stopLiveFeedMonitor);

async function ensureUniverseSeeded(db) {
  const col = db.collection("stock_symbols");
  let doc = await col.findOne({});

  if (!doc) {
    await col.insertOne({ symbols: [] });
    console.log("🌱 Initialized stock_symbols with empty list");
    doc = { symbols: [] };
  } else if (!Array.isArray(doc.symbols)) {
    await col.updateOne({}, { $set: { symbols: [] } });
    console.log("🌱 Reset stock_symbols to empty list");
    doc = { symbols: [] };
  }

  if (!doc?.symbols?.length) {
    console.warn(
      "⚠️ Universe empty — no symbols attached; add them from the frontend."
    );
  } else {
    console.log("✅ Universe present:", doc.symbols.length, "symbols");
  }
}

app.get("/health", async (req, res) => {
  const doc = await db.collection("stock_symbols").findOne({});
  const subscribedCount = Object.keys(tickBuffer).length;
  const instrumentTokenCount = getInstrumentTokenCount();
  res.json({
    session: Boolean(kc._access_token),
    marketOpen: isMarketOpen(),
    universeCount: doc?.symbols?.length || 0,
    subscribedCount,
    instrumentTokenCount,
    lastTickTs,
  });
});

// ADD STOCK SYMBOLS ENDPOINT
app.post("/addStockSymbol", async (req, res) => {
  const { symbol } = req.body;
  if (!symbol || typeof symbol !== "string") {
    return res.status(400).json({ error: "Invalid symbol" });
  }
  try {
    await setStockSymbol(`NSE:${symbol}`);
    const updated = await db.collection("stock_symbols").findOne({});
    res.json({ status: "success", symbols: updated?.symbols || [] });
  } catch (err) {
    logError("update symbols", err);
    res.status(500).json({ error: "Failed to update symbols" });
  }
});

const allowDebugFeedControls = process.env.NODE_ENV !== "production";

app.post("/_debug/start-feed", (req, res) => {
  if (!allowDebugFeedControls) {
    return res.status(403).json({ error: "Debug feed controls disabled" });
  }
  if (!kc._access_token) {
    return res.status(400).json({ error: "No Kite session" });
  }
  if (isLiveFeedRunning()) {
    return res.json({ status: "already running" });
  }
  startLiveFeed(io);
  res.json({ status: "started" });
});

app.post("/_debug/stop-feed", (req, res) => {
  if (!allowDebugFeedControls) {
    return res.status(403).json({ error: "Debug feed controls disabled" });
  }
  res.json({ status: "noop (implement if needed)" });
});

// GET STOCK SYMBOLS ENDPOINT
app.get("/stockSymbols", async (req, res) => {
  try {
    const stockSymbols = await db.collection("stock_symbols").findOne({});
    res.json(stockSymbols || { symbols: [] });
  } catch (err) {
    logError("fetching stock symbols", err);
    res.status(500).json({ error: "Failed to fetch stock symbols" });
  }
});

// DELETE stock symbol and its historical data
app.delete("/stockSymbols/:symbol", async (req, res) => {
  const { symbol } = req.params;
  if (!symbol || typeof symbol !== "string") {
    return res.status(400).json({ error: "Invalid stock symbol" });
  }

  try {
    await removeStockSymbol(symbol);
    res.json({
      status: "success",
      deletedSymbol: symbol.includes(":") ? symbol : `NSE:${symbol}`,
    });
  } catch (err) {
    logError("delete stock symbol", err);
    res.status(500).json({ error: "Failed to delete stock symbol" });
  }
});

// DELETE ALL THE COLLECTIONS EXCEPT THE instruments COLLECTIONS AND RECREATE THE COLLECTIONS WITH EMPTY DATA
app.delete("/reset", async (req, res) => {
  try {
    const result = await resetDatabase();
    res.json(result);
  } catch (err) {
    logError("reset collections", err);
    res.status(500).json({ error: "Failed to reset collections" });
  }
});

// GET SIGNALS ENDPOINT
app.get("/signals", async (req, res) => {
  try {
    const signals = await db
      .collection("signals")
      .find({})
      .sort({ generatedAt: -1 })
      .toArray();
    // res.json(signals);
    res.json({ status: "success", signals: signals });
  } catch (err) {
    logError("fetching signals", err);
    res.status(500).json({ error: "Failed to fetch signals" });
  }
});

app.get("/signal-history", (req, res) => {
  res.json(getSignalHistory());
});

app.post("/set-interval", (req, res) => {
  const { interval } = req.body;
  if (typeof interval === "number" && interval > 0) {
    setTickInterval(interval);
    res.json({ status: "Interval updated", interval });
  } else {
    res.status(400).json({ error: "Invalid interval" });
  }
});

// Trigger historical intraday data fetch
app.post("/fetch-intraday-data", async (req, res) => {
  const { interval = "minute", days = 3 } = req.body || {};
  try {
    await fetchHistoricalIntradayData(interval, days);
    res.json({ status: "success" });
  } catch (err) {
    logError("intraday fetch", err);
    res.status(500).json({ error: "Failed to fetch intraday data" });
  }
});

app.get("/kite-redirect", async (req, res) => {
  const requestToken = req.query.request_token;

  if (!requestToken) {
    return res.status(400).json({ error: "Missing request_token" });
  }

  try {
    const session = await kc.generateSession(requestToken, apiSecret);
    kc.setAccessToken(session.access_token);

    await db.collection("tokens").updateOne(
      { type: "kite_session" },
      {
        $set: {
          ...session,
          request_token: requestToken,
          type: "kite_session",
        },
      },
      { upsert: true }
    );
    if (isMarketOpen() && !isLiveFeedRunning()) {
      startLiveFeed(io);
    } else if (isMarketOpen()) {
      console.log("ℹ️ Live feed already running; skipping duplicate start.");
    }
    return res.send("✅ Login successful, session created.");
  } catch (err) {
    logError("kite redirect", err);
    return res.status(500).json({ error: "Login failed" });
  }
});

io.on("connection", (socket) => {
  console.log("✅ Client connected:", socket.id);
  socket.emit("serverMessage", "Connected to backend.");
});

server.listen(3000, async () => {
  console.log("📡 Backend running on port 3000");

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

  cron.schedule(
    "30 8 * * 1-5",
    () => {
      preloadStockData();
    },
    { timezone: "Asia/Kolkata" }
  );

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes >= 510 && minutes <= 540) {
    preloadStockData();
  }

  liveFeedMonitor.evaluate(io);
  liveFeedMonitor.start(io);
});
