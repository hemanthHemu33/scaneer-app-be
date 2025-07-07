import test from 'node:test';
import assert from 'node:assert/strict';

import { computeConfidenceScore } from '../confidence.js';

test('computeConfidenceScore blends factors', () => {
  const score = computeConfidenceScore({
    hitRate: 0.8,
    confirmations: 3,
    quality: 1,
    date: new Date('2023-01-01T10:00:00Z')
  });
  assert.ok(score > 0.7 && score <= 1);
});

test('computeConfidenceScore low factors', () => {
  const score = computeConfidenceScore({
    hitRate: 0.2,
    confirmations: 0,
    quality: 0.1,
    date: new Date('2023-01-01T15:00:00Z')
  });
  assert.ok(score < 0.5);
});

test('evaluateTrendConfidence basic high', async () => {
  const kiteMock = test.mock.module('../kite.js', {
    namedExports: {
      getHigherTimeframeData: async () => ({
        ema50: 90,
        supertrend: { signal: 'Buy' }
      })
    }
  });
  const { evaluateTrendConfidence } = await import('../confidence.js');
  const res = await evaluateTrendConfidence(
    {
      features: {
        ema9: 105,
        ema21: 100,
        ema50: 95,
        supertrend: { signal: 'Buy' }
      },
      tick: {
        volume_traded: 600,
        total_buy_quantity: 900,
        total_sell_quantity: 200
      },
      liquidity: 200,
      spread: 0.5,
      depth: { buy: [{ price: 101 }], sell: [{ price: 101.2 }] },
      totalBuy: 1000,
      totalSell: 800,
      last: { close: 102 },
      filters: { minBuySellRatio: 0.8, maxSpread: 1.5, minLiquidity: 100 },
      symbol: 'AAA',
      quality: 1,
      history: {}
    },
    { direction: 'Long', type: 'Breakout' }
  );
  assert.equal(res.confidence, 'High');
  kiteMock.restore();
});

test('evaluateTrendConfidence low on weak volume', async () => {
  const kiteMock = test.mock.module('../kite.js', {
    namedExports: {
      getHigherTimeframeData: async () => ({
        ema50: 90,
        supertrend: { signal: 'Buy' }
      })
    }
  });
  const { evaluateTrendConfidence } = await import('../confidence.js');
  const res = await evaluateTrendConfidence(
    {
      features: {
        ema9: 105,
        ema21: 100,
        ema50: 95,
        supertrend: { signal: 'Buy' }
      },
      tick: { volume_traded: 10, total_buy_quantity: 6, total_sell_quantity: 4 },
      liquidity: 1000,
      spread: 0.5,
      totalBuy: 500,
      totalSell: 400,
      last: { close: 101 },
      filters: { minBuySellRatio: 0.8, maxSpread: 1.5, minLiquidity: 100 },
      symbol: 'AAA',
      quality: 0.7,
      history: {}
    },
    { direction: 'Long', type: 'Breakout' }
  );
  assert.equal(res.confidence, 'Low');
  kiteMock.restore();
});
