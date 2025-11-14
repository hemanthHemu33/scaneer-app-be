// kite.js
import "./env.js";
import { KiteConnect, KiteTicker } from "kiteconnect";
import { EventEmitter } from "events";
import { calculateEMA, calculateSupertrend } from "./featureEngine.js";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
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
import {
  metrics,
  incrementMetric,
  onReject,
  startMetricsReporter,
} from "./metrics.js";
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
import { marketContext } from "./smartStrategySelector.js";
dotenv.config();

import db from "./db.js"; // 🧠 Import database module for future use
import initHistoricalStore from "./data/historicalStore.js";
import {
  candleHistory,
  ensureCandleHistory,
  pushCandle,
  pushCandles,
  clearCandleHistory,
  HISTORY_CAP,
} from "./candleCache.js";

const historicalStore = initHistoricalStore();

const DEFAULT_SLIPPAGE_PCT = 0.0005;
const MAX_SPREAD_SLIPPAGE = 0.003;

const computeSlippagePct = (lastPrice, spread) =>
  lastPrice > 0 && spread > 0
    ? Math.min(spread / lastPrice, MAX_SPREAD_SLIPPAGE)
    : DEFAULT_SLIPPAGE_PCT;

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

const tokensData = await db.collection("tokens").findOne({});
const sessionData = {};
const DEFAULT_SESSION_PRELOAD_LIMIT = 500;
const parsedLimit = Number(process.env.SESSION_PRELOAD_LIMIT);
const SESSION_PRELOAD_LIMIT =
  Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.floor(parsedLimit)
    : DEFAULT_SESSION_PRELOAD_LIMIT;
const parsedDays = Number(process.env.SESSION_PRELOAD_DAYS);
const SESSION_PRELOAD_DAYS =
  Number.isFinite(parsedDays) && parsedDays >= 0 ? parsedDays : 2;

function getSessionHydrationWindow(days) {
  const windowDays = Number.isFinite(days) && days > 0 ? days : 0;
  if (!windowDays) return null;
  const end = new Date();
  const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return { start, end };
}

async function hydrateSessionData(
  tokens,
  { limit = SESSION_PRELOAD_LIMIT, days = SESSION_PRELOAD_DAYS } = {}
) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;

  const numericTokens = tokens
    .map((t) => Number(canonToken(t)))
    .filter((t) => Number.isFinite(t));
  if (!numericTokens.length) return;

  const requested = new Set(numericTokens.map((t) => String(t)));
  const loaded = new Set();
  const buffer = new Map();

  const window = getSessionHydrationWindow(days);
  const query = { token: { $in: numericTokens } };
  if (window) {
    query.ts = { $gte: window.start, $lte: window.end };
  }

  const cursor = db
    .collection("session_data")
    .find(query)
    .sort({ token: 1, ts: -1 });

  try {
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      const tokenStr = canonToken(doc.token || doc.instrument_token);
      if (!tokenStr) continue;
      let arr = buffer.get(tokenStr);
      if (!arr) {
        arr = [];
        buffer.set(tokenStr, arr);
      }
      if (arr.length >= limit) {
        loaded.add(tokenStr);
        if (loaded.size === requested.size) break;
        continue;
      }

      arr.push({
        date: new Date(
          doc.ts || doc.minute || doc.date || doc.timestamp || Date.now()
        ),
        open: doc.open,
        high: doc.high,
        low: doc.low,
        close: doc.close,
        volume: doc.volume,
      });

      if (arr.length >= limit) {
        loaded.add(tokenStr);
        if (loaded.size === requested.size) break;
      }
    }
  } finally {
    await cursor.close();
  }

  for (const [tokenStr, arr] of buffer.entries()) {
    sessionData[tokenStr] = arr
      .slice()
      .sort((a, b) => +new Date(a.date) - +new Date(b.date));
  }
}

function normalizeSymbol(symbol) {
  if (typeof symbol !== "string") return null;
  const trimmed = symbol.trim();
  if (!trimmed) return null;
  return trimmed.includes(":") ? trimmed : `NSE:${trimmed}`;
}

