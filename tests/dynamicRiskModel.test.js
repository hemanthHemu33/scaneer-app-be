import test from 'node:test';
import assert from 'node:assert/strict';

const riskMock = test.mock.module('../riskValidator.js', {
  namedExports: { validateRR: () => ({ valid: true, rr: 2, minRR: 1 }) }
});

import {
  calculateDynamicStopLoss,
  calculateLotSize,
  checkExposureCap,
  adjustRiskBasedOnDrawdown,
} from '../dynamicRiskModel.js';

riskMock.restore();

test('calculateDynamicStopLoss uses ATR multiplier', () => {
  const sl = calculateDynamicStopLoss({ atr: 2, entry: 100, direction: 'Long' });
  assert.equal(sl, 97); // 1.5 * 2 below entry
});

test('calculateLotSize respects risk amount', () => {
  const qty = calculateLotSize({
    capital: 100000,
    riskAmount: 1000,
    entry: 100,
    stopLoss: 95,
    capUtil: 1,
  });
  assert.equal(qty, 200);
});

test('checkExposureCap blocks excess exposure', () => {
  const allowed = checkExposureCap({
    positions: { A: { value: 10000, sector: 'IT' } },
    instrument: 'A',
    sector: 'IT',
    tradeValue: 15000,
    totalCapital: 100000,
    caps: { instrument: 0.1, sector: { IT: 0.25 } },
  });
  assert.equal(allowed, false);
});

test('adjustRiskBasedOnDrawdown scales size', () => {
  const size = adjustRiskBasedOnDrawdown({ drawdown: 0.06, lotSize: 100 });
  assert.equal(size, 50);
});
