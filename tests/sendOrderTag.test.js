import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';

const kiteMock = test.mock.module('../kite.js', {
  namedExports: {
    kc: { placeOrder: async (params) => params },
    symbolTokenMap: {},
    historicalCache: {},
    initSession: async () => {},
    onOrderUpdate: () => {},
    getMA: () => {},
  }
});

const dbMock = test.mock.module('../db.js', {
  defaultExport: { collection: () => ({}) },
  namedExports: { connectDB: async () => ({ collection: () => ({}) }) }
});

const auditMock = test.mock.module('../auditLogger.js', {
  namedExports: { logSignalRejected: () => {}, logSignalCreated: () => {} }
});

const { sendOrder } = await import('../orderExecution.js');

const res = await sendOrder('regular', {
  exchange: 'NSE',
  tradingsymbol: 'AAA',
  transaction_type: 'BUY',
  quantity: 1,
  order_type: 'MARKET',
  product: 'MIS',
  meta: { signalId: 'sig1', strategy: 'stratA', confidence: 'High' }
});

kiteMock.restore();
dbMock.restore();
auditMock.restore();

test('sendOrder adds tag from metadata', () => {
  assert.equal(res.tag, 'sig1_stratA_High');
});
