import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSMA,
  calculateWMA,
  calculateMACD,
  calculateLinearRegression,
  calculateStochastic,
  calculateForceIndex,
  calculateWilliamsR,
  calculateStdDev,
  calculateBollingerBands,
  calculateKeltnerChannels,
  calculateDonchianChannels,
  calculateChaikinVolatility,
  calculateHistoricalVolatility,
  calculateFractalChaosBands,
  calculateEnvelopes,
  calculateOBV,
  calculateCMF,
  calculateMFI,
  calculateAnchoredVWAP
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

test('calculateStdDev matches expected', () => {
  const sd = calculateStdDev([1, 2, 3], 3);
  assert.ok(Math.abs(sd - 0.816496) < 1e-5);
});

test('calculateBollingerBands returns bands', () => {
  const bb = calculateBollingerBands([1, 2, 3, 4, 5], 5, 2);
  assert.ok(bb && Math.abs(bb.middle - 3) < 1e-6);
});

test('calculateKeltnerChannels returns channels', () => {
  const candles = [
    { high: 10, low: 8, close: 9 },
    { high: 11, low: 9, close: 10 },
    { high: 12, low: 10, close: 11 },
    { high: 13, low: 11, close: 12 },
    { high: 14, low: 12, close: 13 }
  ];
  const kc = calculateKeltnerChannels(candles, 3, 2, 1);
  assert.ok(kc && typeof kc.upper === 'number');
});

test('calculateDonchianChannels returns channels', () => {
  const candles = [
    { high: 10, low: 8 },
    { high: 11, low: 9 },
    { high: 12, low: 10 }
  ];
  const dc = calculateDonchianChannels(candles, 3);
  assert.ok(dc && dc.upper === 12 && dc.lower === 8);
});

test('calculateChaikinVolatility returns number', () => {
  const candles = [
    { high: 10, low: 8 },
    { high: 11, low: 9 },
    { high: 12, low: 10 },
    { high: 13, low: 11 },
    { high: 14, low: 12 },
    { high: 15, low: 13 }
  ];
  const cv = calculateChaikinVolatility(candles, 2, 2);
  assert.equal(typeof cv, 'number');
});

test('calculateHistoricalVolatility returns number', () => {
  const hv = calculateHistoricalVolatility([1, 2, 3, 4, 5], 4, 252);
  assert.equal(typeof hv, 'number');
});

test('calculateFractalChaosBands returns bands', () => {
  const candles = [
    { high: 10, low: 8 },
    { high: 12, low: 7 },
    { high: 11, low: 6 },
    { high: 13, low: 9 },
    { high: 12, low: 8 }
  ];
  const fcb = calculateFractalChaosBands(candles, 1);
  assert.ok(fcb && typeof fcb.upper === 'number');
});

test('calculateEnvelopes returns bands', () => {
  const env = calculateEnvelopes([1, 2, 3, 4, 5], 5, 0.1);
  assert.ok(env && typeof env.upper === 'number');
});

test('calculateOBV sums volume based on closes', () => {
  const candles = [
    { close: 10, volume: 100 },
    { close: 11, volume: 150 },
    { close: 10, volume: 200 }
  ];
  const obv = calculateOBV(candles);
  assert.equal(obv, -50);
});

test('calculateCMF returns number', () => {
  const candles = [
    { high: 10, low: 8, close: 9, volume: 100 },
    { high: 11, low: 9, close: 10, volume: 120 }
  ];
  const cmf = calculateCMF(candles, 2);
  assert.equal(typeof cmf, 'number');
});

test('calculateMFI returns number', () => {
  const candles = [
    { high: 10, low: 8, close: 9, volume: 100 },
    { high: 11, low: 9, close: 10, volume: 110 },
    { high: 12, low: 10, close: 11, volume: 120 }
  ];
  const mfi = calculateMFI(candles, 2);
  assert.equal(typeof mfi, 'number');
});

test('calculateAnchoredVWAP returns number', () => {
  const candles = [
    { high: 10, low: 8, close: 9, volume: 100 },
    { high: 11, low: 9, close: 10, volume: 100 }
  ];
  const avwap = calculateAnchoredVWAP(candles);
  assert.equal(typeof avwap, 'number');
});
