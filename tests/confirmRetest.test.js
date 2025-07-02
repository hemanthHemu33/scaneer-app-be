import test from 'node:test';
import assert from 'node:assert/strict';

const kiteMock = test.mock.module('../kite.js', { namedExports: { getMA: () => null } });
const dbMock = test.mock.module('../db.js', {
  defaultExport: {},
  namedExports: { connectDB: async () => ({}) }
});

const { confirmRetest } = await import('../util.js');

kiteMock.restore();
dbMock.restore();

test('confirmRetest validates pullback and strength', () => {
  const candles = [
    { open: 105, high: 105.5, low: 104.8, close: 105, volume: 100 },
    { open: 105, high: 106.5, low: 105, close: 106.4, volume: 150 }
  ];
  assert.equal(confirmRetest(candles, 105, 'Long'), true);
});
