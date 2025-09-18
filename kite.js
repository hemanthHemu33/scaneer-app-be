// kite.js
import "./env.js";
import { KiteConnect, KiteTicker } from "kiteconnect";
import { EventEmitter } from "events";
import { calculateEMA, calculateSupertrend } from "./featureEngine.js";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { ObjectId } from "mongodb";
import { fetchAIData } from "./openAI.js";
import { logSignalCreated, logSignalRejected } from "./auditLogger.js";
import { logError, logWarnOncePerToken } from "./logger.js";
import { canonToken, canonSymbol } from "./canon.js";
import {
  ensureLoad as ensureInstrumentMap,
  tokenSymbolMap,
  symbolTokenMap,
  getSymbolForToken as getSymbolForTokenFromMap,
  getTokenForSymbol as getTokenForSymbolFromMap,
} from "./mapping.js";
import {
  ingestTick as ingestAlignedTick,
  flushOpenCandles,
  finalizeEOD as finalizeAlignedEOD,
} from "./aligner.js";
import { fallbackFetch } from "./fallbackFetcher.js";
import { metrics, incrementMetric, onReject, startMetricsReporter } from "./metrics.js";
import { persistThenNotify } from "./emitter.js";
import {
  checkExposureLimits,
  preventReEntry,
  resolveSignalConflicts,
  notifyExposureEvents,
  openPositions,
  recordExit as markExit,
} from "./portfolioContext.js";
import { startExitMonitor, recordExit as logExit } from "./exitManager.js";
import { logTrade as recordTrade, logOrderUpdate } from "./tradeLogger.js";
import { getAccountBalance, initAccountBalance } from "./account.js";
dotenv.config();

import db from "./db.js"; // 🧠 Import database module for future use
import initHistoricalStore from "./data/historicalStore.js";
import {
  candleHistory,
  ensureCandleHistory,
  pushCandle,
  pushCandles,
  clearCandleHistory,
} from "./candleCache.js";

const historicalStore = initHistoricalStore();

// Collection name for aligned ticks stored in MongoDB
const ALIGNED_COLLECTION = "aligned_ticks";
// Ensure the collection exists. Mongo will create it automatically if missing.
await db.createCollection(ALIGNED_COLLECTION).catch(() => {});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const apiKey = process.env.KITE_API_KEY;
const apiSecret = process.env.KITE_API_SECRET;
const kc = new KiteConnect({ api_key: apiKey });

// Initialize logs before any async operations that might reference them
let tradeLog = [];

await initAccountBalance();

await ensureInstrumentMap(db);
startMetricsReporter();

// Order update event emitter and storage
export const orderEvents = new EventEmitter();
const orderUpdateMap = new Map();

export function onOrderUpdate(cb) {
  orderEvents.on("update", cb);
}

export function getOrderUpdate(orderId) {
  return orderUpdateMap.get(orderId);
}

// const tokensPath = path.join(__dirname, "tokens.json");
// const historicalDataPath = path.join(__dirname, "historical_data.json");
// const sessionDataPath = path.join(__dirname, "session_data.json");

const tokensData = await db.collection("tokens").findOne({});
const sessionDocs = await db.collection("session_data").find({}).toArray();
const sessionData = {};
for (const doc of sessionDocs) {
  const tokenStr = canonToken(doc.token || doc.instrument_token);
  if (!tokenStr) continue;
  if (!sessionData[tokenStr]) sessionData[tokenStr] = [];
  sessionData[tokenStr].push({
    date: new Date(doc.ts || doc.minute || doc.date || doc.timestamp || Date.now()),
    open: doc.open,
    high: doc.high,
    low: doc.low,
    close: doc.close,
    volume: doc.volume,
  });
}
for (const token in sessionData) {
  sessionData[token].sort((a, b) => +new Date(a.date) - +new Date(b.date));
}

// Fetch stock symbols from database
async function getStockSymbols() {
  const doc = await db.collection("stock_symbols").findOne({});
  return doc?.symbols || [];
}

// SET THE STOCKS SYMBOLS
async function setStockSymbol(symbol) {
  const withPrefix = symbol.includes(":") ? symbol : `NSE:${symbol}`;

  await db
    .collection("stock_symbols")
    .updateOne({}, { $addToSet: { symbols: withPrefix } }, { upsert: true });
  console.log(`✅ Stock symbol "${withPrefix}" saved to database`);

  // Subscribe to ticker immediately
  subscribeSymbol(withPrefix).catch((err) =>
    console.error("❌ subscribeSymbol failed:", err.message)
  );

  // Kick off data fetch asynchronously if needed
  ensureDataForSymbol(withPrefix).catch((err) =>
    console.error("❌ ensureDataForSymbol failed:", err.message)
  );
}

