import assert from "assert/strict";
import { describe, test } from "node:test";
import {
  scoreSwingOpportunity,
  isHighConvictionSwing,
  DEFAULT_SWING_THRESHOLD,
} from "../swingTrader.js";

describe("swingTrader", () => {
  const baseSignal = {
    stock: "INFY",
    direction: "Long",
    confidence: 0.8,
    riskReward: 2.4,
    liquidity: 2_500_000,
    avgVolume: 1_000_000,
    isUptrend: true,
    generatedAt: Date.UTC(2024, 0, 10, 7, 30), // 13:00 IST
  };

  test("scores trend-aligned, liquid swings higher", () => {
    const strong = scoreSwingOpportunity(baseSignal);
    const weak = scoreSwingOpportunity({
      ...baseSignal,
      confidence: 0.45,
      riskReward: 1.1,
      isUptrend: false,
      isDowntrend: true,
      liquidity: 200_000,
      avgVolume: 1_000_000,
    });
    assert.ok(strong.score > weak.score, "strong setup should score higher");
    assert.ok(strong.score > DEFAULT_SWING_THRESHOLD, "strong score above threshold");
  });

  test("high-conviction helper enforces threshold", () => {
    const result = isHighConvictionSwing(baseSignal, { threshold: 0.7 });
    assert.equal(result.ok, true);
    const rejected = isHighConvictionSwing(
      { ...baseSignal, confidence: 0.2, riskReward: 1.1 },
      { threshold: 0.7 }
    );
    assert.equal(rejected.ok, false);
    assert.ok(rejected.score < 0.7);
  });
});
