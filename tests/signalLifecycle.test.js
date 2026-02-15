import test from 'node:test';
import assert from 'node:assert/strict';

const auditMock = test.mock.module('../auditLogger.js', {
  namedExports: { logSignalExpired: () => {}, logSignalMutation: () => {} }
});
const dbMock = test.mock.module('../db.js', {
  defaultExport: {
    collection: () => ({
      updateOne: async () => {},
      insertOne: async () => ({ acknowledged: true, insertedId: 'mock-id' }),
    }),
  },
  namedExports: { connectDB: async () => ({}) }
});

const { addSignal, activeSignals, checkExpiries, setSignalManagerClock, resetSignalManagerClock } = await import('../signalManager.js');

auditMock.restore();
dbMock.restore();
process.env.NODE_ENV = 'test';

test.after(() => {
  resetSignalManagerClock();
});

activeSignals.clear();
setSignalManagerClock({ now: () => 10_000 });

const signal = {
  stock: 'TEST',
  direction: 'Long',
  expiresAt: new Date(11_000).toISOString(),
  confidence: 1,
};

const created = await addSignal(signal);
await checkExpiries(12_000);

test('signal id generation uses injected clock', () => {
  assert.equal(created.signalId, 'TEST-10000');
});

test('signal expires after expiry time', () => {
  const sigMap = activeSignals.get('TEST');
  const info = sigMap.get(created.signalId);
  assert.equal(info.status, 'expired');
});
