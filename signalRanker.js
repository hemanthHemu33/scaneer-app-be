import { getStrategyHitRate, timeOfDayScore } from './confidence.js';
import { marketContext } from './smartStrategySelector.js';

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

function marketRegimeScore(signal, ctx = marketContext) {
  const reg = ctx.regime || 'sideways';
  const pat = (signal.pattern || '').toLowerCase();
  if (reg === 'trending') {
    if (pat.includes('trend') || pat.includes('momentum') || pat.includes('breakout')) return 1;
    if (pat.includes('reversion') || pat.includes('mean')) return 0.4;
    if (pat.includes('scalp')) return 0.5;
    return 0.6;
  }
  if (reg === 'choppy') {
    if (pat.includes('reversion') || pat.includes('scalp')) return 1;
    if (pat.includes('breakout')) return 0.5;
    if (pat.includes('trend') || pat.includes('momentum')) return 0.3;
    return 0.6;
  }
  return 0.7;
}

function volatilityFitScore(atr, ctx = marketContext) {
  const vol = ctx.volatility || 'normal';
  if (!atr) return 0.5;
  if (vol === 'high') {
    if (atr >= 2) return 1;
    if (atr >= 1.2) return 0.8;
    return 0.4;
  }
  if (vol === 'low') {
    if (atr <= 1) return 1;
    if (atr <= 2) return 0.7;
    return 0.3;
  }
  return 0.8;
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
  const regimeScore = marketRegimeScore(signal);
  const volScore = volatilityFitScore(signal.atr);

  return (
    confScore * 0.25 +
    hitRate * 0.25 +
    rrScore * 0.15 +
    patternScore * 0.1 +
    regimeScore * 0.15 +
    volScore * 0.1 +
    todScore * 0.1
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
