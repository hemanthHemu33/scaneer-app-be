import test from 'node:test';
import assert from 'node:assert/strict';

const auditMock = test.mock.module('../auditLogger.js', {
  namedExports: { logSignalRejected: () => {} }
});
const dbMock = test.mock.module('../db.js', {
  defaultExport: {},
  namedExports: { connectDB: async () => ({}) }
});

const { isSignalValid, resetRiskState } = await import('../riskEngine.js');

auditMock.restore();
dbMock.restore();

test('isSignalValid blocks low RR', () => {
  resetRiskState();
  const sig = {
    stock: 'AAA',
    pattern: 'mean-reversion',
    direction: 'Long',
    entry: 100,
    stopLoss: 99,
    target2: 101,
    atr: 1,
    spread: 0.1,
  };
  const ok = isSignalValid(sig, { minATR: 0.5, maxATR: 5 });
  assert.equal(ok, false);
});

test('isSignalValid prevents duplicates', () => {
  resetRiskState();
  const sig = {
    stock: 'AAA',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 1,
    spread: 0.1,
  };
  assert.ok(isSignalValid(sig));
  const second = isSignalValid(sig);
  assert.equal(second, false);
});

test('isSignalValid respects ATR boundaries', () => {
  resetRiskState();
  const sig = {
    stock: 'BBB',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 6,
    spread: 0.1,
  };
  const ok = isSignalValid(sig, { minATR: 0.5, maxATR: 5 });
  assert.equal(ok, false);
});
