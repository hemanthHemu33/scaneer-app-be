import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../exitManager.js');
const {
  setTrailingPercent,
  applyTrailingSL,
  forceTimeExit,
  detectReversalExit,
  checkExitConditions,
  setExitClock,
  resetExitClock,
  shouldExit,
} = mod;

setTrailingPercent(10); // easier to test

test.after(() => {
  resetExitClock();
});

test('applyTrailingSL updates stop and signals exit', () => {
  const pos = { side: 'Long', entryPrice: 100, stopLoss: 95, lastPrice: 110 };
  let exit = applyTrailingSL(pos);
  assert.equal(exit, false);
  assert.ok(pos.stopLoss > 95);
  pos.lastPrice = 98;
  exit = applyTrailingSL(pos);
  assert.equal(exit, true);
});

test('forceTimeExit triggers after maxHoldMs using injected clock', () => {
  setExitClock({ now: () => 10_000 });
  const pos = { openTime: 4_000, maxHoldMs: 5_000 };
  assert.equal(forceTimeExit(pos), true);
});

test('detectReversalExit finds simple reversal', () => {
  const pos = { side: 'Long', history: [105,104,103] };
  assert.equal(detectReversalExit(pos), true);
});

test('checkExitConditions returns first matching reason', () => {
  const pos = { side: 'Long', entryPrice: 100, stopLoss: 90, lastPrice: 80 };
  const res = checkExitConditions(pos);
  assert.deepEqual(res, { shouldExit: true, reason: 'TrailingStop' });
});

test('shouldExit respects expiry with injected clock', () => {
  setExitClock({ now: () => 2_000 });
  assert.equal(shouldExit({ direction: 'Long', stopLoss: 95, expiresAt: new Date(1_000).toISOString() }, 100), true);
});
