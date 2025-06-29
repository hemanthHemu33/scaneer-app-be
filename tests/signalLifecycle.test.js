import test from 'node:test';
import assert from 'node:assert/strict';

import { addSignal, activeSignals, checkExpiries } from '../signalManager.js';
process.env.NODE_ENV = 'test';

activeSignals.clear();

const now = Date.now();
const signal = { stock: 'TEST', direction: 'Long', expiresAt: new Date(now + 1000).toISOString(), confidence: 1 };

addSignal(signal);

checkExpiries(now + 2000);

test('signal expires after expiry time', () => {
  const info = activeSignals.get('TEST');
  assert.equal(info.status, 'expired');
});
