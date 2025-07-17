import test from 'node:test';
import assert from 'node:assert/strict';

const auditMock = test.mock.module('../auditLogger.js', {
  namedExports: { logSignalRejected: () => {} }
});
const dbMock = test.mock.module('../db.js', {
  defaultExport: {},
  namedExports: { connectDB: async () => ({}) }
});

const { isSignalValid, resetRiskState, riskState, recordTradeExecution } = await import('../riskEngine.js');

auditMock.restore();
dbMock.restore();

test('isSignalValid blocks low RR', () => {
  resetRiskState();
  const sig = {
    stock: 'AAA',
    pattern: 'mean-reversion',
    direction: 'Long',
    entry: 100,
    stopLoss: 99,
    target2: 101,
    atr: 1,
    spread: 0.1,
  };
  const ok = isSignalValid(sig, { minATR: 0.5, maxATR: 5 });
  assert.equal(ok, false);
});

test('isSignalValid prevents duplicates', () => {
  resetRiskState();
  const sig = {
    stock: 'AAA',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 1,
    spread: 0.1,
  };
  assert.ok(isSignalValid(sig));
  const second = isSignalValid(sig);
  assert.equal(second, false);
});

test('isSignalValid respects ATR boundaries', () => {
  resetRiskState();
  const sig = {
    stock: 'BBB',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 6,
    spread: 0.1,
  };
  const ok = isSignalValid(sig, { minATR: 0.5, maxATR: 5 });
  assert.equal(ok, false);
});

test('isSignalValid blocks when maxOpenPositions reached', () => {
  resetRiskState();
  const sig = {
    stock: 'CCC',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 1,
    spread: 0.1,
  };
  const ok = isSignalValid(sig, {
    maxOpenPositions: 2,
    openPositionsCount: 2,
  });
  assert.equal(ok, false);
});

test('isSignalValid blocks on loss streak', () => {
  resetRiskState();
  riskState.consecutiveLosses = 3;
  const sig = {
    stock: 'DDD',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 1,
    spread: 0.1,
  };
  const ok = isSignalValid(sig, { maxLossStreak: 3 });
  assert.equal(ok, false);
});

test('isSignalValid enforces liquidity and volume ratio', () => {
  resetRiskState();
  const sig = {
    stock: 'EEE',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 1,
    spread: 0.1,
    liquidity: 400,
  };
  const ok = isSignalValid(sig, {
    minLiquidity: 500,
    avgVolume: 1000,
    minVolumeRatio: 0.5,
  });
  assert.equal(ok, false);
});

test('isSignalValid enforces per instrument trade cap', () => {
  resetRiskState();
  riskState.maxTradesPerInstrument = 2;
  recordTradeExecution({ symbol: 'AAA', sector: 'IT' });
  recordTradeExecution({ symbol: 'AAA', sector: 'IT' });
  const sig = {
    stock: 'AAA',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 1,
    spread: 0.1,
  };
  const ok = isSignalValid(sig);
  assert.equal(ok, false);
});

test('isSignalValid enforces sector trade cap', () => {
  resetRiskState();
  riskState.maxTradesPerSector = 1;
  recordTradeExecution({ symbol: 'AAA', sector: 'IT' });
  const sig = {
    stock: 'BBB',
    sector: 'IT',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 1,
    spread: 0.1,
  };
  const ok = isSignalValid(sig);
  assert.equal(ok, false);
});

test('isSignalValid blocks opposite direction with open position', () => {
  resetRiskState();
  const positions = new Map([
    ['AAA', { side: 'long' }],
  ]);
  const sig = {
    stock: 'AAA',
    pattern: 'trend',
    direction: 'Short',
    entry: 100,
    stopLoss: 102,
    target2: 95,
    atr: 1,
    spread: 0.1,
  };
  const ok = isSignalValid(sig, { openPositionsMap: positions });
  assert.equal(ok, false);
});

test('isSignalValid enforces cooloff after loss', () => {
  resetRiskState();
  riskState.lastTradeWasLoss = true;
  const sig = {
    stock: 'FFF',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 1,
    spread: 0.1,
  };
  const ok = isSignalValid(sig, { cooloffAfterLoss: true });
  assert.equal(ok, false);
});

test('isSignalValid enforces maxLossPerTradePct', () => {
  resetRiskState();
  const sig = {
    stock: 'GGG',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 90,
    target2: 120,
    atr: 1,
    spread: 0.1,
  };
  const ok = isSignalValid(sig, { maxLossPerTradePct: 0.05 });
  assert.equal(ok, false);
});

test('isSignalValid blocks excessive slippage and spread', () => {
  resetRiskState();
  const sig = {
    stock: 'HHH',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 1,
    spread: 0.5,
  };
  const ok = isSignalValid(sig, {
    maxSpreadPct: 0.3,
    slippage: 0.05,
    maxSlippage: 0.02,
  });
  assert.equal(ok, false);
});
