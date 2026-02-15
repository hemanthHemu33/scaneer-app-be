import fs from 'fs';
import path from 'path';
import process from 'process';
import { execSync } from 'child_process';
import dayjs from 'dayjs';
import { createBacktestClock } from '../src/backtest/clock.js';
import {
  computeDynamicExitPlan,
  evaluateExit,
  evaluateOnCandles,
  updateDynamicExitPlan,
} from '../src/backtest/engine.js';

function parseArgs(argv = []) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key?.startsWith('--')) {
      args[key.slice(2)] = value;
      i += 1;
    }
  }
  return args;
}

function normalizeCandle(c) {
  const ts = c.timestamp || c.date || c.time;
  return {
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume ?? c.v ?? 0),
    timestamp: new Date(ts),
  };
}

function applyCosts({ side, price, qty, slippageBps = 5, brokeragePerOrder = 20 }) {
  const px = Number(price);
  const slip = px * (slippageBps / 10_000);
  const traded = side === 'buy' ? px + slip : px - slip;
  const fees = brokeragePerOrder;
  return { tradedPrice: traded, fees, notional: traded * qty };
}

function pnlForTrade(trade) {
  if (trade.side === 'Long') {
    return (trade.exitPrice - trade.entryPrice) * trade.qty - trade.totalFees;
  }
  return (trade.entryPrice - trade.exitPrice) * trade.qty - trade.totalFees;
}

function computeMetrics(trades = []) {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let wins = 0;

  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (t.pnl > 0) wins += 1;
  }

  return {
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    winRate: trades.length ? wins / trades.length : 0,
    netPnl: equity,
    maxDrawdown,
    avgPnl: trades.length ? equity / trades.length : 0,
  };
}

async function loadCandles(db, { token, symbol }) {
  const hist = (await db.collection('historical_session_data').findOne({})) || {};
  const live = (await db.collection('session_data').findOne({})) || {};
  const merged = { ...hist, ...live };

  let rows = [];
  if (token && Array.isArray(merged[token])) rows = merged[token];
  if (!rows.length && symbol && Array.isArray(merged[symbol])) rows = merged[symbol];

  if (!rows.length) {
    const tokenNum = Number(token);
    const fromCandles = await db
      .collection('candles')
      .find(Number.isFinite(tokenNum) ? { token: tokenNum } : {})
      .sort({ timestamp: 1 })
      .toArray();
    rows = fromCandles;
  }

  return rows.map(normalizeCandle).filter((c) => Number.isFinite(c.close));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbol = args.symbol || 'NSE:ADANIENT';
  const token = args.token || null;
  const seed = Number(args.seed || 42);
  const start = args.start ? new Date(args.start) : null;
  const end = args.end ? new Date(args.end) : null;

  const { default: db } = await import('../db.js');
  let candles = await loadCandles(db, { token, symbol });
  if (start) candles = candles.filter((c) => c.timestamp >= start);
  if (end) candles = candles.filter((c) => c.timestamp <= end);
  if (candles.length < 60) throw new Error(`Not enough candles for ${symbol}`);

  const clock = createBacktestClock(candles[0].timestamp.getTime());
  const trades = [];
  let openTrade = null;
  const lookback = 60;

  for (let i = lookback; i < candles.length; i += 1) {
    const candle = candles[i];
    clock.set(candle.timestamp.getTime());

    if (openTrade) {
      updateDynamicExitPlan(openTrade.plan, candle);
      const exitHit = evaluateExit(openTrade.plan, candle);
      if (exitHit) {
        const sellSide = openTrade.side === 'Long' ? 'sell' : 'buy';
        const exec = applyCosts({ side: sellSide, price: exitHit.exit, qty: openTrade.qty });
        openTrade.exitPrice = exec.tradedPrice;
        openTrade.exitAt = candle.timestamp;
        openTrade.exitReason = exitHit.reason;
        openTrade.totalFees += exec.fees;
        openTrade.pnl = pnlForTrade(openTrade);
        trades.push(openTrade);
        openTrade = null;
      }
    }

    if (!openTrade) {
      const history = candles.slice(i - lookback, i + 1);
      const signal = await evaluateOnCandles({ candles: history, symbol });
      if (signal?.entry && signal?.stopLoss) {
        const plan = computeDynamicExitPlan(signal, { atr: signal.atr, targetRR: 2 });
        if (plan) {
          const qty = Number(args.qty || 1);
          const buySide = signal.direction === 'Long' ? 'buy' : 'sell';
          const exec = applyCosts({ side: buySide, price: signal.entry, qty });
          openTrade = {
            symbol,
            side: signal.direction,
            qty,
            seed,
            entryAt: candle.timestamp,
            entryPrice: exec.tradedPrice,
            totalFees: exec.fees,
            plan,
          };
        }
      }
    }
  }

  const metrics = computeMetrics(trades);
  const runId = `bt_${Date.now()}`;
  const gitCommit = execSync('git rev-parse HEAD').toString().trim();
  const envSnapshot = {
    DB_NAME: process.env.DB_NAME,
    RISK_DEBUG: process.env.RISK_DEBUG,
    MAX_OPEN_TRADES: process.env.MAX_OPEN_TRADES,
    NODE_ENV: process.env.NODE_ENV,
  };

  const output = {
    runId,
    symbol,
    token,
    seed,
    startedAt: candles[0]?.timestamp,
    endedAt: candles[candles.length - 1]?.timestamp,
    metrics,
    trades,
    configSnapshot: {
      env: envSnapshot,
      gitCommit,
      seed,
      generatedAt: dayjs(clock.now()).toISOString(),
    },
  };

  await db.collection('bt_runs').insertOne(output);
  const outDir = path.join(process.cwd(), 'bt_output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${runId}.json`);
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`Backtest completed: ${outFile}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export { applyCosts, computeMetrics, parseArgs, pnlForTrade };
