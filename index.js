// Index.js
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
  getAverageVolume,
  isMarketOpen,
  setStockSymbol,
  removeStockSymbol,
  initSession,
  fetchHistoricalIntradayData,
  getSupportResistanceLevels,
  rebuildThreeMinCandlesFromOneMin,
  resetInMemoryData,
  preloadStockData,
} from "./kite.js";
import { sendSignal } from "./telegram.js";
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

const app = express();
const server = http.createServer(app);

const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL) || 100000;

const allowedOrigins = [
  "https://scanner-app-fe.onrender.com",
  "http://localhost:5600",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "DELETE"],
    credentials: true,
  })
);

const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "DELETE"],
    credentials: true,
  },
});

app.use(express.json());

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
    console.error("❌ Error:", err.message);
    res.status(500).json({ error: "Failed to update symbols" });
  }
});

// GET STOCK SYMBOLS ENDPOINT
app.get("/stockSymbols", async (req, res) => {
  try {
    const stockSymbols = await db.collection("stock_symbols").findOne({});
    res.json(stockSymbols || { symbols: [] });
  } catch (err) {
    console.error("❌ Error fetching stock symbols:", err);
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
    console.error("❌ Error deleting stock symbol:", err);
    res.status(500).json({ error: "Failed to delete stock symbol" });
  }
});

// DELETE ALL THE COLLECTIONS EXCEPT THE instruments COLLECTIONS AND RECREATE THE COLLECTIONS WITH EMPTY DATA
app.delete("/reset", async (req, res) => {
  try {
    const collections = await db.collections();
    for (const collection of collections) {
      if (
        collection.collectionName !== "instruments" &&
        collection.collectionName !== "nifty50stocksymbols" &&
        collection.collectionName !== "nifty100qualitystocksymbols"
      ) {
        await collection.deleteMany({});
      }
    }
    // Recreate the stock_symbols collection with an empty array
    await db.collection("stock_symbols").deleteMany({});
    await db.collection("stock_symbols").insertOne({ symbols: [] });

    resetInMemoryData();
    res.json({ status: "success", message: "Collections reset successfully" });
  } catch (err) {
    console.error("❌ Error resetting collections:", err);
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
    console.error("❌ Error fetching signals:", err);
    res.status(500).json({ error: "Failed to fetch signals" });
  }
});

// 🔥 Enhanced endpoint to process candle data and emit signals
app.post("/candles", async (req, res) => {
  const body = req.body;
  const candles = Array.isArray(body) ? body : body.candles;
  const marketData = Array.isArray(body) ? null : body.marketData;
  const overrides = Array.isArray(body) ? null : body.overrides;

  if (!Array.isArray(candles) || candles.length === 0) {
    return res.status(400).json({ error: "No candles provided" });
  }

  if (overrides) supportUserOverrides(overrides);
  if (marketData) {
    detectMarketRegime(marketData);
    if (typeof marketData.vix === "number") applyVIXThresholds(marketData.vix);
    if (Array.isArray(marketData.events))
      handleEconomicEvents(marketData.events);
  }

  const token = candles[0]?.symbol || "UNKNOWN";
  const symbol = token; // Assuming symbol is sent as `symbol` in candles
  const avgVol = getAverageVolume(token, 20);

  // Temporary placeholders — real-time values can be optionally passed later
  const depth = null;
  const totalBuy = 0;
  const totalSell = 0;
  const slippage = 0.1;
  const spread = 0.5;
  const liquidity = avgVol || 5000; // fallback

  const liveTick = null;

  try {
    const signal = await analyzeCandles(
      candles,
      symbol,
      depth,
      totalBuy,
      totalSell,
      slippage,
      spread,
      liquidity,
      liveTick
    );

    if (signal) {
      const tradeValue = signal.entry * (signal.qty || 1);
      const allowed =
        preventReEntry(symbol) &&
        checkExposureLimits({
          symbol,
          tradeValue,
          sector: signal.sector || "GEN",
          totalCapital: TOTAL_CAPITAL,
        }) &&
        resolveSignalConflicts({
          symbol,
          side: signal.direction === "Long" ? "long" : "short",
          strategy: signal.pattern,
        });

      if (!allowed) {
        notifyExposureEvents(
          `Signal for ${symbol} rejected by portfolio rules`
        );
      } else {
        console.log("🚀 Emitting tradeSignal:", signal);
        io.emit("tradeSignal", signal);
        sendSignal(signal); // Send signal to Telegram
        addSignal(signal);
        logSignalCreated(signal, {
          vix: marketContext.vix,
          regime: marketContext.regime,
          breadth: marketContext.breadth,
        });
        fetchAIData(signal)
          .then((ai) => {
            signal.ai = ai;
          })
          .catch((err) => console.error("AI enrichment", err));
      }
    } else {
      console.log("ℹ️ No signal generated for:", symbol);
    }

    res.json({ status: "Processed", signal: signal || null });
  } catch (err) {
    console.error("❌ Error processing candles:", err);
    res.status(500).json({ error: "Signal generation failed" });
  }
});

app.get("/signal-history", (req, res) => {
  res.json(getSignalHistory());
});

app.post("/subscribe", (req, res) => {
  const { tokens } = req.body;
  if (Array.isArray(tokens) && tokens.length > 0) {
    updateInstrumentTokens(tokens);
    res.json({ status: "Subscribed", tokens });
  } else {
    res.status(400).json({ error: "Invalid tokens" });
  }
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
    console.error("❌ Intraday fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch intraday data" });
  }
});

app.get("/support-resistance/:symbol", (req, res) => {
  const { symbol } = req.params;
  if (!symbol) return res.status(400).json({ error: "Missing symbol" });
  try {
    const levels = getSupportResistanceLevels(symbol);
    res.json({ status: "success", ...levels });
  } catch (err) {
    console.error("❌ Support/resistance error:", err.message);
    res.status(500).json({ error: "Failed to compute levels" });
  }
});

app.get("/rebuild-3min/:token", async (req, res) => {
  const { token } = req.params;
  try {
    const candles = await rebuildThreeMinCandlesFromOneMin(token);
    res.json({ status: "success", candles });
  } catch (err) {
    console.error("❌ 3m rebuild error:", err.message);
    res.status(500).json({ error: "Failed to rebuild candles" });
  }
});

app.get("/kite-redirect", async (req, res) => {
  const requestToken = req.query.request_token;

  if (!requestToken) {
    // return res.status(400).send("Missing request token");
    return res.status(400).json({ error: "Missing request_token" });
  }

  // ✅ Save the request_token in DB with type
  await db
    .collection("tokens")
    .updateOne(
      { type: "kite_session" },
      { $set: { request_token: requestToken, type: "kite_session" } },
      { upsert: true }
    );

  // ✅ Optionally generate session here
  const session = await initSession();

  if (session) {
    return res.send("✅ Login Successful, session created.");
  } else {
    return res.send("⚠️ Login saved, but session creation failed.");
  }
});

io.on("connection", (socket) => {
  console.log("✅ Client connected:", socket.id);
  socket.emit("serverMessage", "Connected to backend.");
});

server.listen(3000, () => {
  console.log("📡 Backend running on port 3000");

  if (isMarketOpen()) {
    console.log("✅ Market is open. Starting live feed...");
    startLiveFeed(io);
  } else {
    console.log("⏸ Market is closed. Skipping live feed start.");
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
});
