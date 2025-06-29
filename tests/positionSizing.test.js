import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';

import { calculatePositionSize } from '../positionSizing.js';

// Example from docs: ₹10,000 risk, 15 point SL, lot size 330 => 660 qty

test('calculatePositionSize computes lot size correctly', () => {
  const qty = calculatePositionSize({
    capital: 100000, // total capital not used when risk provided
    risk: 10000,
    slPoints: 15,
    lotSize: 330,
    volatility: 2,
  });
  assert.equal(qty, 660);
});

