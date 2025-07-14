import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';

const dbMock = test.mock.module('../db.js', {
  defaultExport: {},
  namedExports: { connectDB: async () => ({}) }
});
const kiteMock = test.mock.module('../kite.js', { namedExports: { getMA: () => null } });

const { calculatePositionSize } = await import('../positionSizing.js');
const { atrStopLossDistance, calculateRequiredMargin } = await import('../util.js');

kiteMock.restore();
dbMock.restore();

// Example from docs: ₹10,000 risk, 15 point SL, lot size 330 => 660 qty

test('calculatePositionSize computes lot size correctly', () => {
  const qty = calculatePositionSize({
    capital: 100000, // total capital not used when risk provided
    risk: 10000,
    slPoints: 15,
    lotSize: 330,
    volatility: 2,
  });
  assert.equal(qty, 660);
});

test('atrStopLossDistance returns atr multiple', () => {
  const dist = atrStopLossDistance(2, 'breakout');
  assert.equal(dist, 4);
});

test('calculateRequiredMargin uses leverage', () => {
  const margin = calculateRequiredMargin({ price: 100, qty: 10, leverage: 5 });
  assert.equal(margin, 200);
});

test('leverage limits position size', () => {
  const qty = calculatePositionSize({
    capital: 10000,
    risk: 5000,
    slPoints: 1,
    price: 100,
    leverage: 1,
  });
  // Without leverage restriction qty would be 5000
  assert.equal(qty, 100); // capped by margin
});

