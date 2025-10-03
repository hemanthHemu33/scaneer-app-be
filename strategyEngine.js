import { calculateEMA, getATR, computeFeatures } from './featureEngine.js';
import { detectAllPatterns, sanitizeCandles } from './util.js';
import { detectGapUpOrDown } from './strategies.js';
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
    atr: contextAtr,
  } = context;
  if (!Array.isArray(candles) || candles.length < 20) return null;

  const { rsi, supertrend } = features || {};
  const atr = contextAtr ?? features?.atr ?? getATR(candles, 14);
  const last = candles[candles.length - 1];

  if (supertrend?.signal === 'Buy' && rsi > 55) {
    const entry = last.close;
    const stopLoss = last.low;
    const risk = Math.abs(entry - stopLoss);
    if (!Number.isFinite(risk) || risk <= 0) return null;
    const rr = Math.max(RISK_REWARD_RATIO, 2);
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
      target1: entry + risk * (rr * 0.5),
      target2: entry + risk * rr,
      qty,
      atr,
      spread,
      liquidity,
      confidence: 0.6,
      generatedAt: new Date().toISOString(),
      source: 'strategySupertrend',
      strategyCategory: 'trend-following',
    };
  }

  if (supertrend?.signal === 'Sell' && rsi < 45) {
    const entry = last.close;
    const stopLoss = last.high;
    const risk = Math.abs(stopLoss - entry);
    if (!Number.isFinite(risk) || risk <= 0) return null;
    const rr = Math.max(RISK_REWARD_RATIO, 2);
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
      target1: entry - risk * (rr * 0.5),
      target2: entry - risk * rr,
      qty,
      atr,
      spread,
      liquidity,
      confidence: 0.6,
      generatedAt: new Date().toISOString(),
      source: 'strategySupertrend',
      strategyCategory: 'trend-following',
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
    atr: contextAtr,
  } = context;
  if (!Array.isArray(candles) || candles.length < 20) return null;

  const closes = candles.map(c => c.close);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const atr = contextAtr ?? features?.atr ?? getATR(candles, 14);

  if (prev.close < ema20 && last.close > ema20 && ema20 > ema50) {
    const entry = last.close;
    const stopLoss = prev.low;
    const risk = Math.abs(entry - stopLoss);
    if (!Number.isFinite(risk) || risk <= 0) return null;
    const qty = calculatePositionSize({
      capital: accountBalance,
      risk: accountBalance * riskPerTradePercentage,
      slPoints: risk,
      price: entry,
      volatility: atr,
    });
    return {
      stock: symbol,
      strategy: 'EMA Reversal',
      pattern: 'EMA Reversal',
      direction: 'Long',
      entry,
      stopLoss,
      target1: entry + risk * (RISK_REWARD_RATIO * 0.5),
      target2: entry + risk * RISK_REWARD_RATIO,
      qty,
      atr,
      spread,
      liquidity,
      confidence: 0.55,
      generatedAt: new Date().toISOString(),
      source: 'strategyEMAReversal',
      strategyCategory: 'mean-reversion',
    };
  }

  if (prev.close > ema20 && last.close < ema20 && ema20 < ema50) {
    const entry = last.close;
    const stopLoss = prev.high;
    const risk = Math.abs(stopLoss - entry);
    if (!Number.isFinite(risk) || risk <= 0) return null;
    const qty = calculatePositionSize({
      capital: accountBalance,
      risk: accountBalance * riskPerTradePercentage,
      slPoints: risk,
      price: entry,
      volatility: atr,
    });
    return {
      stock: symbol,
      strategy: 'EMA Reversal',
      pattern: 'EMA Reversal',
      direction: 'Short',
      entry,
      stopLoss,
      target1: entry - risk * (RISK_REWARD_RATIO * 0.5),
      target2: entry - risk * RISK_REWARD_RATIO,
      qty,
      atr,
      spread,
      liquidity,
      confidence: 0.55,
      generatedAt: new Date().toISOString(),
      source: 'strategyEMAReversal',
      strategyCategory: 'mean-reversion',
    };
  }

  return null;
}

export function strategyTripleTop(context = {}) {
  const {
    candles = [],
    features = null,
    symbol,
    accountBalance = 0,
    riskPerTradePercentage = 0.01,
    spread = 0,
    liquidity = 0,
    atr: contextAtr,
  } = context;
  const cleanCandles = sanitizeCandles(candles);
  if (!Array.isArray(cleanCandles) || cleanCandles.length < 7) return null;

  const featureSet = features ?? computeFeatures(cleanCandles);
  if (!featureSet) return null;

  const atr = (contextAtr ?? featureSet?.atr ?? getATR(cleanCandles, 14)) ?? 0;
  const patterns = detectAllPatterns(cleanCandles, atr, 5);
  const tripleTop = patterns.find(p => p.type === 'Triple Top');
  if (!tripleTop) return null;

  if (featureSet?.rsi > 60) return null;

  const entry = tripleTop.breakout;
  const stopLoss = tripleTop.stopLoss;
  const risk = Math.abs(stopLoss - entry);
  if (!Number.isFinite(risk) || risk <= 0) return null;
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
    target1: entry - risk * (RISK_REWARD_RATIO * 0.5),
    target2: entry - risk * RISK_REWARD_RATIO,
    qty,
    atr,
    spread,
    liquidity,
    confidence: 0.6,
    generatedAt: new Date().toISOString(),
    source: 'strategyTripleTop',
    strategyCategory: 'breakout',
  };
}

