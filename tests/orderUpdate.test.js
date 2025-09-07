import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
process.env.NODE_ENV = 'test';

const emitter = new EventEmitter();
const kiteMock = test.mock.module('../kite.js', {
  namedExports: {
    orderEvents: emitter,
    onOrderUpdate: (cb) => emitter.on('update', cb),
    kc: {},
    getTokenForSymbol: async () => 123,
    getHistoricalData: async () => [],
    initSession: async () => {},
    getMA: () => null
  }
});

const { addOpenTrade, getOpenTrade } = await import('../orderExecution.js');

let received;
emitter.on('update', (u) => { received = u; });

await addOpenTrade('e1', { entryId: 'e1', slId: 's1', targetId: 't1', status: 'OPEN' });
emitter.emit('update', { order_id: 'e1', status: 'COMPLETE' });
await new Promise((r) => setTimeout(r, 10));

test('order update listener updates trades map', async () => {
  assert.deepEqual(received, { order_id: 'e1', status: 'COMPLETE' });
  const trade = await getOpenTrade('e1');
  assert.equal(trade, null);
});

kiteMock.restore();
