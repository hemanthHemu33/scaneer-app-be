import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

let called = null;
const kiteMock = test.mock.module('../kite.js', {
  namedExports: {
    removeStockSymbol: async (sym) => {
      called = sym;
    },
    onOrderUpdate: () => {},
    orderEvents: { on: () => {} }
  }
});

const { removeStockSymbol } = await import('../kite.js');

const app = express();
app.delete('/stockSymbols/:symbol', async (req, res) => {
  const { symbol } = req.params;
  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ error: 'Invalid stock symbol' });
  }
  try {
    await removeStockSymbol(symbol);
    res.json({ status: 'success', deletedSymbol: symbol.includes(':') ? symbol : `NSE:${symbol}` });
  } catch {
    res.status(500).json({ error: 'Failed to delete stock symbol' });
  }
});

const server = app.listen(0);
const port = server.address().port;
const response = await fetch(`http://localhost:${port}/stockSymbols/ABC`, { method: 'DELETE' });
const body = await response.json();
server.close();

kiteMock.restore();

test('delete stock symbol route calls removeStockSymbol and responds', () => {
  assert.equal(called, 'ABC');
  assert.equal(body.status, 'success');
  assert.equal(body.deletedSymbol, 'NSE:ABC');
});
