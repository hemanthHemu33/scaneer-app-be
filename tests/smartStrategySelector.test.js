import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectMarketRegime,
  filterStrategiesByRegime,
  marketContext,
} from '../smartStrategySelector.js';

test('detectMarketRegime identifies trending market', () => {
  marketContext.history = [];
  let regime = detectMarketRegime({ ema50: 105, ema200: 100, adx: 25, vix: 15, breadth: 1.1 });
  regime = detectMarketRegime({ ema50: 105, ema200: 100, adx: 25, vix: 15, breadth: 1.1 });
  assert.equal(regime, 'trending');
});

test('filterStrategiesByRegime filters by regime rules', () => {
  marketContext.regime = 'choppy';
  const strategies = [
    { name: 'Breakout', category: 'breakout' },
    { name: 'Mean', category: 'mean-reversion' },
  ];
  const filtered = filterStrategiesByRegime(strategies, marketContext);
  assert.deepEqual(filtered.map((s) => s.name), ['Mean']);
});
