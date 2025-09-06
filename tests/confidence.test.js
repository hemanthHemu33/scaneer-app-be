import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';

const {
  computeConfidenceScore,
  recordStrategyResult,
  getRecentAccuracy,
  applyPenaltyConditions,
  signalQualityScore,
} = await import('../confidence.js');

const kiteMock = test.mock.module('../kite.js', {
  namedExports: {
    getHigherTimeframeData: async () => ({
      ema50: 90,
      supertrend: { signal: 'Buy' }
    }),
    getMA: () => null,
    onOrderUpdate: () => {},
    orderEvents: { on: () => {} }
  }
});

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

test('applyPenaltyConditions reduces score', () => {
  const base = 0.8;
  const adjusted = applyPenaltyConditions(base, {
    doji: true,
    lowVolume: true,
    badRR: true,
  });
  assert.ok(adjusted < base && adjusted >= 0);
});

test('evaluateTrendConfidence basic high', { concurrency: false }, async () => {
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
      depth: { buy: [{ price: 102 }], sell: [{ price: 102.2 }] },
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
});

test('evaluateTrendConfidence low on weak volume', { concurrency: false }, async () => {
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
});

test('getRecentAccuracy computes recent win rate', () => {
  recordStrategyResult('AAA', 'trend', true);
  recordStrategyResult('AAA', 'trend', false);
  recordStrategyResult('AAA', 'trend', true);
  const acc = getRecentAccuracy('AAA', 'trend');
  assert.ok(acc > 0 && acc <= 1);
});

test('signalQualityScore scales with history', () => {
  const base = signalQualityScore(
    { atr: 1, rvol: 1, strongPriceAction: false },
    { symbol: 'BBB', strategy: 'trend' }
  );
  for (let i = 0; i < 5; i++) {
    recordStrategyResult('BBB', 'trend', true);
  }
  const improved = signalQualityScore(
    { atr: 1, rvol: 1, strongPriceAction: false },
    { symbol: 'BBB', strategy: 'trend' }
  );
  assert.ok(improved > base);
});
