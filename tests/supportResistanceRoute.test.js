import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const kiteMock = test.mock.module('../kite.js', {
  namedExports: {
    getSupportResistanceLevels: () => ({ support: 100, resistance: 120 })
  }
});

const { getSupportResistanceLevels } = await import('../kite.js');

const app = express();
app.get('/support-resistance/:symbol', (req, res) => {
  const levels = getSupportResistanceLevels(req.params.symbol);
  res.json({ status: 'success', ...levels });
});

const server = app.listen(0);
const port = server.address().port;
const response = await fetch(`http://localhost:${port}/support-resistance/XYZ`);
const body = await response.json();
server.close();

kiteMock.restore();

test('support-resistance route returns mocked levels', () => {
  assert.equal(body.status, 'success');
  assert.equal(body.support, 100);
  assert.equal(body.resistance, 120);
});
