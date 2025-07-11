import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSMA,
  calculateWMA,
  calculateMACD,
  calculateLinearRegression,
  calculateStochastic,
  calculateForceIndex,
  calculateWilliamsR
} from '../featureEngine.js';

test('calculateSMA computes average', () => {
  const sma = calculateSMA([1, 2, 3, 4, 5], 5);
  assert.equal(sma, 3);
});

test('calculateWMA applies weights', () => {
  const wma = calculateWMA([1, 2, 3], 3);
  assert.ok(Math.abs(wma - 2.333333) < 1e-6);
});

test('calculateMACD returns object', () => {
  const res = calculateMACD([1,2,3,4,5,6,7,8,9,10], 3, 5, 2);
  assert.ok(res && typeof res.macd === 'number');
});

test('calculateLinearRegression slope about 1', () => {
  const res = calculateLinearRegression([1,2,3,4,5], 5);
  assert.ok(Math.abs(res.slope - 1) < 1e-6);
});

test('calculateStochastic returns k and d', () => {
  const data = [
    { high: 10, low: 5, close: 7 },
    { high: 11, low: 6, close: 10 },
    { high: 12, low: 6, close: 11 }
  ];
  const res = calculateStochastic(data, 3, 3);
  assert.ok(res && typeof res.k === 'number' && typeof res.d === 'number');
});

test('calculateForceIndex returns number', () => {
  const candles = [
    { close: 10, volume: 100 },
    { close: 11, volume: 120 }
  ];
  const fi = calculateForceIndex(candles, 1);
  assert.equal(typeof fi, 'number');
});

test('calculateWilliamsR returns number', () => {
  const data = [
    { high: 10, low: 5, close: 7 },
    { high: 11, low: 6, close: 10 },
    { high: 12, low: 6, close: 11 }
  ];
  const wr = calculateWilliamsR(data, 3);
  assert.equal(typeof wr, 'number');
});
