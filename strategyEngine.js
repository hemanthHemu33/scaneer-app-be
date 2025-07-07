import {
  calculateEMA,
  calculateRSI,
  calculateSupertrend,
  calculateVWAP,
  getATR,
  computeFeatures,
} from './featureEngine.js';
import { detectAllPatterns } from './util.js';
import { RISK_REWARD_RATIO, calculatePositionSize } from './positionSizing.js';

export function strategySupertrend(context = {}) {
  const {
    candles = [],
    features = computeFeatures(candles),
    symbol,
    accountBalance = 0,
    riskPerTradePercentage = 0.01,
    spread = 0,
    liquidity = 0,
  } = context;
  if (!Array.isArray(candles) || candles.length < 20) return null;

  const { rsi, supertrend, atr = getATR(candles, 14) } = features || {};
  const last = candles[candles.length - 1];

  if (supertrend?.signal === 'Buy' && rsi > 55) {
    const entry = last.close;
    const stopLoss = last.low;
    const risk = entry - stopLoss;
    const qty = calculatePositionSize({
      capital: accountBalance,
      risk: accountBalance * riskPerTradePercentage,
      slPoints: risk,
      price: entry,
      volatility: atr,
    });
    return {
      stock: symbol,
      strategy: 'Supertrend',
      pattern: 'Supertrend',
      direction: 'Long',
      entry,
      stopLoss,
      target1: entry + risk * 0.75,
      target2: entry + risk * 1.5,
      qty,
      atr,
      spread,
      liquidity,
      confidence: 0.6,
      generatedAt: new Date().toISOString(),
      source: 'strategySupertrend',
    };
  }

  if (supertrend?.signal === 'Sell' && rsi < 45) {
    const entry = last.close;
    const stopLoss = last.high;
    const risk = stopLoss - entry;
    const qty = calculatePositionSize({
      capital: accountBalance,
      risk: accountBalance * riskPerTradePercentage,
      slPoints: risk,
      price: entry,
      volatility: atr,
    });
    return {
      stock: symbol,
      strategy: 'Supertrend',
      pattern: 'Supertrend',
      direction: 'Short',
      entry,
      stopLoss,
      target1: entry - risk * 0.75,
      target2: entry - risk * 1.5,
      qty,
      atr,
      spread,
      liquidity,
      confidence: 0.6,
      generatedAt: new Date().toISOString(),
      source: 'strategySupertrend',
    };
  }

  return null;
}

export function strategyEMAReversal(context = {}) {
  const {
    candles = [],
    features = computeFeatures(candles),
    symbol,
    accountBalance = 0,
    riskPerTradePercentage = 0.01,
    spread = 0,
    liquidity = 0,
  } = context;
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
    const qty = calculatePositionSize({
      capital: accountBalance,
      risk: accountBalance * riskPerTradePercentage,
      slPoints: risk,
      price: entry,
      volatility: risk,
    });
    return {
      stock: symbol,
      strategy: 'EMA Reversal',
      pattern: 'EMA Reversal',
      direction: 'Long',
      entry,
      stopLoss,
      target1: entry + risk * 0.5,
      target2: entry + risk * 1,
      qty,
      atr: risk,
      spread,
      liquidity,
      confidence: 0.55,
      generatedAt: new Date().toISOString(),
      source: 'strategyEMAReversal',
    };
  }

  if (prev.close > ema20 && last.close < ema20 && ema20 < ema50) {
    const entry = last.close;
    const stopLoss = prev.high;
    const risk = stopLoss - entry;
    const qty = calculatePositionSize({
      capital: accountBalance,
      risk: accountBalance * riskPerTradePercentage,
      slPoints: risk,
      price: entry,
      volatility: risk,
    });
    return {
      stock: symbol,
      strategy: 'EMA Reversal',
      pattern: 'EMA Reversal',
      direction: 'Short',
      entry,
      stopLoss,
      target1: entry - risk * 0.5,
      target2: entry - risk * 1,
      qty,
      atr: risk,
      spread,
      liquidity,
      confidence: 0.55,
      generatedAt: new Date().toISOString(),
      source: 'strategyEMAReversal',
    };
  }

  return null;
}

