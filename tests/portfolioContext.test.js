import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';

let savedPositions = [];
const dbMock = test.mock.module('../db.js', {
  defaultExport: {
    collection: () => ({
      deleteMany: async () => {},
      insertMany: async (docs) => { savedPositions = docs; return {}; },
    }),
  },
});

const telegramMock = test.mock.module('../telegram.js', {
  namedExports: { sendNotification: () => {} }
});

const broker = { getPositions: async () => [
  { symbol: 'AAA', side: 'long', qty: 10, entryPrice: 100, sector: 'IT' }
] };

const {
  openPositions,
  trackOpenPositions,
  checkExposureLimits,
  preventReEntry,
  resolveSignalConflicts,
  recordExit,
} = await import('../portfolioContext.js');

dbMock.restore();
telegramMock.restore();

await trackOpenPositions(broker, dbMock.defaultExport);

test('trackOpenPositions loads positions', () => {
  assert.equal(openPositions.size, 1);
  assert.ok(openPositions.has('AAA'));
  assert.equal(savedPositions.length, 1);
});

openPositions.clear();
openPositions.set('AAA', { qty: 5, entryPrice: 100, sector: 'IT', side: 'long', strategy: 'trend-following' });

const allowed = checkExposureLimits({ symbol: 'BBB', tradeValue: 600, sector: 'IT', totalCapital: 1000 });

test('checkExposureLimits blocks high exposure', () => {
  assert.equal(allowed, false);
});

recordExit('AAA');

test('preventReEntry blocks within window', () => {
  const ok = preventReEntry('AAA', 1000000); // large window
  assert.equal(ok, false);
});

openPositions.clear();
openPositions.set('AAA', { side: 'long', strategy: 'trend-following' });

test('resolveSignalConflicts rejects opposite signal', () => {
  const r = resolveSignalConflicts({ symbol: 'AAA', side: 'short', strategy: 'mean-reversion' });
  assert.equal(r, false);
});
