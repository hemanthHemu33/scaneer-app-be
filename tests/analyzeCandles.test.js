import test from 'node:test';
import assert from 'node:assert/strict';

const kiteMock = test.mock.module('../kite.js', {
  namedExports: {
    getHigherTimeframeData: async () => ({
      ema50: 100,
      supertrend: { signal: 'Buy' }
    }),
    candleHistory: {}
  }
});

const utilMock = test.mock.module('../util.js', {
  namedExports: {
    calculateEMA: () => 100,
    calculateRSI: () => 60,
    calculateSupertrend: () => ({ signal: 'Buy' }),
    getMAForSymbol: () => 100,
    getATR: () => 2.5,
    debounceSignal: () => true,
    detectAllPatterns: () => [
      {
        type: 'Breakout',
        breakout: 105,
        stopLoss: 100,
        direction: 'Long',
        strength: 3,
        confidence: 'High'
      }
    ]
  }
});

const dbMock = test.mock.module('../db.js', {
  defaultExport: {},
  namedExports: {
    connectDB: async () => ({})
  }
});

const { analyzeCandles } = await import('../scanner.js');

test('analyzeCandles returns a signal for valid data', async () => {
  const candles = [
    { open: 100, high: 102, low: 98, close: 101, volume: 100 },
    { open: 101, high: 103, low: 99, close: 102, volume: 110 },
    { open: 102, high: 104, low: 100, close: 103, volume: 120 },
    { open: 103, high: 105, low: 101, close: 104, volume: 130 },
    { open: 104, high: 106, low: 102, close: 105, volume: 140 }
  ];

  const signal = await analyzeCandles(
    candles,
    'TEST',
    null,
    0,
    0,
    0,
    0.5,
    5000,
    null
  );
  assert.ok(signal);
  assert.equal(signal.stock, 'TEST');
  assert.equal(signal.pattern, 'Breakout');
  kiteMock.restore();
  utilMock.restore();
  dbMock.restore();
});
