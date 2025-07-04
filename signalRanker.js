import { getStrategyHitRate, timeOfDayScore } from './confidence.js';

function confidenceLevelScore(level) {
  if (typeof level === 'number') return Math.max(0, Math.min(level, 1));
  const map = { high: 1, medium: 0.7, low: 0.4 };
  return map[(level || '').toLowerCase()] ?? 0.5;
}

function patternStrengthScore(strength) {
  if (typeof strength === 'number') return Math.max(0, Math.min(strength, 1));
  const map = { strong: 1, medium: 0.6, weak: 0.3 };
  return map[(strength || '').toLowerCase()] ?? 0.5;
}

function rrPotentialScore(signal) {
  const { entry, stopLoss, target2, target1 } = signal;
  if (!entry || !stopLoss) return 0;
  const target = target2 ?? target1;
  if (!target) return 0;
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(target - entry);
  if (!risk) return 0;
  return Math.min(reward / risk / 3, 1); // saturate at RR=3
}

function scoreSignal(signal = {}) {
  const confScore = confidenceLevelScore(signal.confidence);
  const todScore = timeOfDayScore(signal.time ? new Date(signal.time) : new Date());
  const hitRate =
    typeof signal.winRate === 'number'
      ? signal.winRate
      : getStrategyHitRate(signal.stock || '', signal.pattern || '');
  const rrScore = rrPotentialScore(signal);
  const patternScore = patternStrengthScore(signal.patternStrength);

  return (
    confScore * 0.3 +
    todScore * 0.1 +
    hitRate * 0.25 +
    rrScore * 0.2 +
    patternScore * 0.15
  );
}

export function rankSignals(signals = [], topN = 1) {
  if (!Array.isArray(signals) || signals.length === 0) return [];
  const ranked = signals
    .map((s) => ({ ...s, score: scoreSignal(s) }))
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, topN);
}

export function selectTopSignal(signals = []) {
  return rankSignals(signals, 1)[0] || null;
}
