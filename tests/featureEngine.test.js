import test from 'node:test';
import assert from 'node:assert/strict';

import { computeFeatures } from '../featureEngine.js';

const candles = Array.from({ length: 30 }, (_, i) => ({
  open: 100 + i,
  high: 101 + i,
  low: 99 + i,
  close: 100 + i,
  volume: 1000,
}));

const feat = computeFeatures(candles);

test('computeFeatures includes new metrics', () => {
  assert.ok('emaSlope' in feat);
  assert.ok('trendStrength' in feat);
  assert.ok('volatilityClass' in feat);
});
