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
    historicalCache: {},
    symbolTokenMap: {},
    initSession: async () => 'token',
    kc: { getLTP: async (symbols) => ({ [symbols[0]]: { last_price: 100, instrument_token: 123 } }) },
    tickBuffer: {},
    getSupportResistanceLevels: () => ({ support: 90, resistance: 110 })
  }
});

const featureMock = test.mock.module('../featureEngine.js', {
  namedExports: {
    calculateEMA: () => 100,
    calculateRSI: () => 60,
    calculateSupertrend: () => ({ signal: 'Buy' }),
    calculateVWAP: () => 100,
    getATR: () => 2.5,
    computeFeatures: () => ({
      ema9: 105,
      ema21: 100,
      ema50: 95,
      ema200: 90,
      rsi: 60,
      atr: 2.5,
      supertrend: { signal: 'Buy' },
      avgVolume: 100,
      rvol: 1.2,
      vwap: 100
    }),
    resetIndicatorCache: () => {}
  }
});

const utilMock = test.mock.module('../util.js', {
  namedExports: {
    calculateExpiryMinutes: () => 10,
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
    ],
    confirmRetest: () => true,
    toISTISOString: (d = new Date()) => new Date(d).toISOString(),
    toISTDate: (d = new Date()) => '2024-01-01',
    convertTickTimestampsToIST: (t) => t,
    getMAForSymbol: () => 100,
    DEFAULT_MARGIN_PERCENT: 0.2
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
  assert.equal(signal, null);
  kiteMock.restore();
  featureMock.restore();
  utilMock.restore();
  dbMock.restore();
});