// REMOVE STOCK SYMBOL FROM MEMORY AND DB
async function removeStockSymbol(symbol) {
  const withPrefix = symbol.includes(":") ? symbol : `NSE:${symbol}`;
  const cleaned = withPrefix.split(":")[1];

  const token = await getTokenForSymbol(withPrefix);
  if (token) {
    instrumentTokens = instrumentTokens.filter((t) => t !== token);
    delete tickBuffer[token];
    delete candleHistory[token];
    // Remove any aligned tick data for this token from DB
    await db.collection(ALIGNED_COLLECTION).deleteMany({ token: Number(token) });
    delete sessionData[token];
    if (ticker) ticker.unsubscribe([token]);
    updateInstrumentTokens(instrumentTokens);
  }

  await db
    .collection("stock_symbols")
    .updateOne({}, { $pull: { symbols: withPrefix } }, { upsert: true });

  const instrument = await db
    .collection("instruments")
    .findOne({ tradingsymbol: cleaned, exchange: "NSE" });

  if (instrument?.instrument_token) {
    const tokenStr = String(instrument.instrument_token);
    await db
      .collection("historical_data")
      .updateOne({}, { $unset: { [tokenStr]: "" } });
    // await db.collection('session_data').updateOne({}, { $unset: { [tokenStr]: '' } });
    await db.collection("session_data").deleteOne({ token: Number(tokenStr) });
    await db
      .collection("historical_session_data")
      .deleteMany({ token: Number(tokenStr) });
    await db.collection("tick_data").deleteMany({ token: Number(tokenStr) });

    const collections = await db.collections();
    const keep = [
      "instruments",
      "nifty100qualitystocksymbols",
      "nifty50stocksymbols",
      "stock_symbols",
      "historical_data",
      "session_data",
      "historical_session_data",
      "tick_data",
    ];

    for (const col of collections) {
      if (keep.includes(col.collectionName)) continue;
      const query = {
        $or: [
          { symbol: cleaned },
          { symbol: withPrefix },
          { stock: cleaned },
          { stock: withPrefix },
          { tradingsymbol: cleaned },
          { token: Number(tokenStr) },
          { instrument_token: Number(tokenStr) },
          { "signal.stock": cleaned },
          { "signal.stock": withPrefix },
        ],
      };
      try {
        await col.deleteMany(query);
      } catch (err) {
        console.error(`Error cleaning ${col.collectionName}:`, err.message);
      }
    }
  }
}

// Mapping helpers – fetch fresh data from DB on demand
async function getTokenForSymbol(symbol) {
  const sym = canonSymbol(symbol);
  await ensureInstrumentMap(db);
  const mapped = symbolTokenMap.get(sym);
  if (mapped) return Number(mapped);
  try {
    const resolved = await fallbackFetch(sym, null, db);
    if (resolved?.token) return Number(resolved.token);
  } catch (err) {
    logError("mapping.getTokenForSymbol", err, { symbol: sym });
  }
  return null;
}

async function getSymbolForToken(token) {
  const tokenStr = canonToken(token);
  await ensureInstrumentMap(db);
  const mapped = tokenSymbolMap.get(tokenStr);
  if (mapped) return mapped;
  try {
    const resolved = await fallbackFetch(tokenStr, null, db);
    return resolved?.symbol || null;
  } catch (err) {
    logError("mapping.getSymbolForToken", err, { token: tokenStr });
    return null;
  }
}

let instrumentTokens = [];
let tickIntervalMs = 10000;
let lastEODFlush = null;
  let ticker,
    tickBuffer = {},
    candleInterval,
    globalIO;
  let lastTickTs = null;
  let riskState = {
  dailyLoss: 0,
  maxDailyLoss: 5000,
  consecutiveLosses: 0,
  maxConsecutiveLosses: 3,
};
let gapPercent = {};
let exitMonitorStarted = false;

function handleExit(trade, reason) {
  markExit(trade.symbol);
  logExit(trade, reason, trade.lastPrice);
}

function handleOrderUpdate(update) {
  orderUpdateMap.set(update.order_id, update);
  orderEvents.emit("update", update);
  logOrderUpdate(update);
  // Start monitoring exits only after the first order is actually filled
  if (!exitMonitorStarted && update.status === "COMPLETE") {
    startExitMonitor(openPositions, {
      exitTrade: handleExit,
      logTradeExit: handleExit,
    });
    exitMonitorStarted = true;
  }
}

// 🔐 Initialize Kite session
export async function initSession() {
  try {
    const savedSession = await db
      .collection("tokens")
      .findOne({ type: "kite_session" });
    if (!savedSession?.access_token) {
      throw new Error("No saved Kite access_token in DB. Login flow required.");
    }
    kc.setAccessToken(savedSession.access_token);
    console.log("♻️ Loaded access token from DB");
    return savedSession.access_token;
  } catch (err) {
    logError("initSession", err);
    return null;
  }
}

// RESET THE COMPLETE DATA BASE IF THE ACCESS TOKEN IS EXPIRED
async function resetDatabase() {
  // Logic to reset the database
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

    await resetInMemoryData();
    res.json({ status: "success", message: "Collections reset successfully" });
  } catch (err) {
    logError("reset collections", err);
    res.status(500).json({ error: "Failed to reset collections" });
  }
}

function isMarketOpen() {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const totalMinutes = now.getHours() * 60 + now.getMinutes();
  return (
    now.getDay() >= 1 &&
    now.getDay() <= 5 &&
    totalMinutes >= 555 &&
    totalMinutes <= 930
  );
}

async function getTokensForSymbols(symbols) {
  await ensureInstrumentMap(db);
  const results = [];
  for (const sym of symbols) {
    const key = canonSymbol(sym);
    let token = symbolTokenMap.get(key);
    if (!token) {
      try {
        const resolved = await fallbackFetch(key, null, db);
        token = resolved?.token;
      } catch (err) {
        logWarnOncePerToken("UNMAPPED_SUBSCRIBE", key, "token lookup failed", {
          reason: err?.code || err?.message,
        });
      }
    }
    if (token) {
      results.push(Number(token));
    }
  }
  return results;
}

