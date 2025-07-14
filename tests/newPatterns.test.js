import test from 'node:test';
import assert from 'node:assert/strict';

const kiteMock = test.mock.module('../kite.js', { namedExports: { getMA: () => null } });
const featureMock = test.mock.module('../featureEngine.js', {
  namedExports: {
    calculateEMA: () => 0,
    calculateRSI: () => 50,
    calculateSupertrend: () => ({ signal: 'Sell' }),
    calculateVWAP: () => 0,
    getATR: () => 1,
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

test('Gap Up + Bullish Marubozu detected', () => {
  const candles = [
    { open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 },
    { open: 102, high: 103, low: 102, close: 103, volume: 200 }
  ];
  const res = evaluateStrategies(candles, {}, { topN: 5 });
  const found = res.find(r => r.name === 'Gap Up + Bullish Marubozu');
  assert.ok(found);
});

test('Breakaway Gap (Bullish) detected', () => {
  const candles = [
    { open: 99, high: 100, low: 98.5, close: 99.2, volume: 80 },
    { open: 99.1, high: 100, low: 98.8, close: 99, volume: 80 },
    { open: 99, high: 100.2, low: 98.7, close: 99.1, volume: 80 },
    { open: 99.2, high: 100.1, low: 98.9, close: 99.3, volume: 80 },
    { open: 101.5, high: 102, low: 100.8, close: 101.8, volume: 200 }
  ];
  const res = evaluateStrategies(candles, {}, { topN: 5 });
  const found = res.find(r => r.name === 'Breakaway Gap (Bullish)');
  assert.ok(found);
});

test('Gap Down + Bearish Marubozu detected', () => {
  const candles = [
    { open: 100, high: 100, low: 99.8, close: 100, volume: 100 },
    { open: 98, high: 98, low: 97.9, close: 97.9, volume: 150 }
  ];
  const res = evaluateStrategies(candles, {}, { topN: 5 });
  const found = res.find(r => r.name === 'Gap Down + Bearish Marubozu');
  assert.ok(found);
});

test('Breakaway Gap (Bearish) detected', () => {
  const candles = [
    { open: 100, high: 100.5, low: 99.5, close: 100, volume: 80 },
    { open: 100.2, high: 100.7, low: 99.6, close: 100.1, volume: 80 },
    { open: 100.1, high: 100.6, low: 99.7, close: 100, volume: 80 },
    { open: 100, high: 100.4, low: 99.5, close: 100, volume: 80 },
    { open: 97, high: 97.2, low: 96.8, close: 96.9, volume: 200 }
  ];
  const res = evaluateStrategies(candles, {}, { topN: 5 });
  const found = res.find(r => r.name === 'Breakaway Gap (Bearish)');
  assert.ok(found);
});

test('Gap Down + High Volume Confirmation detected', () => {
  const candles = [
    { open: 105, high: 105, low: 104, close: 105, volume: 100 },
    { open: 103, high: 103.5, low: 102.5, close: 103, volume: 250 }
  ];
  const res = evaluateStrategies(candles, {}, { topN: 5 });
  const found = res.find(r => r.name === 'Gap Down + High Volume Confirmation');
  assert.ok(found);
});

test('Gap Down + RSI/MACD Bearish Divergence detected', () => {
  const candles = [
    { open: 100, high: 100.2, low: 99.8, close: 100, volume: 100 },
    { open: 98.3, high: 98.4, low: 97.9, close: 98, volume: 150 }
  ];
  const ctx = { features: { rsi: 40, macd: { histogram: -1 } } };
  const res = evaluateStrategies(candles, ctx, { topN: 5 });
  const found = res.find(r => r.name === 'Gap Down + RSI/MACD Bearish Divergence');
  assert.ok(found);
});

test('Gap Down + Trendline Breakdown detected', () => {
  const candles = [
    { open: 100, high: 101, low: 99, close: 100 },
    { open: 102, high: 103, low: 101, close: 102 },
    { open: 104, high: 105, low: 103, close: 104 },
    { open: 103, high: 104, low: 102, close: 103 },
    { open: 101, high: 101.5, low: 100, close: 100 }
  ];
  const res = evaluateStrategies(candles, {}, { topN: 5 });
  const found = res.find(r => r.name === 'Gap Down + Trendline Breakdown');
  assert.ok(found);
});

test('Gap Fill Reversal (Bearish) detected', () => {
  const candles = [
    { open: 100, high: 101, low: 99, close: 100, volume: 100 },
    { open: 103, high: 104, low: 98, close: 99, volume: 120 }
  ];
  const res = evaluateStrategies(candles, {}, { topN: 5 });
  const found = res.find(r => r.name === 'Gap Fill Reversal (Bearish)');
  assert.ok(found);
});

test('Island Reversal Top detected', () => {
  const candles = [
    { open: 100, high: 101, low: 99, close: 100, volume: 100 },
    { open: 102, high: 103, low: 102, close: 102.5, volume: 100 },
    { open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 }
  ];
  const res = evaluateStrategies(candles, {}, { topN: 5 });
  const found = res.find(r => r.name === 'Island Reversal Top');
  assert.ok(found);
});

test('Island Reversal Bottom detected', () => {
  const candles = [
    { open: 100, high: 101, low: 99, close: 100, volume: 100 },
    { open: 98, high: 98.5, low: 97.5, close: 98, volume: 100 },
    { open: 100, high: 101, low: 99.5, close: 100.5, volume: 100 }
  ];
  const res = evaluateStrategies(candles, {}, { topN: 5 });
  const found = res.find(r => r.name === 'Island Reversal Bottom');
  assert.ok(found);
});

test('Bull Trap After Gap Up detected', () => {
  const candles = [
    { open: 100, high: 101, low: 99, close: 101, volume: 100 },
    { open: 103, high: 104, low: 99, close: 100, volume: 110 }
  ];
  const res = evaluateStrategies(candles, {}, { topN: 5 });
  const found = res.find(r => r.name === 'Bull Trap After Gap Up');
  assert.ok(found);
});

test('Bear Trap After Gap Down detected', () => {
  const candles = [
    { open: 100, high: 101, low: 99, close: 99, volume: 100 },
    { open: 97, high: 100, low: 95, close: 99.5, volume: 110 }
  ];
  const res = evaluateStrategies(candles, {}, { topN: 5 });
  const found = res.find(r => r.name === 'Bear Trap After Gap Down');
  assert.ok(found);
});
