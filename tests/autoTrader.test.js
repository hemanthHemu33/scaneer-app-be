import assert from "assert/strict";
import { describe, test, afterEach } from "node:test";
import {
  updateAutoTradingConfig,
  resetAutoTradingConfig,
  evaluateAutoTradeEligibility,
} from "../autoTrader.js";

describe("autoTrader config + eligibility", () => {
  afterEach(() => {
    resetAutoTradingConfig();
  });

  test("updates runtime config with numeric + boolean fields", () => {
    const updated = updateAutoTradingConfig({
      enabled: false,
      minConfidence: 0.7,
      maxOpenTrades: 2,
      intradayOnly: false,
    });
    assert.equal(updated.enabled, false);
    assert.equal(updated.minConfidence, 0.7);
    assert.equal(updated.maxOpenTrades, 2);
    assert.equal(updated.intradayOnly, false);
  });

  test("eligibility blocks low-confidence and off-session signals", () => {
    updateAutoTradingConfig({ enabled: true, minConfidence: 0.8, intradayOnly: true });
    const lowConfidence = evaluateAutoTradeEligibility({ confidence: 0.5 });
    assert.equal(lowConfidence.ok, false);
    assert.equal(lowConfidence.reason, "confidence");

    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
    const expiryGuard = evaluateAutoTradeEligibility({ expiresAt: tomorrow });
    assert.equal(expiryGuard.ok, false);
    assert.equal(expiryGuard.reason, "expiry");
  });

  test("eligibility allows valid intraday signal when enabled", () => {
    updateAutoTradingConfig({ enabled: true, minConfidence: 0.2 });
    const eligibility = evaluateAutoTradeEligibility({
      confidence: 0.5,
      expiresAt: Date.now(),
    });
    assert.equal(eligibility.ok, true);
  });
});
