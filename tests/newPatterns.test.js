import test from 'node:test';
import assert from 'node:assert/strict';

const kiteMock = test.mock.module('../kite.js', { namedExports: { getMA: () => null } });
const featureMock = test.mock.module('../featureEngine.js', {
  namedExports: {
    computeFeatures: () => ({ ema9: 0, ema21: 0, ema200: 0, rsi: 50 })
  }
});
const utilMock = test.mock.module('../util.js', { namedExports: { confirmRetest: () => true, detectAllPatterns: () => [] } });
const dbMock = test.mock.module('../db.js', { defaultExport: {}, namedExports: { connectDB: async () => ({}) } });

const { evaluateStrategies } = await import('../strategies.js');

kiteMock.restore();
featureMock.restore();
utilMock.restore();
dbMock.restore();

test('Breakout above Resistance detected', () => {
  const candles = [
    { open: 100, high: 101, low: 99, close: 100, volume: 100 },
    { open: 100, high: 101.5, low: 99.5, close: 101, volume: 110 },
    { open: 101, high: 103, low: 100, close: 103, volume: 150 }
  ];
  const res = evaluateStrategies(candles, {}, { topN: 5 });
  const found = res.find(r => r.name === 'Breakout above Resistance');
  assert.ok(found);
});

test('Gap Down Breakdown detected', () => {
  const candles = [
    { open: 105, high: 105, low: 104, close: 105, volume: 100 },
    { open: 103, high: 104, low: 102, close: 102, volume: 150 }
  ];
  const res = evaluateStrategies(candles, {}, { topN: 5 });
  const found = res.find(r => r.name === 'Gap Down Breakdown');
  assert.ok(found);
});