let warmupDone = false;
async function ensureHistoricalData() {
  const historicalCount = await db
    .collection("historical_data")
    .countDocuments();
  if (historicalCount === 0) {
    await fetchHistoricalData();
  }
}

async function warmupCandleHistory() {
  if (warmupDone) return;
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const count = await db.collection("historical_session_data").countDocuments();
  if (count === 0 || (now.getHours() === 9 && now.getMinutes() <= 1)) {
    await fetchHistoricalIntradayData("minute", 3);
  }
  await ensureHistoricalData();
  warmupDone = true;
  console.log("✅ Warmup candle history completed");
}

// Load historical intraday session candles from MongoDB into in-memory candleHistory
async function loadHistoricalSessionCandles(tokens) {
  const query = tokens && tokens.length ? { token: { $in: tokens.map(Number) } } : {};
  const docs = await db
    .collection("historical_session_data")
    .find(query)
    .toArray();

  for (const doc of docs) {
    const tokenStr = String(doc.token);
    pushCandles(
      tokenStr,
      (doc.candles || doc.data || []).map((c) => ({
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        timestamp: new Date(c.date),
      })),
      60
    );
  }

  if (docs.length) {
    console.log("✅ Preloaded historical intraday data into candle history");
  }
}

async function preloadStockData() {
  console.log("⏳ Morning preload starting...");
  try {
    await warmupCandleHistory();
    await fetchSessionData();
    console.log("✅ Morning preload completed");
  } catch (err) {
    console.error("❌ Morning preload error:", err.message);
  }
}

async function startLiveFeed(io) {
  globalIO = io;
  if (!isMarketOpen()) {
    console.log("⛔ Market closed: not starting live feed.");
    return;
  }

  const accessToken = await initSession();
  if (!accessToken) return logError("Live feed start failed: No access token");

  await warmupCandleHistory();
  await loadTickDataFromDB();

  // 🧠 Load historical intraday data then today's session data into candle history
  try {
    await loadHistoricalSessionCandles();

    for (const token in sessionData) {
      const tokenStr = canonToken(token);
      pushCandles(
        tokenStr,
        sessionData[token].map((c) => ({
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          timestamp: new Date(c.date),
        })),
        60
      );
    }
    console.log("✅ Preloaded session candles into candle history");

    // ✅ NOW show how many were loaded per token
    for (const token in candleHistory) {
      console.log(
        `🔍 History loaded for ${token}: ${candleHistory[token].length} candles`
      );
      await computeGapPercent(canonToken(token));
    }
    console.log("✅ Candle history initialized");
  } catch (err) {
    console.warn("⚠️ Could not preload session data:", err.message);
  }

  const symbols = await getStockSymbols();
  if (!symbols.length) {
    console.warn(
      "⚠️ No stock symbols found. POST /addStockSymbol to add symbols."
    );
    return;
  }

  instrumentTokens = await getTokensForSymbols(symbols);
  if (!instrumentTokens.length) return logError("No instrument tokens found");

  ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });
  ticker.on("connect", () => {
    ticker.subscribe(instrumentTokens);
    ticker.setMode(ticker.modeFull, instrumentTokens);
    console.log("📈 Ticker connected");
    console.log("🔔 Subscribed", instrumentTokens.length, "symbols");
  });

  ticker.on("ticks", (ticks) => {
    lastTickTs = Date.now();
    incrementMetric("ticks", ticks.length);
    for (const tick of ticks) {
      const tokenStr = canonToken(tick.instrument_token);
      if (!tokenStr) continue;
      const symbol = tokenSymbolMap.get(tokenStr);
      if (!symbol) {
        logWarnOncePerToken("UNMAPPED_TOKEN", tokenStr, "dropping tick");
        continue;
      }
      if (!tickBuffer[tokenStr]) tickBuffer[tokenStr] = [];
      tickBuffer[tokenStr].push({ ...tick, instrument_token: Number(tokenStr) });
      ingestAlignedTick({ token: tokenStr, symbol, tick });
    }
  });

  ticker.on("order_update", handleOrderUpdate);

  ticker.on("error", (err) => {
    logError("WebSocket error", err);
    try {
      ticker.disconnect();
    } catch (e) {}
    setTimeout(() => startLiveFeed(io), 5000);
  });
  ticker.on("close", () => {
    logError("WebSocket closed, retrying...");
    setTimeout(() => startLiveFeed(io), 5000);
  });

  ticker.connect();
  clearInterval(candleInterval);
  candleInterval = setInterval(() => processBuffer(io), tickIntervalMs);
  candleInterval.unref?.();
  const alignedTimer = setInterval(() => processAlignedCandles(io), 60000);
  alignedTimer.unref?.();
  const flushTimer = setInterval(() => {
    flushOpenCandles({ force: false }).catch((err) =>
      logError("aligner.flush", err)
    );
  }, 5000);
  flushTimer.unref?.();
  const persistTimer = setInterval(() => flushTickBufferToDB(), 10000);
  persistTimer.unref?.();
  const eodTimer = setInterval(() => {
    const now = new Date();
    if (isMarketOpen()) return;
    const dayKey = now.toISOString().slice(0, 10);
    if (lastEODFlush === dayKey) return;
    lastEODFlush = dayKey;
    finalizeAlignedEOD(now)
      .then(() => flushOpenCandles({ force: true }))
      .catch((err) => logError("aligner.finalizeEOD", err));
  }, 60000);
  eodTimer.unref?.();
  // Removed redundant hourly fetchHistoricalIntradayData

  // previous reload of historical data removed to avoid duplication
}

