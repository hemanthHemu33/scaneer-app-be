import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';

const kiteMock = test.mock.module('../kite.js', {
  namedExports: {
    getHigherTimeframeData: async () => ({
      ema50: 100,
      supertrend: { signal: 'Buy' }
    }),
    candleHistory: {},
    getSupportResistanceLevels: () => ({ support: 90, resistance: 110 })
  }
});

const utilMock = test.mock.module('../util.js', {
  namedExports: {
    calculateEMA: (prices, period) => {
      if (period === 9) return 105;
      if (period === 21) return 100;
      if (period === 50) return 95;
      if (period === 200) return 90;
      return 100;
    },
    calculateRSI: () => 60,
    calculateSupertrend: () => ({ signal: 'Buy' }),
    calculateVWAP: () => 100,
    getMAForSymbol: () => 100,
    getATR: () => 2.5,
    calculateExpiryMinutes: () => 10,
    debounceSignal: () => true,
    confirmRetest: () => true,
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
    { open: 104, high: 106, low: 103.8, close: 106, volume: 150 },
    { open: 106, high: 107, low: 105, close: 107, volume: 170 }
  ];

  const signal = await analyzeCandles(
    candles,
    'TEST',
    null,
    0,
    0,
    0,
    0.2,
    5000,
    null
  );
  assert.ok(signal);
  assert.equal(signal.stock, 'TEST');
  assert.equal(signal.pattern, 'Breakout');
  assert.ok(signal.expiresAt);
  assert.equal(signal.support, 90);
  assert.equal(signal.resistance, 110);
  kiteMock.restore();
  utilMock.restore();
  dbMock.restore();
});
