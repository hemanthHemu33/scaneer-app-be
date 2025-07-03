const weights = new Map();

export function updateStrategyWeight(name, delta) {
  const w = weights.get(name) || 1;
  weights.set(name, Math.max(0.1, w + delta));
}

export function getStrategyWeight(name) {
  return weights.get(name) || 1;
}

export function adjustWeights(results = []) {
  for (const r of results) {
    updateStrategyWeight(r.strategy, r.outcome > 0 ? 0.1 : -0.1);
  }
}