export function strategyTripleTop(context = {}) {
  const {
    candles = [],
    features = computeFeatures(candles),
    symbol,
    accountBalance = 0,
    riskPerTradePercentage = 0.01,
    spread = 0,
    liquidity = 0,
  } = context;
  if (!Array.isArray(candles) || candles.length < 7) return null;

  const atr = features?.atr ?? getATR(candles, 14);
  const patterns = detectAllPatterns(candles, atr, 5);
  const tripleTop = patterns.find(p => p.type === 'Triple Top');
  if (!tripleTop) return null;

  if (features?.rsi > 60) return null;

  const entry = tripleTop.breakout;
  const stopLoss = tripleTop.stopLoss;
  const risk = stopLoss - entry;
  const qty = calculatePositionSize({
    capital: accountBalance,
    risk: accountBalance * riskPerTradePercentage,
    slPoints: risk,
    price: entry,
    volatility: atr,
  });
  return {
    stock: symbol,
    strategy: 'Triple Top',
    pattern: 'Triple Top',
    direction: 'Short',
    entry,
    stopLoss,
    target1: entry - risk * 0.5,
    target2: entry - risk,
    qty,
    atr,
    spread,
    liquidity,
    confidence: 0.6,
    generatedAt: new Date().toISOString(),
    source: 'strategyTripleTop',
  };
}

export function strategyVWAPReversal(context = {}) {
  const {
    candles = [],
    features = computeFeatures(candles),
    symbol,
    accountBalance = 0,
    riskPerTradePercentage = 0.01,
    spread = 0,
    liquidity = 0,
  } = context;
  if (!Array.isArray(candles) || candles.length < 5) return null;

  const atr = features?.atr ?? getATR(candles, 14);
  const patterns = detectAllPatterns(candles, atr, 5);
  const pattern = patterns.find(p => p.type === 'VWAP Reversal');
  if (!pattern) return null;

  const entry = pattern.breakout;
  const stopLoss = pattern.stopLoss;
  const risk = Math.abs(entry - stopLoss);
  const direction = pattern.direction;
  const qty = calculatePositionSize({
    capital: accountBalance,
    risk: accountBalance * riskPerTradePercentage,
    slPoints: risk,
    price: entry,
    volatility: atr,
  });

  return {
    stock: symbol,
    strategy: 'VWAP Reversal',
    pattern: 'VWAP Reversal',
    direction,
    entry,
    stopLoss,
    target1:
      direction === 'Long' ? entry + risk * 0.5 : entry - risk * 0.5,
    target2:
      direction === 'Long' ? entry + risk : entry - risk,
    qty,
    atr,
    spread,
    liquidity,
    confidence: 0.55,
    generatedAt: new Date().toISOString(),
    source: 'strategyVWAPReversal',
  };
}

export function patternBasedStrategy(context = {}) {
  const {
    candles = [],
    features = computeFeatures(candles),
    symbol,
    accountBalance = 0,
    riskPerTradePercentage = 0.01,
    spread = 0,
    liquidity = 0,
  } = context;
  if (!Array.isArray(candles) || candles.length < 5) return null;

  const atr = features?.atr ?? getATR(candles, 14);
  const patterns = detectAllPatterns(candles, atr, 5);
  if (!patterns || patterns.length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const p of patterns) {
    const score = (p.strength || 1) *
      (p.confidence === 'High' ? 1 : p.confidence === 'Medium' ? 0.6 : 0.3);
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  if (!best) return null;

  const entry = best.breakout;
  const stopLoss = best.stopLoss;
  const direction = best.direction;
  const risk = Math.abs(entry - stopLoss);
  const qty = calculatePositionSize({
    capital: accountBalance,
    risk: accountBalance * riskPerTradePercentage,
    slPoints: risk,
    price: entry,
    volatility: atr,
  });
  const target1 = entry + (direction === 'Long' ? 1 : -1) * risk * 1.5;
  const target2 = entry + (direction === 'Long' ? 1 : -1) * risk * 2;

  return {
    stock: symbol,
    strategy: best.type,
    pattern: best.type,
    direction,
    entry,
    stopLoss,
    target1,
    target2,
    qty,
    atr,
    spread,
    liquidity,
    confidence: best.confidence,
    generatedAt: new Date().toISOString(),
    source: 'patternBasedStrategy',
  };
}

export function evaluateAllStrategies(context = {}) {
  const strategies = [
    patternBasedStrategy,
    strategySupertrend,
    strategyEMAReversal,
    strategyTripleTop,
    strategyVWAPReversal,
  ];
  return strategies
    .map((fn) => fn(context))
    .filter(Boolean);
}
