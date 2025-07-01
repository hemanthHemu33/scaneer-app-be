import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';

// Prevent actual DB connections
const dbMock = test.mock.module('../db.js', {
  defaultExport: {
    collection: () => ({})
  },
  namedExports: {
    connectDB: async () => ({ collection: () => ({}) })
  }
});

// Avoid audit logger side effects
const auditMock = test.mock.module('../auditLogger.js', {
  namedExports: {
    logSignalRejected: () => {},
    logSignalCreated: () => {}
  }
});

let placed = [];
let cancelled = [];
let orders = [];

const execMock = test.mock.module('../orderExecution.js', {
  namedExports: {
    placeOrder: async (variety, order) => {
      const id = `id${placed.length + 1}`;
      placed.push({ variety, order, id });
      orders.push({ order_id: id, status: 'COMPLETE' });
      return { order_id: id };
    },
    cancelOrder: async (variety, id) => {
      cancelled.push({ variety, id });
      return {};
    },
    getAllOrders: async () => orders,
  },
});

const mod = await import('../tradeLifecycle.js');

await mod.executeSignal(
  {
    stock: 'AAA',
    direction: 'Long',
    entry: 100,
    stopLoss: 95,
    target2: 110,
  },
  { capital: 100000 }
);

execMock.restore();
dbMock.restore();
auditMock.restore();

test('executeSignal places entry, sl and target orders', () => {
  assert.equal(placed.length, 3);
});

test('executeSignal cancels opposite order after fill', () => {
  assert.equal(cancelled.length, 1);
});
