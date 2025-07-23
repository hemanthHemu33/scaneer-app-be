import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';

const kiteMock = test.mock.module('../kite.js', {
  namedExports: {
    onOrderUpdate: () => {},
    orderEvents: { on: () => {} },
    kc: {},
    symbolTokenMap: {},
    historicalCache: {},
    initSession: async () => {}
  }
});

const orderMod = await import('../orderExecution.js');
const accountMod = await import('../account.js');

const marginMock = test.mock.method(accountMod, 'getAccountMargin', async () => ({
  equity: { available: { cash: 10000 } },
}));

const getMarginMock = test.mock.method(orderMod, 'getMarginForStock', async (
  order,
) => ({ required: order.quantity * 5000 }));

const res = await orderMod.canPlaceTrade({ symbol: 'AAA', direction: 'Long' });

getMarginMock.mock.restore();
marginMock.mock.restore();
kiteMock.restore();

test('canPlaceTrade computes quantity using margin', () => {
  assert.equal(res.canPlace, true);
  assert.equal(res.quantity, 2);
});
