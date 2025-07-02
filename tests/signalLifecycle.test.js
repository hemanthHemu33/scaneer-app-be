import test from 'node:test';
import assert from 'node:assert/strict';

const auditMock = test.mock.module('../auditLogger.js', {
  namedExports: { logSignalExpired: () => {}, logSignalMutation: () => {} }
});
const dbMock = test.mock.module('../db.js', {
  defaultExport: {},
  namedExports: { connectDB: async () => ({}) }
});

const { addSignal, activeSignals, checkExpiries } = await import('../signalManager.js');

auditMock.restore();
dbMock.restore();
process.env.NODE_ENV = 'test';

activeSignals.clear();

const now = Date.now();
const signal = {
  stock: 'TEST',
  direction: 'Long',
  expiresAt: new Date(now + 1000).toISOString(),
  confidence: 1,
  signalId: 'sig1',
};

addSignal(signal);

checkExpiries(now + 2000);

test('signal expires after expiry time', () => {
  const sigMap = activeSignals.get('TEST');
  const info = sigMap.get('sig1');
  assert.equal(info.status, 'expired');
});