// Track the currently applied universe so we can diff change-stream updates
let stockSymbolUniverse = new Set();
let stockSymbolWatcher = null;
let stockSymbolSyncChain = Promise.resolve();

// Fetch stock symbols from database
async function getStockSymbols() {
  const doc = await db.collection("stock_symbols").findOne({});
  return doc?.symbols || [];
}

function collectUniqueSymbols(symbols = []) {
  const unique = new Set();
  for (const raw of symbols || []) {
    const normalized = normalizeSymbol(raw);
    if (normalized) unique.add(normalized);
  }
  return Array.from(unique);
}

async function syncStockSymbolUniverse(nextSymbols = []) {
  const symbols = collectUniqueSymbols(nextSymbols);
  const prevUniverse = stockSymbolUniverse;
  stockSymbolUniverse = new Set(symbols);

  if (!symbols.length) {
    if (instrumentTokens.length) {
      updateInstrumentTokens([]);
    }
    for (const token of Object.keys(tickBuffer)) delete tickBuffer[token];
    for (const token of Object.keys(sessionData)) delete sessionData[token];
    clearCandleHistory();
    return;
  }

  const addedSymbols = symbols.filter((sym) => !prevUniverse.has(sym));

  const tokens = await getTokensForSymbols(symbols);
  const numericTokens = Array.from(
    new Set(tokens.map((t) => Number(t)).filter((t) => Number.isFinite(t)))
  );

  const keepSet = new Set(numericTokens.map((t) => String(t)));
  const currentSet = new Set(instrumentTokens.map((t) => String(Number(t))));
  const removedTokens = Array.from(currentSet).filter((t) => !keepSet.has(t));

  for (const token of removedTokens) {
    delete tickBuffer[token];
    delete sessionData[token];
    delete candleHistory[token];
  }

  updateInstrumentTokens(numericTokens);

  if (addedSymbols.length) {
    try {
      const addedTokens = Array.from(
        new Set(
          (await getTokensForSymbols(addedSymbols))
            .map((t) => Number(t))
            .filter((t) => Number.isFinite(t))
        )
      );
      if (addedTokens.length) {
        try {
          await hydrateSessionData(addedTokens);
        } catch (err) {
          logError("hydrateSessionData.stockSymbolChange", err);
        }
      }
    } catch (err) {
      logError("hydrateSessionData.stockSymbolChange", err);
    }

    await Promise.allSettled(
      addedSymbols.map(async (symbol) => {
        try {
          await ensureDataForSymbol(symbol);
        } catch (err) {
          logError("ensureDataForSymbol.stockSymbolChange", err, { symbol });
        }
      })
    );
  }
}

