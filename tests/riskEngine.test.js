import test from 'node:test';
import assert from 'node:assert/strict';

const auditMock = test.mock.module('../auditLogger.js', {
  namedExports: {
    logSignalRejected: () => {},
    logSignalExpired: () => {},
    logSignalMutation: () => {},
    logSignalCreated: () => {},
    logBacktestReference: () => {},
    getLogs: () => ({}),
  }
});
const kiteMock = test.mock.module('../kite.js', { namedExports: { getMA: () => null } });
const dbMock = test.mock.module('../db.js', {
  defaultExport: {
    collection: () => ({
      find: () => ({ toArray: async () => [] }),
      deleteMany: async () => {},
      insertMany: async () => {},
    }),
  },
  namedExports: { connectDB: async () => ({}) }
});

const { isSignalValid, resetRiskState, riskState, recordTradeExecution } = await import('../riskEngine.js');

auditMock.restore();
kiteMock.restore();
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

test('isSignalValid blocks near market close', () => {
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
  const ok = isSignalValid(sig, {
    blockMinutesBeforeClose: 10,
    now: new Date('2023-01-05T09:56:00Z'),
  });
  assert.equal(ok, false);
});

test('isSignalValid blocks right after open', () => {
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
  const ok = isSignalValid(sig, {
    blockMinutesAfterOpen: 10,
    now: new Date('2023-01-05T03:47:00Z'),
  });
  assert.equal(ok, false);
});

test('isSignalValid blocks during major event', () => {
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
  const ok = isSignalValid(sig, { majorEventActive: true });
  assert.equal(ok, false);
});

test('isSignalValid blocks during earnings week', () => {
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
  const dt = new Date('2023-01-05T06:00:00Z');
  const oneJan = new Date(dt.getFullYear(), 0, 1);
  const week = Math.floor((dt - oneJan) / (7 * 24 * 60 * 60 * 1000));
  const ok = isSignalValid(sig, {
    now: dt,
    earningsCalendar: { AAA: [week] },
  });
  assert.equal(ok, false);
});

test('isSignalValid blocks low confidence', () => {
  resetRiskState();
  const sig = {
    stock: 'LOW',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 1,
    confidence: 0.5,
    spread: 0.1,
  };
  const ok = isSignalValid(sig, { minConfidence: 0.6 });
  assert.equal(ok, false);
});

test('isSignalValid blocks high risk score', () => {
  resetRiskState();
  const sig = {
    stock: 'RS',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 1,
    riskScore: 7,
    spread: 0.1,
  };
  const ok = isSignalValid(sig, { maxRiskScore: 5 });
  assert.equal(ok, false);
});

test('isSignalValid blocks excessive SL vs ATR', () => {
  resetRiskState();
  const sig = {
    stock: 'SL',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 95,
    target2: 110,
    atr: 1,
    spread: 0.1,
  };
  const ok = isSignalValid(sig, { maxSLATR: 2 });
  assert.equal(ok, false);
});

test('isSignalValid blocks low rvol', () => {
  resetRiskState();
  const sig = {
    stock: 'VOL',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 1,
    rvol: 0.8,
    spread: 0.1,
  };
  const ok = isSignalValid(sig, { minRvol: 1 });
  assert.equal(ok, false);
});

test('isSignalValid blocks near circuit limit', () => {
  resetRiskState();
  const sig = {
    stock: 'CIR',
    pattern: 'trend',
    direction: 'Long',
    entry: 100.5,
    stopLoss: 98,
    target2: 104,
    atr: 1,
    spread: 0.1,
  };
  const ok = isSignalValid(sig, { upperCircuit: 101 });
  assert.equal(ok, false);
});

test('isSignalValid blocks gap zone trades', () => {
  resetRiskState();
  const sig = {
    stock: 'GAP',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 1,
    inGapZone: true,
    spread: 0.1,
  };
  const ok = isSignalValid(sig);
  assert.equal(ok, false);
});

test('isSignalValid respects system pause', () => {
  resetRiskState();
  riskState.systemPaused = true;
  const sig = {
    stock: 'PAUSE',
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

test('isSignalValid throttles in high volatility', () => {
  resetRiskState();
  riskState.lastTradeTime = Date.now();
  const sig = {
    stock: 'VOL',
    pattern: 'trend',
    direction: 'Long',
    entry: 100,
    stopLoss: 98,
    target2: 104,
    atr: 5,
    spread: 0.1,
  };
  const ok = isSignalValid(sig, { volatility: 5, highVolatilityThresh: 4, throttleMs: 60000 });
  assert.equal(ok, false);
});
