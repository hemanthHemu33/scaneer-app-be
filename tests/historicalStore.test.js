import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const db = (await import('../db.js')).default;
const { default: initHistoricalStore } = await import('../data/historicalStore.js');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function resetCollections() {
  await db.collection('historical_data').deleteMany({});
  await db.collection('historical_session_data').deleteMany({});
}

test('read-through cache miss then hit', async () => {
  await resetCollections();
  await db.collection('historical_data').insertOne({ token: 1, candles: [
    { date: '2020-01-01', open:1, high:1, low:1, close:1, volume:1 }
  ]});
  let miss=0, hit=0, loads=0;
  const store = initHistoricalStore({ metrics:{ onMiss:()=>miss++, onHit:()=>hit++, onLoadMs:()=>loads++ } });
  const first = await store.getDailyCandles(1);
  assert.equal(first.length,1);
  assert.equal(miss,1);
  assert.equal(loads,1);
  const second = await store.getDailyCandles(1);
  assert.equal(hit,1);
  assert.equal(loads,1); // still one load
});

test('TTL expiry triggers reload', async () => {
  await resetCollections();
  await db.collection('historical_data').insertOne({ token: 2, candles: [
    { date: '2020-01-01', open:1, high:1, low:1, close:1, volume:1 }
  ]});
  let miss=0;
  const store = initHistoricalStore({ dailyStaleMs: 10, metrics:{ onMiss:()=>miss++ } });
  await store.getDailyCandles(2);
  assert.equal(miss,1);
  await delay(20);
  await store.getDailyCandles(2);
  assert.equal(miss,2);
});

test('write-through append dedupe and bounds', async () => {
  await resetCollections();
  const store = initHistoricalStore({ maxBarsDaily:2 });
  const res = await store.appendDailyCandles(3, [
    { date:'2020-01-01', open:1, high:1, low:1, close:1, volume:1 },
    { date:'2020-01-02', open:2, high:2, low:2, close:2, volume:2 },
    { date:'2020-01-02', open:2, high:2, low:2, close:2, volume:2 },
    { date:'2019-12-31', open:0, high:0, low:0, close:0, volume:0 }
  ]);
  assert.equal(res.length,2); // bounded to 2 most recent
    assert.equal(res[0].date.startsWith('2020-01-01'), true);
    const doc = await db.collection('historical_data').findOne({});
    const arr = doc.candles || doc['3'];
    assert.equal(arr.length,2);
});

test('concurrent reads load once', async () => {
  await resetCollections();
  await db.collection('historical_data').insertOne({ token:4, candles:[{date:'2020-01-01',open:1,high:1,low:1,close:1,volume:1}]});
  let loads=0;
  const store = initHistoricalStore({ metrics:{ onLoadMs:()=>loads++ } });
  await Promise.all([store.getDailyCandles(4), store.getDailyCandles(4)]);
  assert.equal(loads,1);
});

test('supports single document schema', async () => {
  await resetCollections();
  await db.collection('historical_data').insertOne({ '5': [
    { date:'2020-01-01', open:1, high:1, low:1, close:1, volume:1 }
  ]});
  const store = initHistoricalStore();
  const candles = await store.getDailyCandles(5);
  assert.equal(candles.length,1);
});
