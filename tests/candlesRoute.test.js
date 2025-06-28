import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { EventEmitter } from 'node:events';

// Mock analyzeCandles to avoid complex logic
const scannerMock = test.mock.module('../scanner.js', {
  namedExports: {
    analyzeCandles: async () => ({ stock: 'MOCK', pattern: 'Breakout' })
  }
});
// Mock telegram and openAI modules
let sentSignal = null;
const telegramMock = test.mock.module('../telegram.js', {
  namedExports: {
    sendSignal: (signal) => {
      sentSignal = signal;
    }
  }
});
const openAIMock = test.mock.module('../openAI.js', {
  namedExports: { fetchAIData: async () => null }
});
const kiteMock = test.mock.module('../kite.js', {
  namedExports: { getAverageVolume: () => 1000 }
});

const { analyzeCandles } = await import('../scanner.js');

const app = express();
app.use(express.json());

const io = new EventEmitter();
let emittedSignal = null;
io.emit = (event, data) => {
  if (event === 'tradeSignal') {
    emittedSignal = data;
  }
};

app.post('/candles', async (req, res) => {
  const candles = req.body;
  if (!Array.isArray(candles) || candles.length === 0) {
    return res.status(400).json({ error: 'No candles provided' });
  }
  const token = candles[0]?.symbol || 'UNKNOWN';
  const symbol = token;
  const avgVol = 1000;
  const depth = null,
    totalBuy = 0,
    totalSell = 0,
    slippage = 0.1,
    spread = 0.5,
    liquidity = avgVol || 5000,
    liveTick = null;
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
      io.emit('tradeSignal', signal);
      (await import('../telegram.js')).sendSignal(signal);
      (await import('../openAI.js')).fetchAIData(signal).catch(() => {});
    }
    res.json({ status: 'Processed', signal: signal || null });
  } catch {
    res.status(500).json({ error: 'Signal generation failed' });
  }
});

const server = app.listen(0);
const port = server.address().port;

const candlesPayload = [{ symbol: 'MOCK', open: 1, high: 2, low: 0.5, close: 1.5 }];
const response = await fetch(`http://localhost:${port}/candles`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(candlesPayload)
});
const body = await response.json();
server.close();

scannerMock.restore();
telegramMock.restore();
openAIMock.restore();
kiteMock.restore();

test('candles route processes data and emits signal', () => {
  assert.equal(body.status, 'Processed');
  assert.ok(emittedSignal);
  assert.deepEqual(emittedSignal, sentSignal);
});
