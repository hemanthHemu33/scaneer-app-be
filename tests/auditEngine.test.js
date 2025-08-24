import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';

const executed = [{ signalId: 'A', timestamp: new Date() }];
const trades = [
  { signalId: 'A', timestamp: new Date() },
  { signalId: 'B', timestamp: new Date() },
];

const dbMock = test.mock.module('../db.js', {
  defaultExport: {
    collection: (name) => ({
      find: () => ({
        toArray: async () => (name === 'executed_signals' ? executed : trades),
      }),
    }),
  },
  namedExports: { connectDB: async () => ({}) },
});

const loggerMock = test.mock.module('../logger.js', {
  namedExports: { logError: () => {} },
});

const { reconcileOrders } = await import('../auditEngine.js');

dbMock.restore();
loggerMock.restore();

const result = await reconcileOrders(new Date());

test('reconcileOrders detects discrepancies', () => {
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unexpected, ['B']);
});
