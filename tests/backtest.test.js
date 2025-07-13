import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';

const dbMock = test.mock.module('../db.js', {
  defaultExport: {},
  namedExports: { connectDB: async () => ({}) }
});

const { simulateSignals } = await import('../backtest.js');

const candles = [
  { high: 1.15, low: 0.95, close: 1.1 },
  { high: 1.25, low: 1.0, close: 1.2 },
  { high: 1.4, low: 1.2, close: 1.35 },
  { high: 1.6, low: 1.3, close: 1.5 },
  { high: 1.7, low: 1.4, close: 1.6 },
];

const signals = [
  { entry: 1.2, stopLoss: 1.1, target2: 1.4, direction: 'Long', index: 1 },
  { entry: 1.5, stopLoss: 1.6, target2: 1.3, direction: 'Short', index: 3 },
];

const result = simulateSignals(signals, candles);

test('simulateSignals calculates win rate and RR', () => {
  assert.equal(result.trades, 2);
  assert.equal(result.winRate, 0.5);
  assert.ok(result.avgRR > 1);
});
