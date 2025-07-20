// kite.js
import { KiteConnect, KiteTicker } from "kiteconnect";
import { calculateEMA, calculateSupertrend } from "./featureEngine.js";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { ObjectId } from "mongodb";
import { sendSignal } from "./telegram.js";
import { fetchAIData } from "./openAI.js";
import { addSignal } from "./signalManager.js";
import { logSignalCreated } from "./auditLogger.js";
import {
  checkExposureLimits,
  preventReEntry,
  resolveSignalConflicts,
  notifyExposureEvents,
} from "./portfolioContext.js";
dotenv.config();

import db from "./db.js"; // 🧠 Import database module for future use

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const apiKey = process.env.KITE_API_KEY;
const apiSecret = process.env.KITE_API_SECRET;
const kc = new KiteConnect({ api_key: apiKey });
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL) || 100000;

const instruments = await db.collection("instruments").find({}).toArray();

// const tokensPath = path.join(__dirname, "tokens.json");
// const historicalDataPath = path.join(__dirname, "historical_data.json");
// const sessionDataPath = path.join(__dirname, "session_data.json");

const tokensData = await db.collection("tokens").findOne({});
const historicalData = await db.collection("historical_data").findOne({});
const sessionDocs = await db.collection("session_data").find({}).toArray();
const sessionData = {};
for (const doc of sessionDocs) {
  sessionData[doc.token] = doc.candles || doc.data || [];
}
let historicalSessionData = {};

let candleHistory = {}; // 🧠 Store per-token candle history for EMA, RSI, etc.
let historicalCache = {};

let stockSymbols = [
  // "NSE:JSWENERGY",
];

// Load stock symbols from database if available
const stockSymbolsData = await db.collection("stock_symbols").findOne({});
if (stockSymbolsData && stockSymbolsData.symbols) {
  stockSymbols = stockSymbolsData.symbols;
  console.log("✅ Loaded stock symbols from database:", stockSymbols);
}

// SET THE STOCKS SYMBOLS
async function setStockSymbol(symbol) {
  if (!stockSymbols.includes(symbol)) {
    stockSymbols.push(symbol);
    console.log(`🔍 Stock symbol added to memory: ${symbol}`);
  }

  await db.collection("stock_symbols").updateOne(
    {},
    { $addToSet: { symbols: symbol } },
    { upsert: true }
  );
  console.log(`✅ Stock symbol "${symbol}" saved to database`);

  // Subscribe to ticker immediately
  subscribeSymbol(symbol).catch((err) =>
    console.error("❌ subscribeSymbol failed:", err.message)
  );

  // Kick off data fetch asynchronously if needed
  ensureDataForSymbol(symbol).catch((err) =>
    console.error("❌ ensureDataForSymbol failed:", err.message)
  );
}