const BATCH_LIMIT = 100;
let processingInProgress = false;

export async function processAlignedCandles(io) {
  if (processingInProgress) return;
  processingInProgress = true;

  try {
    const docs = await db
      .collection(ALIGNED_COLLECTION)
      .find({})
      .sort({ minute: 1 })
      .limit(BATCH_LIMIT)
      .toArray();

    if (!docs.length) {
      processingInProgress = false;
      return;
    }

    const { analyzeCandles } = await import("./scanner.js");

    for (const doc of docs) {
      const tokenStr = canonToken(doc.token);
      await ensureCandleHistory(tokenStr);
      const symbol = doc.symbol || (await getSymbolForToken(tokenStr));
      if (!symbol) {
        logWarnOncePerToken("UNMAPPED_TOKEN", tokenStr, "aligned candle missing symbol");
        await db.collection(ALIGNED_COLLECTION).deleteOne({ _id: doc._id });
        continue;
      }

      const newCandle = {
        open: doc.open,
        high: doc.high,
        low: doc.low,
        close: doc.close,
        volume: doc.volume,
        timestamp: new Date(doc.minute),
      };

      pushCandle(tokenStr, newCandle, 60);

      const lastTick = doc.lastTick || {};
      const depth = lastTick.depth || null;
      const totalBuy = lastTick.total_buy_quantity || 0;
      const totalSell = lastTick.total_sell_quantity || 0;
      const spread = depth
        ? Math.abs((depth.sell?.[0]?.price || 0) - (depth.buy?.[0]?.price || 0))
        : 0;

      const avgVol = (await getAverageVolume(tokenStr, 20)) || 1000;
      incrementMetric("evalSymbols");
      const signal = await analyzeCandles(
        candleHistory[tokenStr],
        symbol,
        depth,
        totalBuy,
        totalSell,
        0.1,
        spread,
        avgVol,
        lastTick
      );

      if (signal) {
        incrementMetric("candidates");
        await emitUnifiedSignal(signal, "Aligned", io);
      }

      await db.collection(ALIGNED_COLLECTION).deleteOne({ _id: doc._id });
    }
  } catch (err) {
    logError("processAlignedCandles", err);
  } finally {
    processingInProgress = false;
  }
}

// 🕒 Old tick buffer processing
async function processBuffer(io) {
  if (!isMarketOpen()) {
    console.log("Market closed, skipping buffer processing.");
    return;
  }

  const { analyzeCandles } = await import("./scanner.js");

  for (const token in tickBuffer) {
    let ticks = tickBuffer[token];
    if (!ticks || ticks.length < 2) continue;

    // ✅ Clean and validate last_price values
    const prices = ticks
      .map((t) => t.last_price)
      .filter((p) => typeof p === "number" && !isNaN(p));

    if (prices.length < 2) {
      logWarnOncePerToken(
        "SPARSE_TICK_BUFFER",
        canonToken(token),
        "not enough price data"
      );
      continue;
    }

    // ✅ Limit very large tick buffers to avoid performance/memory issues
    if (ticks.length > 5000) {
      console.warn(
        `⚠️ Tick buffer too large for token ${token} (${ticks.length}), trimming to 5000`
      );
      ticks = ticks.slice(-5000);
    }

    const open = prices[0];
    const close = prices[prices.length - 1];
    const high = Math.max(...prices);
    const low = Math.min(...prices);

    const volume = ticks.reduce((sum, t) => {
      const qty = t?.last_traded_quantity;
      return typeof qty === "number" && !isNaN(qty) ? sum + qty : sum;
    }, 0);

    const lastTick = ticks[ticks.length - 1] || {};
    const depth = lastTick?.depth || null;
    const totalBuy = lastTick?.total_buy_quantity || 0;
    const totalSell = lastTick?.total_sell_quantity || 0;

    const spread = depth
      ? Math.abs((depth.sell?.[0]?.price || 0) - (depth.buy?.[0]?.price || 0))
      : 0;

    const tokenStr = canonToken(token);
    await ensureCandleHistory(tokenStr);
    const symbol = await getSymbolForToken(tokenStr);
    if (!symbol) {
      logWarnOncePerToken(
        "UNMAPPED_TOKEN",
        tokenStr,
        "tick buffer missing symbol"
      );
      continue;
    }

    const avgVol = (await getAverageVolume(tokenStr, 20)) || 1000;

    const newCandle = {
      open,
      high,
      low,
      close,
      volume,
      timestamp: new Date(),
    };

    pushCandle(tokenStr, newCandle, 60); // Keep only last 60 candles

    try {
      incrementMetric("evalSymbols");
      const signal = await analyzeCandles(
        candleHistory[tokenStr],
        symbol,
        depth,
        totalBuy,
        totalSell,
        0.1,
        spread,
        avgVol,
        lastTick
      );

      if (signal) {
        incrementMetric("candidates");
        await emitUnifiedSignal(signal, "TickBuffer", io);
      }
    } catch (err) {
      logError(`❌ Signal generation error for token ${token}`, err);
    }

    // 🧹 Clear the buffer after processing
    tickBuffer[token] = [];
  }
}

// Risk Management
function intradayATR(candles, period = 14) {
  if (!candles || candles.length < period) return 0;
  let sum = 0;
  for (let i = candles.length - period + 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1] || c;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
    sum += tr;
  }
  return sum / period;
}