export async function watchStockSymbolUniverse() {
  if (stockSymbolWatcher) return stockSymbolWatcher;

  try {
    const initial = await getStockSymbols();
    await syncStockSymbolUniverse(initial);
  } catch (err) {
    logError("watchStockSymbolUniverse.initial", err);
  }

  const collection = db.collection("stock_symbols");
  try {
    stockSymbolWatcher = collection.watch([], { fullDocument: "updateLookup" });
  } catch (err) {
    logError("watchStockSymbolUniverse.start", err);
    stockSymbolWatcher = null;
    return null;
  }

  stockSymbolWatcher.on("change", (change) => {
    const symbols = change.fullDocument?.symbols || [];
    stockSymbolSyncChain = stockSymbolSyncChain
      .catch(() => {})
      .then(() => syncStockSymbolUniverse(symbols))
      .catch((err) => {
        logError("watchStockSymbolUniverse.change", err);
      });
  });

  const resetWatcher = () => {
    try {
      stockSymbolWatcher?.close();
    } catch (err) {
      logError("watchStockSymbolUniverse.close", err);
    }
    stockSymbolWatcher = null;
    setTimeout(() => {
      watchStockSymbolUniverse().catch((err) =>
        logError("watchStockSymbolUniverse.restart", err)
      );
    }, 5000);
  };

  stockSymbolWatcher.on("error", (err) => {
    logError("watchStockSymbolUniverse.error", err);
    resetWatcher();
  });

  stockSymbolWatcher.on("end", () => {
    resetWatcher();
  });

  return stockSymbolWatcher;
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
    await db
      .collection(ALIGNED_COLLECTION)
      .deleteMany({ token: Number(token) });
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
    await db
      .collection("session_data")
      .deleteMany({ token: Number(tokenStr) });
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

function getInstrumentTokens() {
  return instrumentTokens.slice();
}

function getInstrumentTokenCount() {
  return instrumentTokens.length;
}
let tickIntervalMs = 5000;
let lastEODFlush = null;
let ticker;
let liveFeedActive = false;
let liveFeedStarting = false;
let tickBuffer = {};
let candleInterval;
let globalIO;
let lastTickTs = null;
let riskState = {
  dailyLoss: 0,
  maxDailyLoss: 5000,
  consecutiveLosses: 0,
  maxConsecutiveLosses: 3,
};
let gapPercent = {};
let exitMonitorStarted = false;

const DEFAULT_MAX_TICK_RESTORE = 10000;
const parsedMaxTickRestore = Number(process.env.MAX_RESTORE_TICKS);
const MAX_TICK_RESTORE =
  Number.isFinite(parsedMaxTickRestore) && parsedMaxTickRestore > 0
    ? Math.floor(parsedMaxTickRestore)
    : DEFAULT_MAX_TICK_RESTORE;

const DEFAULT_TICK_RESTORE_DELETE_BATCH = 5000;
const parsedRestoreDeleteBatch = Number(process.env.TICK_RESTORE_DELETE_BATCH);
const TICK_RESTORE_DELETE_BATCH =
  Number.isFinite(parsedRestoreDeleteBatch) && parsedRestoreDeleteBatch > 0
    ? Math.floor(parsedRestoreDeleteBatch)
    : DEFAULT_TICK_RESTORE_DELETE_BATCH;

const TICK_RESTORE_CURSOR_BATCH =
  TICK_RESTORE_DELETE_BATCH > 0
    ? Math.min(TICK_RESTORE_DELETE_BATCH, 2000)
    : 1000;

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
  const collections = await db.collections();
  const preservedCollections = [];
  const clearedCollections = [];
  const preserve = new Set([
    "instruments",
    "nifty50stocksymbols",
    "nifty100qualitystocksymbols",
  ]);
  let stockSymbolsCleared = false;

  for (const collection of collections) {
    const name = collection.collectionName;
    if (preserve.has(name)) {
      preservedCollections.push(name);
      continue;
    }

    const result = await collection.deleteMany({});
    clearedCollections.push({
      name,
      deletedCount:
        typeof result?.deletedCount === "number" ? result.deletedCount : null,
    });

    if (name === "stock_symbols") {
      stockSymbolsCleared = true;
    }
  }

  if (!stockSymbolsCleared) {
    const result = await db.collection("stock_symbols").deleteMany({});
    clearedCollections.push({
      name: "stock_symbols",
      deletedCount:
        typeof result?.deletedCount === "number" ? result.deletedCount : null,
    });
  }

  await db.collection("stock_symbols").insertOne({ symbols: [] });

  await resetInMemoryData();

  return {
    status: "success",
    message: "Collections reset successfully",
    preservedCollections,
    clearedCollections,
  };
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
  const query =
    tokens && tokens.length ? { token: { $in: tokens.map(Number) } } : {};
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
      HISTORY_CAP
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

function isLiveFeedRunning() {
  if (liveFeedActive) return true;
  if (ticker && typeof ticker.connected === "function") {
    try {
      return ticker.connected();
    } catch (err) {
      return false;
    }
  }
  return liveFeedStarting;
}

async function startLiveFeed(io) {
  globalIO = io;

  if (liveFeedStarting || isLiveFeedRunning()) {
    console.log(
      "⚠️ Live feed already starting or running. Skipping duplicate start."
    );
    return;
  }

  if (!isMarketOpen()) {
    console.log("⛔ Market closed: not starting live feed.");
    return;
  }

  liveFeedStarting = true;

  try {
    const accessToken = await initSession();
    if (!accessToken) {
      liveFeedStarting = false;
      return logError("Live feed start failed: No access token");
    }

    await warmupCandleHistory();
    await loadTickDataFromDB();

    const symbols = await getStockSymbols();
    if (!symbols.length) {
      liveFeedStarting = false;
      console.warn(
        "⚠️ No stock symbols found. POST /addStockSymbol to add symbols."
      );
      return;
    }

    instrumentTokens = await getTokensForSymbols(symbols);
    if (!instrumentTokens.length) {
      liveFeedStarting = false;
      return logError("No instrument tokens found");
    }

    await hydrateSessionData(instrumentTokens);

    // 🧠 Load historical intraday data then today's session data into candle history
    try {
      await loadHistoricalSessionCandles(instrumentTokens);

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
          HISTORY_CAP
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

    ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });
    ticker.on("connect", () => {
      ticker.subscribe(instrumentTokens);
      ticker.setMode(ticker.modeFull, instrumentTokens);
      console.log(
        "📈 Ticker connected; subscribed:",
        instrumentTokens.length,
        "e.g.",
        instrumentTokens.slice(0, 5)
      );
      liveFeedActive = true;
      liveFeedStarting = false;
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
        tickBuffer[tokenStr].push({
          ...tick,
          instrument_token: Number(tokenStr),
        });
        ingestAlignedTick({ token: tokenStr, symbol, tick });
      }
    });

    ticker.on("order_update", handleOrderUpdate);

    ticker.on("error", (err) => {
      liveFeedActive = false;
      liveFeedStarting = false;
      logError("WebSocket error", err);
      try {
        ticker.disconnect();
      } catch (e) {}
      ticker = null;
      setTimeout(() => startLiveFeed(io), 5000);
    });
    ticker.on("close", () => {
      liveFeedActive = false;
      liveFeedStarting = false;
      ticker = null;
      logError("WebSocket closed, retrying...");
      setTimeout(() => startLiveFeed(io), 5000);
    });

    clearInterval(candleInterval);
    ticker.connect();
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
    const persistTimerStarter = setTimeout(() => {
      const persistTimer = setInterval(() => flushTickBufferToDB(), 15000);
      persistTimer.unref?.();
    }, 3000); // ensure buffer processing runs before the first flush
    persistTimerStarter.unref?.();
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
  } catch (err) {
    liveFeedStarting = false;
    logError("startLiveFeed", err);
  }
}

