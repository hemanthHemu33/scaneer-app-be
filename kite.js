// kite.js
import { KiteConnect, KiteTicker } from "kiteconnect";
import { calculateEMA, calculateSupertrend } from "./util.js";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { ObjectId } from "mongodb";
import { sendSignal } from "./telegram.js";
dotenv.config();

import db from "./db.js"; // 🧠 Import database module for future use

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const apiKey = process.env.KITE_API_KEY;
const apiSecret = process.env.KITE_API_SECRET;
const kc = new KiteConnect({ api_key: apiKey });

const instruments = await db.collection("instruments").find({}).toArray();

// const tokensPath = path.join(__dirname, "tokens.json");
// const historicalDataPath = path.join(__dirname, "historical_data.json");
// const sessionDataPath = path.join(__dirname, "session_data.json");

const tokensData = await db.collection("tokens").findOne({});
const historicalData = await db.collection("historical_data").findOne({});
const sessionData = await db.collection("session_data").findOne({});

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
  const existingSymbols = await db.collection("stock_symbols").findOne({});
  if (!existingSymbols) {
    await db.collection("stock_symbols").insertOne({ symbols: [symbol] });
    console.log("✅ Stock symbol saved to database (new record)");
    return;
  }
  await db.collection("stock_symbols").updateOne(
    {},
    { $addToSet: { symbols: symbol } }, // avoids duplicates
    { upsert: true }
  );
  console.log(`✅ Stock symbol "${symbol}" saved to database`);
}

const tokenSymbolMap = {}; // token: symbol

for (const inst of instruments) {
  const key = `${inst.exchange}:${inst.tradingsymbol}`;
  if (stockSymbols.includes(key)) {
    tokenSymbolMap[inst.instrument_token] = key;
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

async function startLiveFeed(io) {
  globalIO = io;

  const accessToken = await initSession();
  if (!accessToken) return logError("Live feed start failed: No access token");

  // 🧠 Load initial session data into candle history
  try {
    for (const token in sessionData) {
      const tokenStr = token;
      if (tokenStr === "_id") continue; // Skip MongoDB _id field
      candleHistory[tokenStr] = sessionData[token]
        .map((c) => ({
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          timestamp: new Date(c.date),
        }))
        .slice(-60);
    }
    console.log("✅ Preloaded session candles into candle history");

    // ✅ NOW show how many were loaded per token
    for (const token in candleHistory) {
      console.log(
        `🔍 History loaded for ${token}: ${candleHistory[token].length} candles`
      );
    }
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

  ticker.on("error", (err) => logError("WebSocket error", err));
  ticker.on("close", () => {
    logError("WebSocket closed, retrying...");
    setTimeout(() => startLiveFeed(io), 5000);
  });

  ticker.connect();
  clearInterval(candleInterval);
  candleInterval = setInterval(() => processBuffer(io), tickIntervalMs);
  setInterval(() => processAlignedCandles(io), 60000); // Process aligned candles every 1 min

  // 🧠 Load initial session data into candle history
  try {
    for (const token in sessionData) {
      const tokenStr = token;
      if (tokenStr === "_id") continue; // Skip MongoDB _id field
      candleHistory[tokenStr] = sessionData[token]
        .map((c) => ({
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          timestamp: new Date(c.date),
        }))
        .slice(-60);
    }
    console.log("✅ Preloaded session candles into candle history");
  } catch (err) {
    console.warn("⚠️ Could not preload session data:", err.message);
  }
}

// 🕒 Aligned tick storage
let alignedTickStorage = {};
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

          if (signal && checkRisk(signal)) {
            console.log("🚀 Emitting Aligned Signal:", signal);
            io.emit("tradeSignal", signal);
            logTrade(signal);
            sendSignal(signal); // 🐦 Send to Telegram
            // STORE THE LATEST SIGNAL IN DB LATEST SIGNAL ON TOP

            await db.collection("signals").insertOne(signal);
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

      if (signal && checkRisk(signal)) {
        console.log("🚀 Emitting TickBuffer Signal:", signal);
        io.emit("tradeSignal", signal);
        logTrade(signal);
        sendSignal(signal); // 🐦 Send to Telegram
      }
    } catch (err) {
      logError(`❌ Signal generation error for token ${token}`, err);
    }

    // 🧹 Clear the buffer after processing
    tickBuffer[token] = [];
  }
}

// Risk Management
function checkRisk(signal) {
  if (riskState.dailyLoss >= riskState.maxDailyLoss) return false;
  if (riskState.consecutiveLosses >= riskState.maxConsecutiveLosses)
    return false;
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

fetchHistoricalData();
// Session & Historical Data
async function fetchHistoricalData() {
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
    historicalCache = await db.collection("historical_data").findOne({});
    console.log("✅ historical_data.json loaded into cache");
  } catch (err) {
    console.warn("⚠️ Could not load historical data:", err.message);
  }
}
fetchHistoricalData().then(() => loadHistoricalCache());

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

  // Align end time to the latest closed 3-minute candle
  const alignedEnd = new Date(nowIST);
  // alignedEnd.setMinutes(
  //   alignedEnd.getMinutes() - (alignedEnd.getMinutes() % 3)
  // );
  // alignedEnd.setSeconds(0);
  // alignedEnd.setMilliseconds(0);

  alignedEnd.setMinutes(alignedEnd.getMinutes() - 3);
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
        "3minute",
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
    // fs.writeFileSync(sessionDataPath, JSON.stringify(sessionData, null, 2));
    await db
      .collection("session_data")
      .updateOne({}, { $set: sessionData }, { upsert: true });
    console.log("✅ Session data written to database.");
  } else {
    console.warn("⚠️ No session data written to database (empty response)");
  }
}

// setInterval(() => fetchSessionData(), 3 * 60 * 1000);
// fetchSessionData();

setInterval(() => {
  if (!isMarketOpen()) initSession(); // token refresh only
  else fetchSessionData(); // full session + candle pull
}, 3 * 60 * 1000);

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

export {
  startLiveFeed,
  updateInstrumentTokens,
  setTickInterval,
  fetchHistoricalData,
  fetchSessionData,
  getMA,
  getATR,
  getAverageVolume,
  candleHistory,
  isMarketOpen,
  setStockSymbol,
  initSession,
};
