import {
  getStrategyHitRate,
  getRecentAccuracy,
  timeOfDayScore,
} from './confidence.js';
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

function signalAgeScore(signal) {
  const ts = new Date(signal.time || signal.generatedAt || Date.now()).getTime();
  const age = Date.now() - ts;
  if (age < 60_000) return 1;
  if (age < 5 * 60_000) return 0.7;
  if (age < 10 * 60_000) return 0.5;
  return 0.3;
}

function candleStrengthScore(signal) {
  const { open, close, high, low } = signal;
  if ([open, close, high, low].some((v) => typeof v !== 'number')) return 0.5;
  const body = Math.abs(close - open);
  const range = high - low || 1;
  const bodyPct = body / range;
  const wickRatio = body / (range - body || 1);
  return Math.min(bodyPct * 0.7 + Math.min(wickRatio, 1) * 0.3, 1);
}

function volumeSpikeScore(signal) {
  if (typeof signal.rvol === 'number') {
    return Math.min(signal.rvol / 2, 1);
  }
  if (signal.volume && signal.avgVolume) {
    return Math.min(signal.volume / signal.avgVolume / 2, 1);
  }
  return 0.5;
}

function multiTimeframeScore(signal) {
  return Math.min((signal.multiTFConfirmations || 0) / 3, 1);
}

function trendAlignmentScore(signal) {
  if (typeof signal.trend === 'string') {
    return signal.trend.toLowerCase() === signal.direction?.toLowerCase()
      ? 1
      : 0.4;
  }
  if (signal.ema200 && signal.entry) {
    if (
      (signal.direction === 'Long' && signal.entry > signal.ema200) ||
      (signal.direction === 'Short' && signal.entry < signal.ema200)
    )
      return 1;
    return 0.4;
  }
  return 0.5;
}

function backtestAccuracyScore(signal) {
  const recent = getRecentAccuracy(signal.stock || '', signal.pattern || '');
  return Math.max(0, Math.min(recent, 1));
}

function volatilityEdgeScore(signal) {
  if (typeof signal.atr !== 'number') return 0.5;
  if (signal.atr >= 1 && signal.atr <= 2) return 1;
  if (signal.atr >= 0.5 && signal.atr <= 3) return 0.7;
  return 0.4;
}

function priceActionScore(signal) {
  if (typeof signal.priceActionScore === 'number') return signal.priceActionScore;
  return 0.5;
}

function entryEfficiencyScore(signal) {
  if (
    typeof signal.entry === 'number' &&
    typeof signal.support === 'number' &&
    typeof signal.resistance === 'number'
  ) {
    const dist = Math.min(
      Math.abs(signal.entry - signal.support),
      Math.abs(signal.resistance - signal.entry)
    );
    const range = Math.abs(signal.resistance - signal.support) || 1;
    return Math.min(1 - dist / range, 1);
  }
  return 0.5;
}

function orderBlockProximityScore(signal) {
  if (typeof signal.orderBlockDist !== 'number') return 0.5;
  return Math.max(0, Math.min(1 - signal.orderBlockDist, 1));
}

function indexCorrelationScore(signal) {
  if (typeof signal.indexCorrelation === 'number') {
    return Math.max(0, Math.min(Math.abs(signal.indexCorrelation), 1));
  }
  return 0.5;
}

function sectorConfirmationScore(signal) {
  if (typeof signal.sectorScore === 'number') return signal.sectorScore;
  return 0.5;
}

function gapQualityScore(signal) {
  if (typeof signal.gapQuality === 'number') return signal.gapQuality;
  return 0.5;
}

function retestSuccessScore(signal) {
  if (typeof signal.retestSuccessRate === 'number')
    return Math.max(0, Math.min(signal.retestSuccessRate, 1));
  return 0.5;
}

function slippageRiskScore(signal) {
  if (typeof signal.slippage !== 'number') return 0.5;
  return Math.max(0, Math.min(1 - signal.slippage, 1));
}

function newsSentimentScore(signal) {
  if (typeof signal.newsSentiment === 'number')
    return Math.max(0, Math.min((signal.newsSentiment + 1) / 2, 1));
  return 0.5;
}

function confluenceCountScore(signal) {
  return Math.min((signal.confluenceCount || 0) / 5, 1);
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
  const ageScore = signalAgeScore(signal);
  const candleScore = candleStrengthScore(signal);
  const volSpike = volumeSpikeScore(signal);
  const mtfScore = multiTimeframeScore(signal);
  const trendScore = trendAlignmentScore(signal);
  const backtestScore = backtestAccuracyScore(signal);
  const volEdge = volatilityEdgeScore(signal);
  const paScore = priceActionScore(signal);
  const entryEff = entryEfficiencyScore(signal);
  const obScore = orderBlockProximityScore(signal);
  const idxScore = indexCorrelationScore(signal);
  const sectorScoreVal = sectorConfirmationScore(signal);
  const gapScore = gapQualityScore(signal);
  const retestScore = retestSuccessScore(signal);
  const slipScore = slippageRiskScore(signal);
  const newsScore = newsSentimentScore(signal);
  const confCount = confluenceCountScore(signal);

  return (
    confScore * 0.2 +
    hitRate * 0.05 +
    rrScore * 0.1 +
    ageScore * 0.05 +
    candleScore * 0.05 +
    volSpike * 0.05 +
    patternScore * 0.05 +
    mtfScore * 0.05 +
    trendScore * 0.05 +
    backtestScore * 0.05 +
    volEdge * 0.05 +
    paScore * 0.05 +
    entryEff * 0.05 +
    obScore * 0.02 +
    idxScore * 0.02 +
    sectorScoreVal * 0.02 +
    gapScore * 0.02 +
    retestScore * 0.02 +
    slipScore * 0.03 +
    newsScore * 0.02 +
    confCount * 0.05 +
    regimeScore * 0.05 +
    volScore * 0.03 +
    todScore * 0.05
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
