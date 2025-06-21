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
} from "./kite.js";

import db from "./db.js";

const app = express();
app.use(
  cors({
    origin: "https://scanner-app-fe.onrender.com",
    methods: ["GET", "POST"],
    credentials: true,
  })
);
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "https://scanner-app-fe.onrender.com",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// 🔥 Enhanced endpoint to process candle data and emit signals
app.post("/candles", async (req, res) => {
  const candles = req.body;

  if (!Array.isArray(candles) || candles.length === 0) {
    return res.status(400).json({ error: "No candles provided" });
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
      console.log("🚀 Emitting tradeSignal:", signal);
      io.emit("tradeSignal", signal);
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
    return res.status(400).json({ error: "Missing request_token" });
  }
  await db.collection("tokens").updateOne(
    {},
    { $set: { request_token: requestToken } },
    { upsert: true }
  );
  res.json({ status: "Request token saved" });
});

io.on("connection", (socket) => {
  console.log("✅ Client connected:", socket.id);
  socket.emit("serverMessage", "Connected to backend.");
});

server.listen(3000, () => {
  console.log("📡 Backend running on port 3000");
  startLiveFeed(io); // Start live market data and signal processing
});
