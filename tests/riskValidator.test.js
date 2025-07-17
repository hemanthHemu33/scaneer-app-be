import test from 'node:test';
import assert from 'node:assert/strict';

const auditMock = test.mock.module('../auditLogger.js', {
  namedExports: {
    logSignalRejected: () => {},
    logSignalExpired: () => {},
    logSignalMutation: () => {},
    logSignalCreated: () => {},
    logBacktestReference: () => {},
    getLogs: () => ({}),
  }
});
const kiteMock = test.mock.module('../kite.js', { namedExports: { getMA: () => null } });
const dbMock = test.mock.module('../db.js', {
  defaultExport: {
    collection: () => ({
      find: () => ({ toArray: async () => [] }),
      deleteMany: async () => {},
      insertMany: async () => {},
    }),
  },
  namedExports: { connectDB: async () => ({}) }
});

const { validateRR, getMinRRForStrategy } = await import('../riskValidator.js');

auditMock.restore();
kiteMock.restore();
dbMock.restore();

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
