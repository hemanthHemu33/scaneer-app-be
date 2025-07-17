import test from 'node:test';
import assert from 'node:assert/strict';

const auditMock = test.mock.module('../auditLogger.js', { namedExports: { logSignalRejected: () => {} } });
const dbMock = test.mock.module('../db.js', { defaultExport: {}, namedExports: { connectDB: async () => ({}) } });

const {
  validateATRStopLoss,
  validateSupportResistance,
  validateVolumeSpike,
  validateVolatilitySlippage,
} = await import('../riskValidator.js');

auditMock.restore();
dbMock.restore();

test('validateATRStopLoss enforces min and max distance', () => {
  assert.equal(validateATRStopLoss({ entry: 100, stopLoss: 99, atr: 2 }), false);
  assert.equal(validateATRStopLoss({ entry: 100, stopLoss: 85, atr: 2 }), false);
  assert.equal(validateATRStopLoss({ entry: 100, stopLoss: 96, atr: 2 }), true);
});

test('validateSupportResistance respects levels', () => {
  assert.equal(
    validateSupportResistance({ entry: 105, direction: 'Long', support: 104, resistance: 106, atr: 2 }),
    false
  );
  assert.equal(
    validateSupportResistance({ entry: 100, direction: 'Short', support: 98, resistance: 102, atr: 2 }),
    true
  );
  assert.equal(
    validateSupportResistance({ entry: 110, direction: 'Long', support: 105, resistance: 120, atr: 2 }),
    true
  );
});

test('validateVolumeSpike requires spike over average', () => {
  assert.equal(validateVolumeSpike({ volume: 150, avgVolume: 100 }), true);
  assert.equal(validateVolumeSpike({ volume: 120, avgVolume: 100, minSpike: 1.3 }), false);
});

test('validateVolatilitySlippage enforces rules', () => {
  assert.equal(
    validateVolatilitySlippage({ atr: 0.5, minATR: 1 }),
    false
  );
  assert.equal(
    validateVolatilitySlippage({ atr: 2.5, maxATR: 2 }),
    false
  );
  assert.equal(
    validateVolatilitySlippage({ dailyRangePct: 20, maxDailySpikePct: 10 }),
    false
  );
  assert.equal(
    validateVolatilitySlippage({ spread: 0.4, maxSpreadPct: 0.3 }),
    false
  );
  assert.equal(
    validateVolatilitySlippage({ slippage: 0.05, maxSlippage: 0.02 }),
    false
  );
  assert.equal(
    validateVolatilitySlippage({ volume: 50, avgVolume: 200, consolidationRatio: 0.3 }),
    false
  );
  assert.equal(
    validateVolatilitySlippage({ atr: 1.5, minATR: 1, maxATR: 2, spread: 0.2, maxSpreadPct: 0.3 }),
    true
  );
});