// REMOVE STOCK SYMBOL FROM MEMORY AND DB
async function removeStockSymbol(symbol) {
  const withPrefix = symbol.includes(":") ? symbol : `NSE:${symbol}`;
  const cleaned = withPrefix.split(":")[1];

  // In-memory list update
  stockSymbols = stockSymbols.filter((s) => s !== withPrefix);

  const token = symbolTokenMap[withPrefix];
  if (token) {
    instrumentTokens = instrumentTokens.filter((t) => t !== token);
    delete symbolTokenMap[withPrefix];
    delete tokenSymbolMap[token];
    delete tickBuffer[token];
    delete candleHistory[token];
    delete alignedTickStorage[token];
    delete historicalCache[token];
    delete historicalSessionData[token];
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

const tokenSymbolMap = {}; // token: symbol
const symbolTokenMap = {}; // symbol: token

for (const inst of instruments) {
  const key = `${inst.exchange}:${inst.tradingsymbol}`;
  if (stockSymbols.includes(key)) {
    tokenSymbolMap[inst.instrument_token] = key;
    symbolTokenMap[key] = inst.instrument_token;
  }
}

let instrumentTokens = [];
let tickIntervalMs = 10000;
let ticker,
  tickBuffer = {},
  candleInterval,
  globalIO;
let errorLog = [],
  tradeLog = [];
let riskState = {
  dailyLoss: 0,
  maxDailyLoss: 5000,
  consecutiveLosses: 0,
  maxConsecutiveLosses: 3,
};
let gapPercent = {};

// 🔐 Initialize Kite session
async function initSession() {
  try {
    const sessionQuery = { type: "kite_session" };

    const savedSession = await db.collection("tokens").findOne(sessionQuery);

    if (savedSession?.access_token) {
      kc.setAccessToken(savedSession.access_token);
      console.log("♻️ Loaded saved access token from DB");
      return savedSession.access_token;
    }

    // 🧠 fallback to tokensData if needed
    const requestToken =
      savedSession?.request_token || tokensData?.request_token;

    if (!requestToken) {
      throw new Error("Missing request_token. Cannot generate session.");
    }

    const session = await kc.generateSession(requestToken, apiSecret);
    kc.setAccessToken(session.access_token);

    // ✅ Save session object with fixed identifier
    await db
      .collection("tokens")
      .updateOne(
        sessionQuery,
        { $set: { ...session, type: "kite_session" } },
        { upsert: true }
      );

    console.log("✅ Session generated and updated in DB:", session);
    return session.access_token;
  } catch (err) {
    logError("Session init failed", err);
    return null;
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
  try {
    const instruments = await db.collection("instruments").find({}).toArray();
    const tokens = instruments
      .filter((inst) =>
        symbols.includes(`${inst.exchange}:${inst.tradingsymbol}`)
      )
      .map((inst) => parseInt(inst.instrument_token));
    return tokens;
  } catch (err) {
    logError("Error reading instruments", err);
    return [];
  }
}

let warmupDone = false;
async function ensureHistoricalData() {
  const historicalCount = await db
    .collection("historical_data")
    .countDocuments();
  if (historicalCount === 0) {
    await fetchHistoricalData();
    await loadHistoricalCache();
  } else if (!Object.keys(historicalCache).length) {
    await loadHistoricalCache();
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
  await loadHistoricalSessionData();
  warmupDone = true;
  console.log("✅ Warmup candle history completed");
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

  const accessToken = await initSession();
  if (!accessToken) return logError("Live feed start failed: No access token");

  await warmupCandleHistory();
  await loadTickDataFromDB();

  // 🧠 Load historical intraday data then today's session data into candle history
  try {
    if (historicalSessionData) {
      for (const token in historicalSessionData) {
        const tokenStr = token;
        if (!candleHistory[tokenStr]) candleHistory[tokenStr] = [];
        candleHistory[tokenStr].push(
          ...historicalSessionData[token].map((c) => ({
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            timestamp: new Date(c.date),
          }))
        );
        candleHistory[tokenStr] = candleHistory[tokenStr].slice(-60);
      }
      console.log("✅ Preloaded historical intraday data into candle history");
    }

    for (const token in sessionData) {
      const tokenStr = token;
      if (!candleHistory[tokenStr]) candleHistory[tokenStr] = [];
      candleHistory[tokenStr].push(
        ...sessionData[token].map((c) => ({
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          timestamp: new Date(c.date),
        }))
      );
      candleHistory[tokenStr] = candleHistory[tokenStr].slice(-60);
    }
    console.log("✅ Preloaded session candles into candle history");

    // ✅ NOW show how many were loaded per token
    for (const token in candleHistory) {
      console.log(
        `🔍 History loaded for ${token}: ${candleHistory[token].length} candles`
      );
      computeGapPercent(token);
    }
    console.log("✅ Candle history initialized");
  } catch (err) {
    console.warn("⚠️ Could not preload session data:", err.message);
  }

  instrumentTokens = await getTokensForSymbols(stockSymbols);
  if (!instrumentTokens.length) return logError("No instrument tokens found");

  ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });
  ticker.on("connect", () => {
    ticker.subscribe(instrumentTokens);
    ticker.setMode(ticker.modeFull, instrumentTokens);
    console.log("🔗 Connected & subscribed:", instrumentTokens);
  });

  ticker.on("ticks", (ticks) => {
    for (const tick of ticks) {
      if (!tickBuffer[tick.instrument_token])
        tickBuffer[tick.instrument_token] = [];
      tickBuffer[tick.instrument_token].push(tick);
      storeTickAligned(tick); // NEW: Store tick for aligned candles
    }
  });

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
  setInterval(() => processAlignedCandles(io), 60000); // Process aligned candles every 1 min
  setInterval(() => flushTickBufferToDB(), 10000); // persist ticks
  // Removed redundant hourly fetchHistoricalIntradayData

  // previous reload of historical data removed to avoid duplication
}

// 🕒 Aligned tick storage
let alignedTickStorage = {};
async function ensureCandleHistory(tokenStr) {
  if (candleHistory[tokenStr] && candleHistory[tokenStr].length) return;
  const doc = await db
    .collection("historical_session_data")
    .findOne({ token: Number(tokenStr) });
  const data = doc?.candles || doc?.data || [];
  candleHistory[tokenStr] = data.map((c) => ({
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    timestamp: new Date(c.date),
  }));
  candleHistory[tokenStr] = candleHistory[tokenStr].slice(-60);
}
function storeTickAligned(tick) {
  const token = tick.instrument_token;
  const ts = new Date(tick.timestamp || Date.now());
  const minuteKey = new Date(Math.floor(ts.getTime() / 60000) * 60000)
    .toISOString()
    .slice(0, 16); // "YYYY-MM-DDTHH:mm"
  if (!alignedTickStorage[token]) alignedTickStorage[token] = {};
  if (!alignedTickStorage[token][minuteKey])
    alignedTickStorage[token][minuteKey] = [];
  alignedTickStorage[token][minuteKey].push(tick);
}

const BATCH_LIMIT = 100;
let processingInProgress = false;

export async function processAlignedCandles(io) {
  if (processingInProgress) return;
  if (!isMarketOpen()) {
    console.log("Market closed, skipping aligned candle processing.");
    processingInProgress = false;
    return;
  }

  processingInProgress = true;

  const { analyzeCandles } = await import("./scanner.js");
  let processedCount = 0;

  try {
    const tokenList = Object.keys(alignedTickStorage);

    for (const token of tokenList) {
      const tokenMinutes = Object.keys(alignedTickStorage[token])
        .sort()
        .reverse(); // latest minutes first

      for (const minute of tokenMinutes) {
        if (processedCount >= BATCH_LIMIT) break;

        try {
          const ticks = alignedTickStorage[token][minute];

          if (
            !Array.isArray(ticks) ||
            ticks.length === 0 ||
            ticks.some((t) => typeof t?.last_price !== "number")
          ) {
            console.warn(`⚠️ Corrupt ticks for token ${token} at ${minute}`);
            delete alignedTickStorage[token][minute];
            continue;
          }

          const prices = ticks
            .map((t) => t.last_price)
            .filter((p) => typeof p === "number" && !isNaN(p));

          if (prices.length < 2) {
            console.warn(
              `⚠️ Insufficient valid prices for ${token} at ${minute}`
            );
            delete alignedTickStorage[token][minute];
            continue;
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
            ? Math.abs(
                (depth.sell?.[0]?.price || 0) - (depth.buy?.[0]?.price || 0)
              )
            : 0;

          const tokenStr = String(token);
          await ensureCandleHistory(tokenStr);
          const symbol = tokenSymbolMap[tokenStr];
          if (!symbol) {
            logError(`❌ Missing symbol for token ${token}`);
            delete alignedTickStorage[token][minute];
            continue;
          }

          const avgVol = getAverageVolume(tokenStr, 20) || 1000;

          let candleScore = 0;
          if (ticks.length >= 5) candleScore++;
          if (volume >= avgVol * 0.8) candleScore++;
          if (spread < 1) candleScore++;

          if (candleScore < 2) {
            console.log(`⚠️ Low-quality candle skipped for ${symbol}`);
            delete alignedTickStorage[token][minute];
            continue;
          }

          const newCandle = {
            open,
            high,
            low,
            close,
            volume,
            timestamp: new Date(minute),
          };

          if (!candleHistory[tokenStr]) candleHistory[tokenStr] = [];
          candleHistory[tokenStr].push(newCandle);
          candleHistory[tokenStr] = candleHistory[tokenStr].slice(-60);

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
            // Step 9: final checks and emit
            await emitUnifiedSignal(signal, "Aligned", io);
          }
        } catch (err) {
          logError(`⚠️ Error processing token ${token} at ${minute}`, err);
        }

        // ✅ Always clean up
        delete alignedTickStorage[token][minute];
        processedCount++;
      }

      // If the inner loop breaks early, exit outer loop too
      if (processedCount >= BATCH_LIMIT) break;
    }
  } catch (globalErr) {
    logError("❌ processAlignedCandles global error", globalErr);
  } finally {
    processingInProgress = false;

    // ✅ Schedule next batch if there’s more to process
    if (
      Object.keys(alignedTickStorage).some(
        (token) => Object.keys(alignedTickStorage[token]).length > 0
      )
    ) {
      setTimeout(() => processAlignedCandles(io), 0); // re-queue next batch
    }
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
      console.warn(`⚠️ Not enough valid price data for token ${token}`);
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

    const tokenStr = String(token);
    await ensureCandleHistory(tokenStr);
    const symbol = tokenSymbolMap[tokenStr];
    if (!symbol) {
      logError(`❌ Missing symbol for token ${token} in tokenSymbolMap`);
      continue;
    }

    const avgVol = getAverageVolume(tokenStr, 20) || 1000;

    const newCandle = {
      open,
      high,
      low,
      close,
      volume,
      timestamp: new Date(),
    };

    if (!candleHistory[tokenStr]) candleHistory[tokenStr] = [];
    candleHistory[tokenStr].push(newCandle);
    candleHistory[tokenStr] = candleHistory[tokenStr].slice(-60); // Keep only last 60 candles

    try {
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
        // Step 9: final checks and emit
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

function checkRisk(signal) {
  if (riskState.dailyLoss >= riskState.maxDailyLoss) return false;
  if (riskState.consecutiveLosses >= riskState.maxConsecutiveLosses)
    return false;
  const tokenStr = symbolTokenMap[signal.stock] || signal.instrument_token;
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

  for (const symbol of stockSymbols) {
    try {
      const ltp = await kc.getLTP([symbol]);
      const token = ltp[symbol].instrument_token;
      const candles = await kc.getHistoricalData(token, "minute", from, to);
      const tokenStr = String(token);

      if (!candleHistory[tokenStr]) candleHistory[tokenStr] = [];

      for (const c of candles) {
        const candleObj = {
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          timestamp: new Date(c.date),
        };
        // candleHistory[tokenStr].push(candleObj);
        const candleAlreadyExists = candleHistory[tokenStr].some(
          (existing) =>
            new Date(existing.timestamp).getTime() ===
            new Date(c.date).getTime()
        );
        if (!candleAlreadyExists) {
          candleHistory[tokenStr].push(candleObj);
        }
      }

      candleHistory[tokenStr] = candleHistory[tokenStr].slice(-60);
    } catch (err) {
      logError(`Fallback candle fetch failed for ${symbol}`, err);
    }
  }
}

// Logging
async function logError(context, err) {
  const errorEntry = {
    time: new Date(),
    context,
    message: err?.message || err,
  };
  console.error(`❌ [${context}]:`, err?.message || err);
  errorLog.push(errorEntry);

  await db.collection("error_logs").insertOne(errorEntry);
  // fs.appendFileSync("error.log", JSON.stringify(errorEntry) + "\n");
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
      const token = String(t.token);
      if (!tickBuffer[token]) tickBuffer[token] = [];
      tickBuffer[token].push(t);
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
async function emitUnifiedSignal(signal, source, io) {
  const key = `${signal.stock}-${signal.pattern}-${signal.direction}`;
  const now = Date.now();
  if (lastSignalMap[key] && now - lastSignalMap[key] < 5 * 60 * 1000) {
    console.log(`🛑 Duplicate signal skipped for ${key}`);
    return;
  }
  lastSignalMap[key] = now;
  if (!checkRisk(signal)) return;
  const symbol = signal.stock || signal.symbol;
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
    return;
  }
  console.log(`🚀 Emitting ${source} Signal:`, signal);
  io.emit("tradeSignal", signal);
  logTrade(signal);
  sendSignal(signal);
  await addSignal(signal);
  logSignalCreated(signal, {
    vix: marketContext.vix,
    regime: marketContext.regime,
    breadth: marketContext.breadth,
  });
  const { insertedId } = await db.collection("signals").insertOne(signal);
  fetchAIData(signal)
    .then(async (ai) => {
      signal.ai = ai;
      await db
        .collection("signals")
        .updateOne({ _id: insertedId }, { $set: { ai } });
    })
    .catch((err) => logError("AI enrichment", err));
}

// FETCH HISTORICAL MINUTESS DATA
async function fetchHistoricalIntradayData(
  interval = "minute",
  daysBack = 3,
  symbols = stockSymbols
) {
  const accessToken = await initSession();
  if (!accessToken) {
    console.error("❌ Cannot fetch historical intraday data: no access token");
    return;
  }

  const today = new Date();
  const tradingDates = getPastTradingDates(today, daysBack);
  const historicalData = {};

  for (const dateStr of tradingDates) {
    console.log(`📆 Fetching ${interval} data for: ${dateStr}`);
    for (const symbol of symbols) {
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
    if (!candleHistory[tokenStr]) candleHistory[tokenStr] = [];
    candleHistory[tokenStr].push(...candles);
    candleHistory[tokenStr] = candleHistory[tokenStr].slice(-60);
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

async function fetchHistoricalData(symbols = stockSymbols) {
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
  for (const symbol of symbols) {
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
async function loadHistoricalCache() {
  try {
    const data = await db.collection("historical_data").findOne({});
    historicalCache = data || {};
    console.log("✅ historical_data.json loaded into cache");
  } catch (err) {
    console.warn("⚠️ Could not load historical data:", err.message);
    historicalCache = {};
  }
}
fetchHistoricalData().then(() => loadHistoricalCache());

async function loadHistoricalSessionData() {
  const docs = await db
    .collection("historical_session_data")
    .find({})
    .toArray();
  historicalSessionData = {};
  for (const doc of docs) {
    const tokenStr = String(doc.token);
    historicalSessionData[tokenStr] = doc.candles || doc.data || [];
  }
  console.log("✅ historical_session_data loaded into memory");
}

function computeGapPercent(tokenStr) {
  const daily = historicalCache[tokenStr] || [];
  const todayCandle = (candleHistory[tokenStr] || []).find((c) =>
    isSameDay(c.timestamp, new Date())
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
  if (!isMarketOpen()) {
    console.log("Market closed. Skipping session data fetch.");
    return;
  }

  const sessionData = {};
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // IST offset in milliseconds
  const nowIST = new Date(now.getTime() + istOffset);

  // Set market start time to 09:15 AM IST
  const marketStart = new Date(nowIST);
  marketStart.setHours(9, 15, 0, 0);

  // Align end time to the latest closed 1-minute candle
  const alignedEnd = new Date(nowIST);
  // alignedEnd.setMinutes(
  //   alignedEnd.getMinutes() - (alignedEnd.getMinutes() % 3)
  // );
  // alignedEnd.setSeconds(0);
  // alignedEnd.setMilliseconds(0);

  alignedEnd.setMinutes(alignedEnd.getMinutes() - 1);
  alignedEnd.setSeconds(0);
  alignedEnd.setMilliseconds(0);

  // Ensure alignedEnd is after marketStart
  if (alignedEnd <= marketStart) {
    console.warn("⚠️ Not enough candles formed yet");
    return;
  }

  // Format dates as 'yyyy-mm-dd hh:mm:ss'
  const fromDate = marketStart.toISOString().slice(0, 19).replace("T", " ");
  const toDate = alignedEnd.toISOString().slice(0, 19).replace("T", " ");

  console.log(`⏳ Session Fetch Range: FROM ${fromDate} TO ${toDate}`);

  for (const symbol of stockSymbols) {
    try {
      const ltp = await kc.getLTP([symbol]);
      const token = ltp[symbol]?.instrument_token;
      if (!token) {
        console.warn(`⚠️ Skipping ${symbol} — token not found from LTP`);
        continue;
      }

      const candles = await kc.getHistoricalData(
        token,
        "minute",
        fromDate,
        toDate
      );

      if (!candles || candles.length === 0) {
        console.warn(`⚠️ No session candles returned for ${symbol}`);
        continue;
      }

      sessionData[token] = candles.map((c) => ({
        date: new Date(c.date).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
        }),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
      tokenSymbolMap[token] = symbol;

      console.log(`📥 Fetched ${candles.length} session candles for ${symbol}`);
    } catch (err) {
      console.error(`❌ Session data error for ${symbol}:`, err.message);
    }
  }

  if (Object.keys(sessionData).length > 0) {
    for (const token in sessionData) {
      await db
        .collection("session_data")
        .updateOne(
          { token: Number(token) },
          { $set: { token: Number(token), candles: sessionData[token] } },
          { upsert: true }
        );
      const tokenStr = String(token);
      if (!candleHistory[tokenStr]) candleHistory[tokenStr] = [];
      candleHistory[tokenStr].push(
        ...sessionData[token].map((c) => ({
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          timestamp: new Date(c.date),
        }))
      );
      candleHistory[tokenStr] = candleHistory[tokenStr].slice(-60);
      computeGapPercent(tokenStr);
    }
    console.log("✅ Session data written to database.");
  } else {
    console.warn("⚠️ No session data written to database (empty response)");
  }

  const anyToken = Object.keys(sessionData)[0];
  if (anyToken && sessionData[anyToken].length < 3) {
    const minutes = nowIST.getHours() * 60 + nowIST.getMinutes();
    if (minutes < 570) {
      console.log("⏳ Session fetch incomplete. Retrying in 1m...");
      setTimeout(fetchSessionData, 60 * 1000);
    }
  }
}

// setInterval(() => fetchSessionData(), 3 * 60 * 1000);
fetchSessionData();

setInterval(() => {
  if (!isMarketOpen()) initSession(); // token refresh only
  else fetchSessionData(); // full session + candle pull
}, 3 * 60 * 1000);

// Periodically check if the warmup task should run
setInterval(warmupCandleHistory, 60 * 1000);

function getMA(token, period) {
  // const data = JSON.parse(fs.readFileSync(historicalDataPath, "utf-8"))[token];
  const data = historicalCache[token];
  return data?.length >= period
    ? data.slice(-period).reduce((a, b) => a + b.close, 0) / period
    : null;
}

function getATR(token, period = 14) {
  const data = historicalCache[token];
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

function getAverageVolume(token, period) {
  // const data = JSON.parse(fs.readFileSync(historicalDataPath, "utf-8"))[token];
  const data = historicalCache[token];
  return data?.length >= period
    ? data.slice(-period).reduce((a, b) => a + b.volume, 0) / period
    : "NA";
}

async function subscribeSymbol(symbol) {
  const tokens = await getTokensForSymbols([symbol]);
  if (!tokens.length) {
    console.warn(`⚠️ Token not found for ${symbol}`);
    return;
  }
  const token = tokens[0];
  tokenSymbolMap[token] = symbol;
  symbolTokenMap[symbol] = token;
  if (!instrumentTokens.includes(token)) {
    updateInstrumentTokens([...instrumentTokens, token]);
  }
}

async function ensureDataForSymbol(symbol) {
  try {
    const ltp = await kc.getLTP([symbol]);
    const token = ltp[symbol]?.instrument_token;
    if (!token) return;

    const doc = await db.collection("historical_data").findOne({});
    if (!doc || !doc[String(token)]) {
      console.log(`📥 Fetching historical data for ${symbol}`);
      await fetchHistoricalData([symbol]);
      await fetchHistoricalIntradayData("minute", 3, [symbol]);
    }

    await loadHistoricalCache();
    await loadHistoricalSessionData();
  } catch (err) {
    console.error(`❌ Error ensuring data for ${symbol}:`, err.message);
  }
}

function updateInstrumentTokens(tokens) {
  if (ticker) {
    ticker.unsubscribe(instrumentTokens);
    ticker.subscribe(tokens);
    console.log("🔄 Updated tokens:", tokens);
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

export function getSupportResistanceLevels(symbol) {
  const token = symbolTokenMap[symbol];
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
  const minutes = alignedTickStorage[token] || {};
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

function resetInMemoryData() {
  stockSymbols = [];
  Object.keys(tokenSymbolMap).forEach((k) => delete tokenSymbolMap[k]);
  Object.keys(symbolTokenMap).forEach((k) => delete symbolTokenMap[k]);
  instrumentTokens = [];
  tickBuffer = {};
  candleHistory = {};
  alignedTickStorage = {};
  historicalCache = {};
  historicalSessionData = {};
  warmupDone = false;
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
  tickBuffer,
  candleHistory,
  warmupCandleHistory,
  preloadStockData,
  isMarketOpen,
  setStockSymbol,
  subscribeSymbol,
  ensureDataForSymbol,
  removeStockSymbol,
  initSession,
  kc,
  symbolTokenMap,
  historicalCache,
  resetInMemoryData,
  loadTickDataFromDB,
};
