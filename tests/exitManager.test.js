import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../exitManager.js');
const { setTrailingPercent, applyTrailingSL, forceTimeExit, detectReversalExit, checkExitConditions } = mod;

setTrailingPercent(10); // easier to test

test('applyTrailingSL updates stop and signals exit', () => {
  const pos = { side: 'Long', entryPrice: 100, stopLoss: 95, lastPrice: 110 };
  let exit = applyTrailingSL(pos);
  assert.equal(exit, false);
  assert.ok(pos.stopLoss > 95);
  pos.lastPrice = 98;
  exit = applyTrailingSL(pos);
  assert.equal(exit, true);
});

test('forceTimeExit triggers after maxHoldMs', () => {
  const pos = { openTime: Date.now() - 6000, maxHoldMs: 5000 };
  assert.equal(forceTimeExit(pos), true);
});

test('detectReversalExit finds simple reversal', () => {
  const pos = { side: 'Long', history: [105,104,103] };
  assert.equal(detectReversalExit(pos), true);
});

test('checkExitConditions returns first matching reason', () => {
  const pos = { side: 'Long', entryPrice: 100, stopLoss: 90, lastPrice: 80 };
  assert.equal(checkExitConditions(pos), 'trailing');
});
