import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';

let inserted = [];

const dbMock = test.mock.module('../db.js', {
  defaultExport: {
    collection: () => ({
      insertOne: async (doc) => {
        inserted.push(doc);
      }
    })
  },
  namedExports: { connectDB: async () => ({}) }
});

const {
  recordSignalOutcome,
  shouldThrottle,
  adjustConfidence,
  _getStats
} = await import('../feedbackEngine.js');

dbMock.restore();

_testCleanup();
function _testCleanup(){
  inserted = [];
  _getStats().clear && _getStats().clear();
}

// Use a hook for each test to reset state

test('recordSignalOutcome stores result and updates stats', async () => {
  _testCleanup();
  await recordSignalOutcome({ pattern: 'strat', stock: 'AAA' }, 1);
  const stat = _getStats().get('strat');
  assert.equal(stat.wins, 1);
  assert.equal(stat.trades, 1);
  assert.equal(inserted.length, 1);
});

test('shouldThrottle flags low win rate strategies', () => {
  _testCleanup();
  _getStats().set('low', { wins: 1, trades: 5 });
  assert.equal(shouldThrottle('low'), true);
});

test('adjustConfidence scales confidence with win rate', () => {
  _testCleanup();
  _getStats().set('hi', { wins: 4, trades: 5 });
  const sig = { pattern: 'hi', confidence: 0.5 };
  adjustConfidence(sig);
  assert.ok(sig.confidence > 0.5);
});