const BATCH_LIMIT = 100;
let processingInProgress = false;
let lastEmptyAlignedLog = 0;
const EMPTY_ALIGNED_LOG_INTERVAL = 60 * 1000;

const bufferLogState = new Map();

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
      const now = Date.now();
      if (now - lastEmptyAlignedLog > EMPTY_ALIGNED_LOG_INTERVAL) {
        console.log("ℹ️ aligned_ticks empty this cycle");
        lastEmptyAlignedLog = now;
      }
      processingInProgress = false;
      return;
    }

    console.log(`🧱 Aligned batch: ${docs.length} docs`);

    const { analyzeCandles } = await import("./scanner.js");

    for (const doc of docs) {
      const tokenStr = canonToken(doc.token);
      await ensureCandleHistory(tokenStr);
      const symbol = doc.symbol || (await getSymbolForToken(tokenStr));
      if (!symbol) {
        logWarnOncePerToken(
          "UNMAPPED_TOKEN",
          tokenStr,
          "aligned candle missing symbol"
        );
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

      pushCandle(tokenStr, newCandle, HISTORY_CAP);

      const lastTick = doc.lastTick || {};
      const depth = lastTick.depth || null;
      const totalBuy = lastTick.total_buy_quantity || 0;
      const totalSell = lastTick.total_sell_quantity || 0;
      const spread = depth
        ? Math.abs((depth.sell?.[0]?.price || 0) - (depth.buy?.[0]?.price || 0))
        : 0;

      const avgVol = (await getAverageVolume(tokenStr, 20)) ?? 1000;
      const lastPrice =
        Number(lastTick?.last_price) || newCandle.close || newCandle.open || 0;
      const slippagePct = computeSlippagePct(lastPrice, spread);
      incrementMetric("evalSymbols");
      // const lastPrice and slippagePct already declared above, so just use them here
      // cap at 0.30%; default 0.05%
      const signal = await analyzeCandles(
        candleHistory[tokenStr],
        symbol,
        depth,
        totalBuy,
        totalSell,
        slippagePct,
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

    // Compute a reasonable slippage proxy similar to aligned candle handling
    const lastPrice =
      typeof close === "number" && close > 0 ? close : prices.at(-1) || 0;
    const slippagePct =
      lastPrice > 0 && spread > 0
        ? Math.min(spread / lastPrice, MAX_SPREAD_SLIPPAGE)
        : DEFAULT_SLIPPAGE_PCT;

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

    const minuteKey = Math.floor(Date.now() / 60000);
    const lastLog = bufferLogState.get(tokenStr);
    if (!lastLog || lastLog.minute !== minuteKey) {
      console.log(`🧮 Tick buffer for ${symbol}: ${ticks.length} ticks`);
      bufferLogState.set(tokenStr, { minute: minuteKey, count: ticks.length });
    }

    const avgVol = (await getAverageVolume(tokenStr, 20)) ?? 1000;

    const newCandle = {
      open,
      high,
      low,
      close,
      volume,
      timestamp: new Date(),
    };

    pushCandle(tokenStr, newCandle, HISTORY_CAP); // Keep only last HISTORY_CAP candles

    try {
      incrementMetric("evalSymbols");
      const signal = await analyzeCandles(
        candleHistory[tokenStr],
        symbol,
        depth,
        totalBuy,
        totalSell,
        slippagePct,
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

function checkMarketVolatility(
  tokenStr,
  thresholdPct = Number(process.env.ATR_PCT_THRESHOLD) || 2.0
) {
  const candles = candleHistory[tokenStr] || [];
  if (!candles.length) return true;
  const atr = intradayATR(candles, 14);
  const lastCandle = candles[candles.length - 1];
  const lastClose = lastCandle?.close || 0;
  if (!lastClose) return true;
  const atrPct = (atr / lastClose) * 100;
  return atrPct <= thresholdPct;
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
          pushCandle(tokenStr, candleObj, HISTORY_CAP);
        }
      }
    } catch (err) {
      logError(`Fallback candle fetch failed for ${symbol}`, err);
    }
  }
}

async function logTrade(signal) {
  const hasRisk = Number.isFinite(signal.riskPerUnit) && signal.riskPerUnit > 0;
  const tradeEntry = {
    time: new Date(),
    stock: signal.stock,
    pattern: signal.pattern,
    direction: signal.direction,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    target1: signal.target1,
    target2: signal.target2,
    rr: hasRisk
      ? Number(
          Math.abs(
            (signal.target2 - signal.entry) / signal.riskPerUnit
          ).toFixed(2)
        )
      : null,
    confidence: signal.confidence,
  };
  tradeLog.push(tradeEntry);
  await db.collection("trade_logs").insertOne(tradeEntry);
  // fs.appendFileSync("trade.log", JSON.stringify(tradeEntry) + "\n");
}

// Load any persisted ticks from MongoDB on startup
async function loadTickDataFromDB({ maxRestore = MAX_TICK_RESTORE } = {}) {
  try {
    const collection = db.collection("tick_data");
    const cursor = collection
      .find({})
      .sort({ timestamp: 1 })
      .batchSize(TICK_RESTORE_CURSOR_BATCH);

    let restored = 0;
    let skipped = 0;
    let purged = 0;
    let pendingDeleteIds = [];

    try {
      while (await cursor.hasNext()) {
        const doc = await cursor.next();
        if (!doc) continue;

        if (doc._id) {
          pendingDeleteIds.push(doc._id);
        }

        if (restored < maxRestore) {
          const tokenStr = canonToken(doc.token || doc.instrument_token);
          if (tokenStr) {
            if (!tickBuffer[tokenStr]) tickBuffer[tokenStr] = [];
            const { _id, ...tickData } = doc;
            tickBuffer[tokenStr].push({
              ...tickData,
              token: Number(tokenStr),
              instrument_token: Number(tokenStr),
            });
            restored += 1;
          }
        } else {
          skipped += 1;
        }

        if (pendingDeleteIds.length >= TICK_RESTORE_DELETE_BATCH) {
          const batchIds = pendingDeleteIds.splice(
            0,
            TICK_RESTORE_DELETE_BATCH
          );
          if (batchIds.length) {
            const { deletedCount = 0 } = await collection.deleteMany({
              _id: { $in: batchIds },
            });
            purged += deletedCount;
          }
        }
      }
    } finally {
      await cursor.close();
    }

    if (pendingDeleteIds.length) {
      const { deletedCount = 0 } = await collection.deleteMany({
        _id: { $in: pendingDeleteIds },
      });
      purged += deletedCount;
    }

    if (restored || purged) {
      const skippedMsg = skipped ? ` (skipped ${skipped} extra ticks)` : "";
      console.log(
        `✅ Restored ${restored} ticks from DB and purged ${purged}${skippedMsg}`
      );
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

const autoExecFlag = String(process.env.AUTO_EXECUTE ?? "true").toLowerCase();
const AUTO_EXECUTE_ENABLED =
  process.env.NODE_ENV !== "test" &&
  !["false", "0", "off", "disabled"].includes(autoExecFlag);
const parsedAutoWindow = Number(process.env.AUTO_EXECUTE_WINDOW_MS);
const AUTO_EXECUTE_WINDOW_MS =
  Number.isFinite(parsedAutoWindow) && parsedAutoWindow >= 0
    ? parsedAutoWindow
    : 1000;

const pendingAutoSignals = [];
const pendingAutoSignalKeys = new Set();
let pendingAutoTimer = null;

function cloneForExecution(signal) {
  try {
    if (typeof structuredClone === "function") {
      return structuredClone(signal);
    }
  } catch (err) {
    logError("autoExecute.clone", err);
  }
  try {
    return JSON.parse(JSON.stringify(signal));
  } catch (err) {
    logError("autoExecute.cloneFallback", err);
    return { ...signal };
  }
}

function getAutoSignalKey(signal) {
  return (
    signal.signalId ||
    signal.algoSignal?.signalId ||
    `${signal.stock || signal.symbol}-${signal.pattern || "unknown"}-${
      signal.direction || "NA"
    }-${signal.generatedAt || signal.time || Date.now()}`
  );
}

async function flushAutoExecuteQueue() {
  if (!pendingAutoSignals.length) return;
  const items = pendingAutoSignals.splice(0, pendingAutoSignals.length);
  pendingAutoSignalKeys.clear();
  const signals = items.map((item) => item.signal);
  try {
    const { rankAndExecute } = await import("./scanner.js");
    const result = await rankAndExecute(signals);
    const isObjectResult =
      result && typeof result === "object" && !Array.isArray(result);
    const candidate = isObjectResult
      ? result.top || result.candidate || null
      : result;
    const orders = isObjectResult && "orders" in result ? result.orders : null;
    const reason = isObjectResult && "reason" in result ? result.reason : null;
    if (orders) return; // success already logged downstream
    if (candidate) {
      const symbol = candidate.stock || candidate.symbol || "unknown";
      const strategy =
        candidate.pattern || candidate.strategy || candidate.strategyName || "";
      let status = "top candidate";
      if (reason === "margin") status = "blocked by margin for";
      else if (reason === "validation") status = "failed validation for";
      else if (reason === "exposure") status = "blocked by exposure for";
      else if (reason === "execution-failed")
        status = "execution failed for";
      console.log(
        `🤖 Auto execution evaluated ${signals.length} signal(s); ${status} ${symbol}${
          strategy ? ` (${strategy})` : ""
        }`
      );
    } else {
      console.log(
        `🤖 Auto execution evaluated ${signals.length} signal(s); none qualified`
      );
    }
  } catch (err) {
    logError("autoExecute.flush", err);
  }
}

function scheduleAutoExecution(signal) {
  if (!AUTO_EXECUTE_ENABLED) return;
  const key = getAutoSignalKey(signal);
  if (key && pendingAutoSignalKeys.has(key)) return;
  if (key) pendingAutoSignalKeys.add(key);
  pendingAutoSignals.push({ key, signal: cloneForExecution(signal) });
  const triggerFlush = () => {
    pendingAutoTimer = null;
    flushAutoExecuteQueue().catch((err) => logError("autoExecute.run", err));
  };
  if (pendingAutoTimer) return;
  if (AUTO_EXECUTE_WINDOW_MS > 0) {
    pendingAutoTimer = setTimeout(triggerFlush, AUTO_EXECUTE_WINDOW_MS);
    pendingAutoTimer.unref?.();
  } else {
    triggerFlush();
  }
}
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
  const exposureOptions = {
    symbol,
    tradeValue,
    sector: signal.sector || "GEN",
    totalCapital: getAccountBalance(),
  };
  const reEntryAllowed = preventReEntry(symbol);
  const exposureAllowed = checkExposureLimits(exposureOptions);
  const conflictAllowed = resolveSignalConflicts({
    symbol,
    side: signal.direction === "Long" ? "buy" : "sell",
    strategy: signal.pattern,
  });

  if (process.env.DEBUG_PORTFOLIO) {
    console.log("[PORTFOLIO GATE]", {
      reEntry: reEntryAllowed,
      exposure: exposureAllowed,
      conflict: conflictAllowed,
    });
  }

  const allowed = reEntryAllowed && exposureAllowed && conflictAllowed;
  if (!allowed) {
    await logSignalRejected(
      signal.signalId ||
        signal.algoSignal?.signalId ||
        `${symbol}-${Date.now()}`,
      "portfolioRules",
      { message: `Signal for ${symbol} rejected by portfolio rules` },
      signal
    );
    return;
  }
  const sizingInfo = signal.sizing || {};
  const sizingLog = {
    rawSL: signal.rawStopDistance ?? sizingInfo.rawDistance ?? null,
    effectiveSL: signal.effectiveStopDistance ?? sizingInfo.effectiveDistance ?? null,
    requestedQty: sizingInfo.requestedQty ?? sizingInfo.roundedQty ?? null,
    finalQty: signal.qty,
    marginCapQty: sizingInfo.marginCap?.capQty ?? null,
    marginCapLots: sizingInfo.marginCap?.maxLots ?? null,
    marginCapped: Boolean(sizingInfo.marginCapped),
  };
  console.log(`[SIZING] ${symbol}`, sizingLog);
  console.log(`🚀 Emitting ${source} Signal:`, signal);
  // Guard against missing socket instance which previously threw and prevented
  // signal propagation
  if (io) {
    io.emit("tradeSignal", signal);
  }
  logTrade(signal);
  const persistInfo = await persistThenNotify(signal);
  scheduleAutoExecution(signal);
  incrementMetric("emitted");
  const ctx = (typeof marketContext === "object" && marketContext) || {};
  logSignalCreated(signal, {
    vix: ctx.vix ?? null,
    regime: ctx.regime ?? null,
    breadth: ctx.breadth ?? null,
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
    const [year, month, day] = dateStr.split("-").map(Number);
    const from = new Date(Date.UTC(year, month - 1, day, 3, 45));
    const to = new Date(Date.UTC(year, month - 1, day, 10, 0));

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
          new Date(from),
          new Date(to),
          false // continuous = false
        );
        if (!candles?.length) {
          console.warn(`⚠️ No candles for ${symbol} on ${dateStr}`);
          continue;
        }

        // 3) Format and accumulate
        const formatted = candles.map((c) => {
          const d = new Date(c.date);
          return {
            date: d,
            timestamp: d,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          };
        });

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
    pushCandles(tokenStr, candles, HISTORY_CAP);
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

async function fetchHistoricalData(symbols) {
  const accessToken = await initSession();
  if (!accessToken) return console.error("❌ Cannot fetch historical data");
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 90);
  const endDate = new Date();
  const symbolList = symbols || (await getStockSymbols());
  const historicalCol = db.collection("historical_data");
  let updatedCount = 0;
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
        startDate,
        endDate
      );
      const tokenKey = String(token);
      const formattedCandles = candles.map((c) => {
        const d = new Date(c.date);
        return {
          date: d,
          timestamp: d,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        };
      });
      await historicalCol.updateOne(
        {},
        { $set: { [tokenKey]: formattedCandles } },
        { upsert: true }
      );
      updatedCount += 1;
      if (updatedCount % 25 === 0) {
        console.log(
          `📦 Historical candles stored for ${updatedCount} symbol${
            updatedCount === 1 ? "" : "s"
          }`
        );
      }
    } catch (err) {
      console.error(`❌ Error for ${symbol}:`, err.message);
    }
  }
  if (updatedCount > 0) {
    console.log("✅ historical_data.json written successfully");
  } else {
    console.log("ℹ️ No historical candles were stored");
  }
}

async function getHistoricalData(tokenStr) {
  try {
    return await historicalStore.getDailyCandles(tokenStr);
  } catch (err) {
    console.error(
      `❌ Error fetching historical data for ${tokenStr}:`,
      err.message
    );
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
  const sessionEnd = new Date(now);
  sessionEnd.setHours(15, 30, 0, 0);

  if (now < sessionStart) {
    console.log("⏳ Session has not started yet; skipping fetch.");
    return;
  }

  console.log(
    `⏳ Session Fetch Range: FROM ${sessionStart.toISOString()} TO ${sessionEnd.toISOString()}`
  );

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
        sessionStart,
        sessionEnd
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
      await db
        .collection("session_data")
        .bulkWrite(bulkOps, { ordered: false });
      console.log("✅ Session data written to database.");
    } catch (err) {
      logError("session_data.bulkWrite", err);
    }
  } else {
    console.warn("⚠️ No session data written to database (empty response)");
  }

  for (const [tokenStr, docs] of memoryUpdate.entries()) {
    const ordered = docs
      .map((doc) => ({
        date: doc.ts,
        open: doc.open,
        high: doc.high,
        low: doc.low,
        close: doc.close,
        volume: doc.volume,
      }))
      .sort((a, b) => +new Date(a.date) - +new Date(b.date));

    sessionData[tokenStr] =
      ordered.length > SESSION_PRELOAD_LIMIT
        ? ordered.slice(-SESSION_PRELOAD_LIMIT)
        : ordered;

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
      HISTORY_CAP
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
  if (!data || data.length < period) return null;
  return data.slice(-period).reduce((a, b) => a + (b.volume || 0), 0) / period;
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
  const next = Array.from(new Set(tokens.map((t) => Number(t)))).filter((t) =>
    Number.isFinite(t)
  );
  if (ticker) {
    const currentSet = new Set(instrumentTokens.map((t) => Number(t)));
    const toRemove = instrumentTokens
      .filter((t) => !next.includes(Number(t)))
      .map((t) => Number(t));
    const toAdd = next.filter((t) => !currentSet.has(t));

    if (toRemove.length) {
      ticker.unsubscribe(toRemove);
    }
    if (toAdd.length) {
      ticker.subscribe(toAdd);
      ticker.setMode(ticker.modeFull, toAdd);
    }
    console.log("🔄 Tokens updated:", "+", toAdd.length, "-", toRemove.length);
  }
  instrumentTokens = next;
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
    const supertrend = calculateSupertrend(candles, 50, 3);

    return { ema50, supertrend };
  } catch (err) {
    console.error(`❌ Error fetching higher timeframe data: ${err.message}`);
    return null;
  }
}

export async function getSupportResistanceLevels(symbol) {
  const token = await getTokenForSymbol(symbol);
  const tokenStr = canonToken(token);
  const candles = (candleHistory[tokenStr] || []).filter(
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
    .project({ minute: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 })
    .sort({ minute: 1 })
    .toArray();

  const result = [];
  for (let i = 0; i < docs.length; i += 3) {
    const slice = docs.slice(i, i + 3);
    if (slice.length === 0) continue;
    result.push({
      date: slice[0].minute,
      open: slice[0].open,
      high: Math.max(...slice.map((d) => d.high)),
      low: Math.min(...slice.map((d) => d.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((sum, d) => sum + (d.volume || 0), 0),
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
  liveFeedActive = false;
  liveFeedStarting = false;
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
  resetDatabase,
  loadTickDataFromDB,
  lastTickTs,
  isLiveFeedRunning,
  getInstrumentTokens,
  getInstrumentTokenCount,
};
