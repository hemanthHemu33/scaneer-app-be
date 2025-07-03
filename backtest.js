import fs from "fs";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { analyzeCandles } from "./scanner.js";
import { candleHistory } from "./dataEngine.js";
import db from "./db.js";
import { logBacktestReference } from "./auditLogger.js";

dayjs.extend(customParseFormat);

// ✅ Load instruments and build maps
// const instruments = JSON.parse(
//   fs.readFileSync("./routes/instruments.json", "utf-8")
// );
const instruments = await db
  .collection("instruments")
  .find({})
  .toArray();
const tokenSymbolMap = {};
const symbolTokenMap = {};

for (const inst of instruments) {
  const key = `${inst.exchange}:${inst.tradingsymbol}`;
  tokenSymbolMap[inst.instrument_token] = key;
  symbolTokenMap[key] = inst.instrument_token;
}

// ✅ Load session-level historical data
// const sessionData = JSON.parse(
//   fs.readFileSync("./historical_data.json", "utf-8")
// );
const historicalSessionData = await db
  .collection("historical_session_data")
  .findOne({});
const sessionData = await db.collection("session_data").findOne({});
const combinedSessionData = { ...historicalSessionData, ...sessionData };

// 🧠 CONFIG
const SYMBOL = "NSE:ADANIENT";
const START_CANDLES = 50;
const DELAY_MS = 10;

// 🗓️ Set test date manually
const testDate = dayjs("20/6/2025", "D/M/YYYY");

export async function backtestStrategy(symbol = SYMBOL) {
  const token = symbolTokenMap[symbol];

  if (!token || !combinedSessionData[token]) {
    console.error(`❌ No data found for symbol: ${symbol}`);
    return;
  }

  // ✅ Convert timestamps properly
  const allCandles = combinedSessionData[token].map((c) => ({
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    timestamp: dayjs(c.date, "D/M/YYYY, h:mm:ss a").toDate(),
  }));

  // ✅ Filter candles by date
  const candles = allCandles.filter((c) =>
    dayjs(c.timestamp).isSame(testDate, "day")
  );

  if (candles.length < START_CANDLES) {
    console.error(
      `⚠️ Not enough candles to backtest on ${testDate.format(
        "DD/MM/YYYY"
      )}: only ${candles.length}`
    );
    return;
  }

  candleHistory[symbol] = [];
  const signals = [];

  for (let i = 0; i < candles.length; i++) {
    candleHistory[symbol].push(candles[i]);
    if (candleHistory[symbol].length > 60) {
      candleHistory[symbol] = candleHistory[symbol].slice(-60);
    }

    if (i < START_CANDLES) continue;

    const signal = await analyzeCandles(
      [...candleHistory[symbol]],
      symbol,
      null,
      1000,
      900,
      0.1,
      0.3,
      5000,
      {
        last_price: candles[i].close,
        volume_traded: candles[i].volume,
        total_buy_quantity: 1000,
        total_sell_quantity: 900,
      },
      {
        maxATR: 100,
        atrThreshold: 0.5,
        minBuySellRatio: 0.5,
        maxSpread: 2.5,
        minLiquidity: 300,
      }
    );

    if (signal) {
      signal.instrument_token = token; // ✅ Attach token to each signal
      signals.push(signal);
      console.log(
        `📈 ${symbol}: ${signal.pattern} ${signal.direction} @ ₹${signal.entry}`
      );
    }

    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  // ✅ Group signals by instrument_token
  const grouped = {};
  for (const s of signals) {
    const key = String(s.instrument_token);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(s);
  }
  
  await db.collection("backtest_signals").deleteMany({});
  await db.collection("backtest_signals").insertMany(signals);

  // fs.writeFileSync("backtest_signals.json", JSON.stringify(grouped, null, 2));
  console.log(
    `✅ Backtest complete. ${signals.length} signals saved to database`
  );

  await logBacktestReference(
    {
      backtestId: Date.now().toString(),
      strategyConfigVersion: '1',
      parametersUsed: {},
      dateRange: {
        start: candles[0].timestamp,
        end: candles[candles.length - 1].timestamp,
      },
      capitalDeployed: 100000,
    },
    { trades: signals.length }
  );
}

if (process.env.NODE_ENV !== 'test') {
  backtestStrategy();
}
