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
      minSwingScore: 0.8,
    });
    assert.equal(updated.enabled, false);
    assert.equal(updated.minConfidence, 0.7);
    assert.equal(updated.maxOpenTrades, 2);
    assert.equal(updated.intradayOnly, false);
    assert.equal(updated.minSwingScore, 0.8);
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
    updateAutoTradingConfig({ enabled: true, minConfidence: 0.2, minSwingScore: 0 });
    const eligibility = evaluateAutoTradeEligibility({
      confidence: 0.5,
      expiresAt: Date.now(),
    });
    assert.equal(eligibility.ok, true);
  });

  test("swing score threshold blocks low-quality setups", () => {
    updateAutoTradingConfig({ enabled: true, minSwingScore: 0.75 });
    const weak = evaluateAutoTradeEligibility({
      direction: "Long",
      confidence: 0.9,
      isDowntrend: true,
      riskReward: 1.2,
      liquidity: 150000,
      avgVolume: 900000,
    });
    assert.equal(weak.ok, false);
    assert.equal(weak.reason, "swing");
    const strong = evaluateAutoTradeEligibility({
      direction: "Long",
      confidence: 0.92,
      isUptrend: true,
      riskReward: 2.8,
      liquidity: 3_000_000,
      avgVolume: 1_000_000,
    });
    assert.equal(strong.ok, true);
  });
});
