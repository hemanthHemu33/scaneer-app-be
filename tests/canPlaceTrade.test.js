import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';

const kiteMock = test.mock.module('../kite.js', {
  namedExports: {
    onOrderUpdate: () => {},
    orderEvents: { on: () => {} },
    kc: {
      orderMargins: async (order) => ({ required: order.quantity * 5000 }),
    },
    getTokenForSymbol: async () => 123,
    getHistoricalData: async () => [],
    initSession: async () => {},
    getMA: () => null
  }
});

const accountMock = test.mock.module('../account.js', {
  namedExports: {
    getAccountMargin: async () => ({ equity: { available: { cash: 10000 } } }),
  },
});

const orderMod = await import('../orderExecution.js');

accountMock.restore();

const res = await orderMod.canPlaceTrade({ symbol: 'AAA', direction: 'Long' });

kiteMock.restore();

test('canPlaceTrade computes quantity using margin', () => {
  assert.equal(res.canPlace, true);
  assert.equal(res.quantity, 2);
});
