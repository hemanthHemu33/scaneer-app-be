import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const kiteMock = test.mock.module('../kite.js', {
  namedExports: {
    rebuildThreeMinCandlesFromOneMin: async () => [
      { open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }
    ]
  }
});

const { rebuildThreeMinCandlesFromOneMin } = await import('../kite.js');

const app = express();
app.get('/rebuild-3min/:token', async (req, res) => {
  const candles = await rebuildThreeMinCandlesFromOneMin(req.params.token);
  res.json({ status: 'success', candles });
});

const server = app.listen(0);
const port = server.address().port;
const response = await fetch(`http://localhost:${port}/rebuild-3min/123`);
const body = await response.json();
server.close();

kiteMock.restore();

test('rebuild-3min route returns rebuilt candles', () => {
  assert.equal(body.status, 'success');
  assert.equal(body.candles.length, 1);
  assert.equal(body.candles[0].open, 1);
});
