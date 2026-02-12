const MINUTES_OPEN = 9 * 60 + 15; // 09:15 IST
const MINUTES_CLOSE = 15 * 60 + 30; // 15:30 IST
const SAFE_WINDOW_PADDING = 30; // minutes from open/close considered noisy

const DEFAULT_SWING_WEIGHTS = Object.freeze({
  confidence: 0.4,
  trend: 0.2,
  riskReward: 0.2,
  liquidity: 0.1,
  session: 0.1,
});

export const DEFAULT_SWING_THRESHOLD = 0.65;

const clamp01 = (value) => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
};

const normalizeConfidence = (value) => {
  if (!Number.isFinite(value)) return 0;
  const normalized = value > 1 ? value / 100 : value;
  return clamp01(normalized);
};

const normalizeTrendAlignment = (signal = {}) => {
  const direction = String(signal.direction || "").toLowerCase();
  const alignedLong = signal.isUptrend === true && direction === "long";
  const alignedShort = signal.isDowntrend === true && direction === "short";
  if (alignedLong || alignedShort) return 1;
  const counterLong = signal.isDowntrend === true && direction === "long";
  const counterShort = signal.isUptrend === true && direction === "short";
  if (counterLong || counterShort) return 0.1;
  if (signal.trendStrength && Number.isFinite(signal.trendStrength)) {
    return clamp01(0.5 + signal.trendStrength * 0.5);
  }
  if (signal.momentumScore && Number.isFinite(signal.momentumScore)) {
    return clamp01(0.5 + signal.momentumScore * 0.5);
  }
  return 0.5;
};

const normalizeRiskReward = (signal = {}) => {
  const rr = Number(signal.riskReward ?? signal.rr);
  if (!Number.isFinite(rr)) return 0;
  const normalized = rr / 2.5; // >=2.5 is considered strong
  return clamp01(normalized);
};

const normalizeLiquidity = (signal = {}) => {
  const liquidity = Number(
    signal.liquidity ?? signal.volume ?? signal.avgVolume ?? signal.turnover
  );
  const avgVolume = Number(signal.avgVolume || signal.averageVolume);
  if (!Number.isFinite(liquidity)) return 0;
  if (Number.isFinite(avgVolume) && avgVolume > 0) {
    return clamp01(liquidity / (avgVolume * 1.5));
  }
  const baseline = 1_000_000;
  return clamp01(liquidity / baseline);
};

const toIstMinutes = (timestamp) => {
  const date = new Date(timestamp ?? Date.now());
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const istMinutes = utcMinutes + 5 * 60 + 30;
  const normalized = istMinutes % (24 * 60);
  return normalized < 0 ? normalized + 24 * 60 : normalized;
};

const normalizeSession = (signal = {}) => {
  const ts = signal.generatedAt ?? signal.time ?? Date.now();
  const minutes = toIstMinutes(ts);
  if (minutes < MINUTES_OPEN || minutes > MINUTES_CLOSE) return 0;
  const safeOpen = MINUTES_OPEN + SAFE_WINDOW_PADDING;
  const safeClose = MINUTES_CLOSE - SAFE_WINDOW_PADDING;
  if (minutes >= safeOpen && minutes <= safeClose) return 1;
  return 0.5;
};

function normalizeWeights(weights = DEFAULT_SWING_WEIGHTS) {
  const normalized = {};
  let total = 0;
  for (const [key, value] of Object.entries(weights)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    normalized[key] = value;
    total += value;
  }
  if (!total) return DEFAULT_SWING_WEIGHTS;
  const scaled = {};
  for (const [key, value] of Object.entries(normalized)) {
    scaled[key] = value / total;
  }
  return scaled;
}

export function scoreSwingOpportunity(signal = {}, options = {}) {
  const weights = normalizeWeights(options.weights || DEFAULT_SWING_WEIGHTS);
  const metrics = {
    confidence: normalizeConfidence(
      signal.confidence ?? signal.confidenceScore ?? signal.algoSignal?.confidence
    ),
    trend: normalizeTrendAlignment(signal),
    riskReward: normalizeRiskReward(signal),
    liquidity: normalizeLiquidity(signal),
    session: normalizeSession(signal),
  };
  let score = 0;
  const breakdown = {};
  for (const [key, weight] of Object.entries(weights)) {
    const metric = metrics[key] ?? 0;
    const contribution = metric * weight;
    breakdown[key] = Number(contribution.toFixed(4));
    score += contribution;
  }
  return {
    score: Number(score.toFixed(4)),
    metrics,
    breakdown,
  };
}

export function isHighConvictionSwing(signal = {}, options = {}) {
  const { score, metrics, breakdown } = scoreSwingOpportunity(signal, options);
  const threshold = Number.isFinite(options.threshold)
    ? options.threshold
    : DEFAULT_SWING_THRESHOLD;
  return {
    ok: score >= threshold,
    score,
    threshold,
    metrics,
    breakdown,
  };
}
