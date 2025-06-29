// Index.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { analyzeCandles, getSignalHistory } from "./scanner.js";
import {
  startLiveFeed,
  updateInstrumentTokens,
  setTickInterval,
  getAverageVolume,
  isMarketOpen,
  setStockSymbol,
  initSession,
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
    const existingSymbols = await db.collection("stock_symbols").findOne({});
    if (!existingSymbols) {
      // ADD SYMBOLS WITH NSE PREFIX
      await setStockSymbol(`NSE:${symbol}`);
      await db
        .collection("stock_symbols")
        .insertOne({ symbols: [`NSE:${symbol}`] });
    } else {
      await db
        .collection("stock_symbols")
        .updateOne({}, { $addToSet: { symbols: `NSE:${symbol}` } });
    }
    const updated = await db.collection("stock_symbols").findOne({});
    res.json({ status: "success", symbols: updated.symbols }); // ⬅ send updated list
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

  // ✅ Extract actual tradingsymbol (remove "NSE:" prefix if present)
  const cleanedSymbol = symbol.includes(":") ? symbol.split(":")[1] : symbol;

  try {
    // Step 1: Remove from stock_symbols list
    const result = await db
      .collection("stock_symbols")
      .updateOne(
        {},
        { $pull: { symbols: `NSE:${cleanedSymbol}` } },
        { upsert: true }
      );

    // Step 2: Find instrument using cleaned symbol
    const instrument = await db
      .collection("instruments")
      .findOne({ tradingsymbol: cleanedSymbol, exchange: "NSE" });

    console.log("Trying to delete symbol:", symbol);
    console.log("Cleaned symbol for lookup:", cleanedSymbol);
    console.log("Instrument found:", instrument);

    // Step 3: If instrument found, delete historical data
    if (instrument && instrument.instrument_token) {
      const instrumentToken = String(instrument.instrument_token);
      const deleteResult = await db
        .collection("historical_data")
        .updateOne({}, { $unset: { [instrumentToken]: "" } });
      //  delete the session_data for that instrument token
      const deleteSessionResult = await db
        .collection("session_data")
        .updateOne({}, { $unset: { [instrumentToken]: "" } });
      // Log the deletion result
      console.log(
        `🗑️ Deleted historical data for instrument "${cleanedSymbol}":`,
        deleteResult.modifiedCount
      );
      console.log(
        `📉 Removed token "${instrumentToken}" from historical_data:`,
        deleteResult.modifiedCount
      );
    } else {
      console.warn(
        `❗Instrument not found for symbol "${cleanedSymbol}" on NSE`
      );
    }

    // Step 4: Final response
    if (result.modifiedCount > 0) {
      console.log(`🗑️ Stock symbol "${cleanedSymbol}" deleted successfully.`);
      res.json({ status: "success", deletedSymbol: `NSE:${cleanedSymbol}` });
    } else {
      res.status(404).json({ error: "Stock symbol not found in list" });
    }
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
    if (Array.isArray(marketData.events)) handleEconomicEvents(marketData.events);
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
        notifyExposureEvents(`Signal for ${symbol} rejected by portfolio rules`);
      } else {
        console.log("🚀 Emitting tradeSignal:", signal);
        io.emit("tradeSignal", signal);
        sendSignal(signal); // Send signal to Telegram
        addSignal(signal);
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

  if (process.env.NODE_ENV !== 'test') {
    const dummyBroker = { getPositions: async () => [] };
    trackOpenPositions(dummyBroker);
    setInterval(() => trackOpenPositions(dummyBroker), 60 * 1000);
  }
});
