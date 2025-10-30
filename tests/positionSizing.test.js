import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';

const dbMock = test.mock.module('../db.js', {
  defaultExport: {},
  namedExports: { connectDB: async () => ({}) }
});
const kiteMock = test.mock.module('../kite.js', {
  namedExports: {
    getMA: () => null,
    onOrderUpdate: () => {},
    orderEvents: { on: () => {} }
  }
});

const {
  calculatePositionSize,
  kellyCriterionSize,
  equalCapitalAllocation,
  estimateRequiredMarginPerLot,
} = await import('../positionSizing.js');
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

test('min and max qty constraints applied', () => {
  const qty = calculatePositionSize({
    capital: 100000,
    risk: 1000,
    slPoints: 10,
    minQty: 20,
    maxQty: 50,
  });
  assert.equal(qty, 50);
});

test('marginBuffer reduces allowed quantity', () => {
  const qty = calculatePositionSize({
    capital: 5000,
    risk: 1000,
    slPoints: 10,
    price: 100,
    marginPercent: 0.5,
    marginBuffer: 1.2,
  });
  assert.equal(qty, 83);
});

test('costBuffer inflates stop distance before sizing', () => {
  const qty = calculatePositionSize({
    capital: 10000,
    risk: 1000,
    slPoints: 10,
    costBuffer: 1.1,
  });
  assert.equal(qty, 90);
});

test('slippage and spread reduce position size', () => {
  const qty = calculatePositionSize({
    capital: 10000,
    risk: 1000,
    slPoints: 10,
    slippage: 1,
    spread: 1,
  });
  assert.equal(qty, 83);
});

test('estimateRequiredMarginPerLot applies buffers consistently', () => {
  const margin = estimateRequiredMarginPerLot({
    price: 100,
    lotSize: 10,
    marginPercent: 0.2,
    exchangeMarginMultiplier: 1.5,
    marginBuffer: 1.1,
  });
  assert.equal(margin, 100 * 10 * 0.2 * 1.5 * 1.1);
});

test('kellyCriterionSize computes fraction', () => {
  const qty = kellyCriterionSize({
    capital: 100000,
    winRate: 0.6,
    winLossRatio: 2,
    slPoints: 10,
  });
  assert.equal(qty, 4000);
});

test('equalCapitalAllocation splits capital', () => {
  const qty = equalCapitalAllocation({ capital: 100000, numPositions: 5, price: 100 });
  assert.equal(qty, 200);
});

