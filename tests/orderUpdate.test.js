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
    symbolTokenMap: {},
    getHistoricalData: async () => [],
    initSession: async () => {},
    getMA: () => null
  }
});

const { openTrades } = await import('../orderExecution.js');

let received;
emitter.on('update', (u) => { received = u; });

openTrades.set('e1', { entryId: 'e1', slId: 's1', targetId: 't1', status: 'OPEN' });
emitter.emit('update', { order_id: 'e1', status: 'COMPLETE' });

test('order update listener updates trades map', () => {
  assert.deepEqual(received, { order_id: 'e1', status: 'COMPLETE' });
  assert.equal(openTrades.has('e1'), false);
});

kiteMock.restore();