function checkMarketVolatility(tokenStr, threshold = 5) {
  const candles = candleHistory[tokenStr] || [];
  const atr = intradayATR(candles, 14);
  return atr <= threshold;
}

async function checkRisk(signal) {
  if (riskState.dailyLoss >= riskState.maxDailyLoss) return false;
  if (riskState.consecutiveLosses >= riskState.maxConsecutiveLosses)
    return false;
  const tokenStr =
    (await getTokenForSymbol(signal.stock)) || signal.instrument_token;
  if (tokenStr && !checkMarketVolatility(String(tokenStr))) return false;
  return true;
}

// ✅ Fix 1: Candle Stability — Add fallback using official 1-min data every X minutes
setInterval(() => {
  if (isMarketOpen()) {
    fetchFallbackOneMinuteCandles();
  }
}, 5 * 60 * 1000); // Every 5 minutes

async function fetchFallbackOneMinuteCandles() {
  const accessToken = await initSession();
  if (!accessToken) return;

  const to = new Date();
  const from = new Date(to.getTime() - 5 * 60 * 1000);

  const stockSymbols = await getStockSymbols();
  for (const symbol of stockSymbols) {
    try {
      const resolved = await fallbackFetch(symbol, null, db);
      if (!resolved?.token) {
        logWarnOncePerToken(
          "FALLBACK_NO_TOKEN",
          symbol,
          "Instrument token unavailable"
        );
        continue;
      }

      const candles = await kc.getHistoricalData(
        Number(resolved.token),
        "minute",
        from,
        to
      );
      const tokenStr = canonToken(resolved.token);

      for (const c of candles) {
        const candleObj = {
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          timestamp: new Date(c.date),
        };
        const candleAlreadyExists = (candleHistory[tokenStr] || []).some(
          (existing) =>
            new Date(existing.timestamp).getTime() ===
            new Date(c.date).getTime()
        );
        if (!candleAlreadyExists) {
          pushCandle(tokenStr, candleObj, 60);
        }
      }
    } catch (err) {
      logError(`Fallback candle fetch failed for ${symbol}`, err);
    }
  }
}

async function logTrade(signal) {
  const tradeEntry = {
    time: new Date(),
    stock: signal.stock,
    pattern: signal.pattern,
    direction: signal.direction,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    target1: signal.target1,
    target2: signal.target2,
    rr: parseFloat(
      Math.abs((signal.target2 - signal.entry) / signal.riskPerUnit).toFixed(2)
    ),
    confidence: signal.confidence,
  };
  tradeLog.push(tradeEntry);
  await db.collection("trade_logs").insertOne(tradeEntry);
  // fs.appendFileSync("trade.log", JSON.stringify(tradeEntry) + "\n");
}

// Load any persisted ticks from MongoDB on startup
async function loadTickDataFromDB() {
  try {
    const ticks = await db
      .collection("tick_data")
      .find({})
      .sort({ timestamp: 1 })
      .toArray();
    for (const t of ticks) {
      const tokenStr = canonToken(t.token || t.instrument_token);
      if (!tokenStr) continue;
      if (!tickBuffer[tokenStr]) tickBuffer[tokenStr] = [];
      tickBuffer[tokenStr].push({ ...t, instrument_token: Number(tokenStr) });
    }
    if (ticks.length) {
      await db.collection("tick_data").deleteMany({});
      console.log(`✅ Loaded ${ticks.length} ticks from DB`);
    }
  } catch (err) {
    logError("Tick data load", err);
  }
}

// Persist tick buffer every 10 seconds for restart safety
async function flushTickBufferToDB() {
  const operations = [];
  for (const token in tickBuffer) {
    const ticks = tickBuffer[token];
    if (!Array.isArray(ticks) || ticks.length === 0) continue;
    for (const t of ticks) {
      operations.push({
        insertOne: { document: { token: Number(token), ...t } },
      });
    }
    tickBuffer[token] = [];
  }
  if (operations.length) {
    try {
      await db.collection("tick_data").bulkWrite(operations);
    } catch (err) {
      logError("Tick buffer flush", err);
    }
  }
}

const lastSignalMap = {};
// Allow io to be optional and fall back to the initialized global socket
async function emitUnifiedSignal(signal, source, io = globalIO) {
  const key = `${signal.stock}-${signal.pattern}-${signal.direction}`;
  const now = Date.now();
  if (lastSignalMap[key] && now - lastSignalMap[key] < 5 * 60 * 1000) {
    console.log(`🛑 Duplicate signal skipped for ${key}`);
    return;
  }
  lastSignalMap[key] = now;
  if (!(await checkRisk(signal))) return;
  const symbol = signal.stock || signal.symbol;
  const tradeValue = signal.entry * (signal.qty || 1);
  const allowed =
    preventReEntry(symbol) &&
    checkExposureLimits({
      symbol,
      tradeValue,
      sector: signal.sector || "GEN",
      totalCapital: getAccountBalance(),
    }) &&
    resolveSignalConflicts({
      symbol,
      side: signal.direction === "Long" ? "long" : "short",
      strategy: signal.pattern,
    });
  if (!allowed) {
    await logSignalRejected(
      signal.signalId || signal.algoSignal?.signalId || `${symbol}-${Date.now()}`,
      "portfolioRules",
      { message: `Signal for ${symbol} rejected by portfolio rules` },
      signal
    );
    return;
  }
  console.log(`🚀 Emitting ${source} Signal:`, signal);
  // Guard against missing socket instance which previously threw and prevented
  // signal propagation
  if (io) {
    io.emit("tradeSignal", signal);
  }
  logTrade(signal);
  const persistInfo = await persistThenNotify(signal);
  incrementMetric("emitted");
  logSignalCreated(signal, {
    vix: marketContext.vix,
    regime: marketContext.regime,
    breadth: marketContext.breadth,
  });
  const filter = persistInfo?.insertedId
    ? { _id: persistInfo.insertedId }
    : persistInfo?.signalId
    ? { signalId: persistInfo.signalId }
    : null;
  fetchAIData(signal)
    .then(async (ai) => {
      signal.ai = ai;
      if (filter) {
        await db.collection("signals").updateOne(filter, {
          $set: { ai, updatedAt: new Date() },
        });
      }
    })
    .catch((err) => logError("AI enrichment", err));
}

