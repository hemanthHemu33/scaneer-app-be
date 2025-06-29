import test from 'node:test';
import assert from 'node:assert/strict';

import { validateRR, getMinRRForStrategy } from '../riskValidator.js';

test('validateRR respects strategy thresholds', () => {
  const res = validateRR({
    strategy: 'breakout',
    entry: 100,
    stopLoss: 95,
    target: 118,
  });
  assert.ok(res.valid); // RR = 3.6 >= 1.8
  assert.equal(getMinRRForStrategy('breakout'), 1.8);
});
