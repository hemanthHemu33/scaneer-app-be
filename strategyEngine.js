import {
  calculateEMA,
  calculateRSI,
  calculateSupertrend,
  calculateVWAP,
  getATR,
  computeFeatures,
} from './featureEngine.js';
import { detectAllPatterns } from './util.js';

export function strategySupertrend(context = {}) {
  const { candles = [], features = computeFeatures(candles) } = context;
  if (!Array.isArray(candles) || candles.length < 20) return null;

  const { rsi, supertrend } = features || {};
  const last = candles[candles.length - 1];

  if (supertrend?.signal === 'Buy' && rsi > 55) {
    const entry = last.close;
    const stopLoss = last.low;
    const risk = entry - stopLoss;
    return {
      entry,
      stopLoss,
      target1: entry + risk * 0.75,
      target2: entry + risk * 1.5,
      direction: 'Long',
      strategy: 'Supertrend',
      confidence: 0.6,
    };
  }

  if (supertrend?.signal === 'Sell' && rsi < 45) {
    const entry = last.close;
    const stopLoss = last.high;
    const risk = stopLoss - entry;
    return {
      entry,
      stopLoss,
      target1: entry - risk * 0.75,
      target2: entry - risk * 1.5,
      direction: 'Short',
      strategy: 'Supertrend',
      confidence: 0.6,
    };
  }

  return null;
}

export function strategyEMAReversal(context = {}) {
  const { candles = [], features = computeFeatures(candles) } = context;
  if (!Array.isArray(candles) || candles.length < 20) return null;

  const closes = candles.map(c => c.close);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  if (prev.close < ema20 && last.close > ema20 && ema20 > ema50) {
    const entry = last.close;
    const stopLoss = prev.low;
    const risk = entry - stopLoss;
    return {
      entry,
      stopLoss,
      target1: entry + risk * 0.5,
      target2: entry + risk * 1,
      direction: 'Long',
      strategy: 'EMA Reversal',
      confidence: 0.55,
    };
  }

  if (prev.close > ema20 && last.close < ema20 && ema20 < ema50) {
    const entry = last.close;
    const stopLoss = prev.high;
    const risk = stopLoss - entry;
    return {
      entry,
      stopLoss,
      target1: entry - risk * 0.5,
      target2: entry - risk * 1,
      direction: 'Short',
      strategy: 'EMA Reversal',
      confidence: 0.55,
    };
  }

  return null;
}

export function strategyTripleTop(context = {}) {
  const { candles = [], features = computeFeatures(candles) } = context;
  if (!Array.isArray(candles) || candles.length < 7) return null;

  const atr = features?.atr ?? getATR(candles, 14);
  const patterns = detectAllPatterns(candles, atr, 5);
  const tripleTop = patterns.find(p => p.type === 'Triple Top');
  if (!tripleTop) return null;

  if (features?.rsi > 60) return null;

  const entry = tripleTop.breakout;
  const stopLoss = tripleTop.stopLoss;
  const risk = stopLoss - entry;
  return {
    entry,
    stopLoss,
    target1: entry - risk * 0.5,
    target2: entry - risk,
    direction: 'Short',
    strategy: 'Triple Top',
    confidence: 0.6,
  };
}

export function strategyVWAPReversal(context = {}) {
  const { candles = [], features = computeFeatures(candles) } = context;
  if (!Array.isArray(candles) || candles.length < 5) return null;

  const atr = features?.atr ?? getATR(candles, 14);
  const patterns = detectAllPatterns(candles, atr, 5);
  const pattern = patterns.find(p => p.type === 'VWAP Reversal');
  if (!pattern) return null;

  const entry = pattern.breakout;
  const stopLoss = pattern.stopLoss;
  const risk = Math.abs(entry - stopLoss);
  const direction = pattern.direction;

  return {
    entry,
    stopLoss,
    target1:
      direction === 'Long' ? entry + risk * 0.5 : entry - risk * 0.5,
    target2:
      direction === 'Long' ? entry + risk : entry - risk,
    direction,
    strategy: 'VWAP Reversal',
    confidence: 0.55,
  };
}

export function evaluateAllStrategies(context = {}) {
  const strategies = [
    strategySupertrend,
    strategyEMAReversal,
    strategyTripleTop,
    strategyVWAPReversal,
  ];
  const results = [];
  const symbol = context.symbol || 'UNKNOWN';
  const ts = context.candles?.at(-1)?.timestamp || Date.now();
  for (const fn of strategies) {
    const res = fn(context);
    if (res) {
      res.signalId = `${symbol}-${res.strategy}-${ts}`;
      results.push(res);
    }
  }
  return results;
}