// FETCH HISTORICAL MINUTESS DATA
async function fetchHistoricalIntradayData(
  interval = "minute",
  daysBack = 3,
  symbols
) {
  const accessToken = await initSession();
  if (!accessToken) {
    console.error("❌ Cannot fetch historical intraday data: no access token");
    return;
  }

  const today = new Date();
  const tradingDates = getPastTradingDates(today, daysBack);
  const historicalData = {};
  const symbolsToUse = symbols || (await getStockSymbols());

  for (const dateStr of tradingDates) {
    console.log(`📆 Fetching ${interval} data for: ${dateStr}`);
    for (const symbol of symbolsToUse) {
      try {
        // 1) Lookup instrument token
        const ltp = await kc.getLTP([symbol]);
        const token = ltp[symbol]?.instrument_token;
        if (!token) {
          console.warn(`⚠️ Skipping ${symbol} — token not found`);
          continue;
        }

        // 2) Fetch intraday candles
        const candles = await kc.getHistoricalData(
          token,
          interval,
          dateStr,
          dateStr,
          false // continuous = false
        );
        if (!candles?.length) {
          console.warn(`⚠️ No candles for ${symbol} on ${dateStr}`);
          continue;
        }

        // 3) Format and accumulate
        const formatted = candles.map((c) => ({
          date: new Date(c.date).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
          }),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        }));

        if (!historicalData[token]) {
          historicalData[token] = [];
        }
        historicalData[token].push(...formatted);
      } catch (err) {
        console.error(`❌ Error for ${symbol} on ${dateStr}:`, err.message);
      }
    }
  }
  // 4) Persist into MongoDB per token
  for (const token in historicalData) {
    await db
      .collection("historical_session_data")
      .updateOne(
        { token: Number(token) },
        { $set: { token: Number(token), candles: historicalData[token] } },
        { upsert: true }
      );
  }

  const tokenCount = Object.keys(historicalData).length;
  console.log(
    `✅ Fetched ${daysBack} days of ${interval} candles for ${tokenCount} tokens`
  );
  console.log("✅ historical_session_data updated successfully");

  // refresh in-memory history
  for (const token in historicalData) {
    const tokenStr = String(token);
    const candles = historicalData[token].map((c) => ({
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      timestamp: new Date(c.date),
    }));
    pushCandles(tokenStr, candles, 60);
  }
}

// Get past trading dates excluding weekends
function getPastTradingDates(refDate, count) {
  const dates = [];
  const d = new Date(refDate);

  // If today is weekend, start from the last weekday
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }

  // Collect previous trading days
  while (dates.length < count) {
    d.setDate(d.getDate() - 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      dates.push(d.toISOString().split("T")[0]);
    }
  }

  return dates.reverse(); // Oldest first
}

fetchHistoricalData();
// Session & Historical Data

async function fetchHistoricalData(symbols) {
  const accessToken = await initSession();

  if (!isMarketOpen()) {
    console.log("Market closed. Skipping historical data fetch.");
    return;
  }
  if (!accessToken) return console.error("❌ Cannot fetch historical data");
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 90);
  const startStr = startDate.toISOString().split("T")[0];
  const endStr = new Date().toISOString().split("T")[0];
  const historicalData = {};
  const symbolList = symbols || (await getStockSymbols());
  for (const symbol of symbolList) {
    try {
      const ltp = await kc.getLTP([symbol]);
      const token = ltp[symbol]?.instrument_token;
      if (!token) {
        console.warn(`⚠️ Skipping ${symbol} — token not found from LTP`);
        continue;
      }
      const candles = await kc.getHistoricalData(
        token,
        "day",
        startStr,
        endStr
      );
      historicalData[token] = candles.map((c) => ({
        date: new Date(c.date).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
        }),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
    } catch (err) {
      console.error(`❌ Error for ${symbol}:`, err.message);
    }
  }
  // fs.writeFileSync(historicalDataPath, JSON.stringify(historicalData, null, 2));
  await db
    .collection("historical_data")
    .updateOne({}, { $set: historicalData }, { upsert: true });
  console.log("✅ historical_data.json written successfully");
}
fetchHistoricalData();

async function getHistoricalData(tokenStr) {
  try {
    return await historicalStore.getDailyCandles(tokenStr);
  } catch (err) {
    console.error(`❌ Error fetching historical data for ${tokenStr}:`, err.message);
    return [];
  }
}