export function strategyVWAPReversal(context = {}) {
  const {
    candles = [],
    features = null,
    symbol,
    accountBalance = 0,
    riskPerTradePercentage = 0.01,
    spread = 0,
    liquidity = 0,
    atr: contextAtr,
  } = context;
  const cleanCandles = sanitizeCandles(candles);
  if (!Array.isArray(cleanCandles) || cleanCandles.length < 5) return null;

  const featureSet = features ?? computeFeatures(cleanCandles);
  if (!featureSet) return null;

  const atr = (contextAtr ?? featureSet?.atr ?? getATR(cleanCandles, 14)) ?? 0;
  const patterns = detectAllPatterns(cleanCandles, atr, 5);
  const pattern = patterns.find(p => p.type === 'VWAP Reversal');
  if (!pattern) return null;

  const entry = pattern.breakout;
  const stopLoss = pattern.stopLoss;
  const risk = Math.abs(entry - stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) return null;
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
    target1: direction === 'Long'
      ? entry + risk * (RISK_REWARD_RATIO * 0.5)
      : entry - risk * (RISK_REWARD_RATIO * 0.5),
    target2: direction === 'Long'
      ? entry + risk * RISK_REWARD_RATIO
      : entry - risk * RISK_REWARD_RATIO,
    qty,
    atr,
    spread,
    liquidity,
    confidence: 0.55,
    generatedAt: new Date().toISOString(),
    source: 'strategyVWAPReversal',
    strategyCategory: 'mean-reversion',
  };
}

export function patternBasedStrategy(context = {}) {
  const {
    candles = [],
    features = null,
    symbol,
    accountBalance = 0,
    riskPerTradePercentage = 0.01,
    spread = 0,
    liquidity = 0,
    atr: contextAtr,
  } = context;
  const cleanCandles = sanitizeCandles(candles);
  if (!Array.isArray(cleanCandles) || cleanCandles.length < 5) return null;

  const featureSet = features ?? computeFeatures(cleanCandles);
  if (!featureSet) return null;

  const atr = (contextAtr ?? featureSet?.atr ?? getATR(cleanCandles, 14)) ?? 0;
  const patterns = detectAllPatterns(cleanCandles, atr, 5);
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
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const qty = calculatePositionSize({
    capital: accountBalance,
    risk: accountBalance * riskPerTradePercentage,
    slPoints: risk,
    price: entry,
    volatility: atr,
  });
  const dir = direction === 'Long' ? 1 : -1;
  const target1 = entry + dir * risk * (RISK_REWARD_RATIO * 0.5);
  const target2 = entry + dir * risk * RISK_REWARD_RATIO;

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
    strategyCategory: /breakout|flag|triangle|channel|bos/i.test(best.type) ? 'breakout' : 'mean-reversion',
  };
}

export function strategyGapUpDown(context = {}) {
  const {
    symbol,
    dailyHistory = [],
    sessionCandles = [],
    accountBalance = 0,
    riskPerTradePercentage = 0.01,
    spread = 0,
    liquidity = 0,
  } = context;

  const pattern = detectGapUpOrDown({ dailyHistory, sessionCandles });
  if (!pattern) return null;
  const atr = getATR(sessionCandles, 14) ?? getATR(dailyHistory, 14) ?? 0;

  const entry = pattern.breakout;
  const stopLoss = pattern.stopLoss;
  const risk = Math.abs(entry - stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const qty = calculatePositionSize({
    capital: accountBalance,
    risk: accountBalance * riskPerTradePercentage,
    slPoints: risk,
    price: entry,
    volatility: atr,
  });
  const target1 =
    entry + (pattern.direction === 'Long' ? 1 : -1) * risk * RISK_REWARD_RATIO * 0.5;
  const target2 =
    entry + (pattern.direction === 'Long' ? 1 : -1) * risk * RISK_REWARD_RATIO;

  return {
    stock: symbol,
    strategy: pattern.type,
    pattern: pattern.type,
    direction: pattern.direction,
    entry,
    stopLoss,
    target1,
    target2,
    qty,
    atr,
    spread,
    liquidity,
    confidence: 0.7,
    generatedAt: new Date().toISOString(),
    source: 'strategyGapUpDown',
    gapPercent: pattern.gapPercent,
    strategyCategory: 'news-event',
  };
}

export function evaluateAllStrategies(context = {}) {
  const strategies = [
    patternBasedStrategy,
    strategyGapUpDown,
    strategySupertrend,
    strategyEMAReversal,
    strategyTripleTop,
    strategyVWAPReversal,
  ];
  return strategies
    .map((fn) => fn(context))
    .filter(Boolean);
}