async function computeGapPercent(tokenStr) {
  const daily = await getHistoricalData(tokenStr);
  const intraday = await historicalStore.getIntradayCandles(tokenStr);
  const todayCandle = intraday.find((c) =>
    isSameDay(c.date || c.timestamp, new Date())
  );
  if (!todayCandle || !daily.length) return;
  const yesterdayClose = daily[daily.length - 1]?.close;
  if (typeof yesterdayClose === "number") {
    gapPercent[tokenStr] = (todayCandle.open - yesterdayClose) / yesterdayClose;
  }
}

function isSameDay(d1, d2) {
  const a = new Date(d1);
  const b = new Date(d2);
  if (isNaN(a) || isNaN(b)) return false;
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

async function fetchSessionData() {
  const accessToken = await initSession();
  if (!accessToken) {
    console.error("❌ Cannot fetch session data");
    return;
  }
  await ensureInstrumentMap(db);

  const now = new Date();
  const sessionStart = new Date(now);
  sessionStart.setHours(9, 15, 0, 0);
  const sessionEndExclusive = new Date(now);
  sessionEndExclusive.setHours(15, 31, 0, 0);

  if (now < sessionStart) {
    console.log("⏳ Session has not started yet; skipping fetch.");
    return;
  }

  const fromDate = sessionStart.toISOString().slice(0, 19).replace("T", " ");
  const toDate = sessionEndExclusive.toISOString().slice(0, 19).replace("T", " ");

  console.log(`⏳ Session Fetch Range: FROM ${fromDate} TO ${toDate}`);

  const stockSymbols = await getStockSymbols();
  const bulkOps = [];
  const memoryUpdate = new Map();

  const formatMinute = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}:00`;
  };

  const formatSession = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  for (const symbol of stockSymbols) {
    try {
      const resolved = await fallbackFetch(symbol, null, db);
      if (!resolved?.token) {
        logWarnOncePerToken(
          "SESSION_NO_TOKEN",
          symbol,
          "Instrument token unavailable"
        );
        continue;
      }
      const tokenStr = canonToken(resolved.token);
      const candles = await kc.getHistoricalData(
        Number(tokenStr),
        "minute",
        fromDate,
        toDate
      );

      if (!candles || candles.length === 0) {
        console.warn(`⚠️ No session candles returned for ${symbol}`);
        continue;
      }

      const docs = [];
      for (const candle of candles) {
        const ts = new Date(candle.date);
        const sessionDoc = {
          token: Number(tokenStr),
          symbol: resolved.symbol || symbol,
          ts,
          minute: formatMinute(ts),
          session: formatSession(ts),
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          trades: candle.trades ?? 0,
          source: "fetchSessionData",
          updatedAt: new Date(),
        };
        bulkOps.push({
          updateOne: {
            filter: { token: sessionDoc.token, ts: sessionDoc.ts },
            update: {
              $set: sessionDoc,
              $setOnInsert: { createdAt: new Date() },
            },
            upsert: true,
          },
        });
        docs.push(sessionDoc);
      }

      memoryUpdate.set(tokenStr, docs);
      console.log(`📥 Fetched ${candles.length} session candles for ${symbol}`);
    } catch (err) {
      logError(`Session data error for ${symbol}`, err);
    }
  }

  if (bulkOps.length) {
    try {
      await db.collection("session_data").bulkWrite(bulkOps, { ordered: false });
      console.log("✅ Session data written to database.");
    } catch (err) {
      logError("session_data.bulkWrite", err);
    }
  } else {
    console.warn("⚠️ No session data written to database (empty response)");
  }

  for (const [tokenStr, docs] of memoryUpdate.entries()) {
    sessionData[tokenStr] = docs
      .map((doc) => ({
        date: doc.ts,
        open: doc.open,
        high: doc.high,
        low: doc.low,
        close: doc.close,
        volume: doc.volume,
      }))
      .sort((a, b) => +new Date(a.date) - +new Date(b.date));

    pushCandles(
      tokenStr,
      sessionData[tokenStr].map((c) => ({
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        timestamp: new Date(c.date),
      })),
      60
    );
    await computeGapPercent(tokenStr);
  }
}

// setInterval(() => fetchSessionData(), 3 * 60 * 1000);
if (process.env.NODE_ENV !== "test") {
  fetchSessionData();

  const sessionTimer = setInterval(() => {
    if (!isMarketOpen()) initSession(); // token refresh only
    fetchSessionData(); // session pull regardless of market state
  }, 3 * 60 * 1000);
  sessionTimer.unref?.();

  // Periodically check if the warmup task should run
  const warmupTimer = setInterval(warmupCandleHistory, 60 * 1000);
  warmupTimer.unref?.();
}

async function getMA(token, period) {
  const data = await getHistoricalData(token);
  return data?.length >= period
    ? data.slice(-period).reduce((a, b) => a + b.close, 0) / period
    : null;
}

async function getATR(token, period = 14) {
  const data = await getHistoricalData(token);
  if (!data || data.length < period) return null;
  return (
    data.slice(-period).reduce((acc, cur, i, arr) => {
      const high = cur.high,
        low = cur.low,
        prevClose = arr[i - 1]?.close ?? cur.close;
      return (
        acc +
        Math.max(
          high - low,
          Math.abs(high - prevClose),
          Math.abs(low - prevClose)
        )
      );
    }, 0) / period
  );
}

async function getAverageVolume(token, period) {
  const data = await getHistoricalData(token);
  return data?.length >= period
    ? data.slice(-period).reduce((a, b) => a + (b.volume || 0), 0) / period
    : "NA";
}

async function subscribeSymbol(symbol) {
  const tokens = await getTokensForSymbols([symbol]);
  if (!tokens.length) {
    console.warn(`⚠️ Token not found for ${symbol}`);
    return;
  }
  const token = tokens[0];
  if (!instrumentTokens.includes(token)) {
    updateInstrumentTokens([...instrumentTokens, token]);
  }
}

async function ensureDataForSymbol(symbol) {
  try {
    const ltp = await kc.getLTP([symbol]);
    const token = ltp[symbol]?.instrument_token;
    if (!token) return;

    const existing = await getHistoricalData(String(token));
    if (!existing.length) {
      console.log(`📥 Fetching historical data for ${symbol}`);
      await fetchHistoricalData([symbol]);
      await fetchHistoricalIntradayData("minute", 3, [symbol]);
    }

    await loadHistoricalSessionCandles([token]);
  } catch (err) {
    console.error(`❌ Error ensuring data for ${symbol}:`, err.message);
  }
}

// function updateInstrumentTokens(tokens) {
//   if (ticker) {
//     ticker.unsubscribe(instrumentTokens);
//     ticker.subscribe(tokens);
//     console.log("🔄 Updated tokens:", tokens);
//   }
//   instrumentTokens = tokens;
// }
function updateInstrumentTokens(tokens) {
  if (ticker) {
    ticker.unsubscribe(instrumentTokens);
    ticker.subscribe(tokens);
    ticker.setMode(ticker.modeFull, tokens); // ensure FULL for the new set
    console.log("🔄 Updated tokens (FULL mode):", tokens);
  }
  instrumentTokens = tokens;
}

function setTickInterval(interval) {
  clearInterval(candleInterval);
  tickIntervalMs = interval;
  candleInterval = setInterval(() => processBuffer(globalIO), tickIntervalMs);
  console.log(`⏲ Tick interval set to ${tickIntervalMs} ms`);
}

export async function getHigherTimeframeData(symbol, timeframe = "15minute") {
  const accessToken = await initSession();
  if (!accessToken) {
    console.error("❌ Cannot fetch higher timeframe data");
    return null;
  }

  // Proper date range for historical API
  const now = new Date();
  const endDate = new Date(now);
  const startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000); // last 24h

  try {
    const ltp = await kc.getLTP([symbol]);
    const token = ltp[symbol].instrument_token;

    // 🚨 Pass actual Date objects, not strings
    const candles = await kc.getHistoricalData(
      token,
      timeframe,
      startDate,
      endDate
    );

    if (!candles || candles.length === 0) return null;

    const closes = candles.map((c) => c.close);
    const ema50 = calculateEMA(closes, 50);
    const supertrend = calculateSupertrend(candles, 50);

    return { ema50, supertrend };
  } catch (err) {
    console.error(`❌ Error fetching higher timeframe data: ${err.message}`);
    return null;
  }
}

export async function getSupportResistanceLevels(symbol) {
  const token = await getTokenForSymbol(symbol);
  const candles = (candleHistory[token] || []).filter(
    (c) =>
      c &&
      typeof c.high === "number" &&
      !isNaN(c.high) &&
      typeof c.low === "number" &&
      !isNaN(c.low)
  );
  if (!candles.length) return { support: null, resistance: null };
  const lows = candles.map((c) => c.low);
  const highs = candles.map((c) => c.high);
  return {
    support: Math.min(...lows),
    resistance: Math.max(...highs),
  };
}

export async function rebuildThreeMinCandlesFromOneMin(token) {
  const docs = await db
    .collection(ALIGNED_COLLECTION)
    .find({ token: Number(token) })
    .toArray();
  const minutes = {};
  for (const doc of docs) {
    minutes[doc.minute] = doc.ticks || [];
  }
  const entries = Object.keys(minutes).sort();
  const result = [];
  for (let i = 0; i < entries.length; i += 3) {
    const slice = entries.slice(i, i + 3);
    const ticks = slice.flatMap((m) => minutes[m] || []);
    if (ticks.length < 2) continue;
    const prices = ticks.map((t) => t.last_price);
    result.push({
      date: new Date(slice[0]),
      open: prices[0],
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices[prices.length - 1],
      volume: ticks.reduce((s, t) => s + (t.last_traded_quantity || 0), 0),
    });
  }
  return result;
}

async function resetInMemoryData() {
  instrumentTokens = [];
  tickBuffer = {};
  clearCandleHistory();
  // Clear aligned tick data stored in MongoDB
  await db.collection(ALIGNED_COLLECTION).deleteMany({});
  warmupDone = false;
  if (ticker) {
    try {
      ticker.disconnect();
    } catch {}
    ticker = null;
  }
  kc.setAccessToken("");
}

export {
  startLiveFeed,
  updateInstrumentTokens,
  setTickInterval,
  fetchHistoricalData,
  fetchHistoricalIntradayData,
  fetchSessionData,
  getMA,
  getATR,
  getAverageVolume,
  historicalStore,
  tickBuffer,
  candleHistory,
  warmupCandleHistory,
  preloadStockData,
  isMarketOpen,
  getStockSymbols,
  setStockSymbol,
  subscribeSymbol,
  ensureDataForSymbol,
  removeStockSymbol,
  kc,
  getTokenForSymbol,
  getSymbolForToken,
  getHistoricalData,
  resetInMemoryData,
  loadTickDataFromDB,
  lastTickTs,
};
