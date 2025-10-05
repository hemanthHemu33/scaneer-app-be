import { calculateEMA, getATR, computeFeatures } from './featureEngine.js';
import { detectAllPatterns, sanitizeCandles, toSpreadPct, confirmRetest } from './util.js';
import { detectGapUpOrDown } from './strategies.js';
import { RISK_REWARD_RATIO, calculatePositionSize } from './positionSizing.js';

const DEFAULT_SUPERTREND_SETTINGS = { atrLength: 10, multiplier: 3 };
const MAX_SPREAD_PCT = 0.5; // reject signals when quoted spread > 0.5% of price
const MIN_LIQUIDITY = 0;    // keep 0 if you don’t have a liquidity scale yet

function extractSizingParams(context = {}) {
  const {
    lotSize,
    minLotSize,
    minQty,
    leverage,
    marginPercent,
    marginPerLot,
    utilizationCap,
    marginBuffer,
    exchangeMarginMultiplier,
    costBuffer,
    drawdown,
    lossStreak,
    maxQty,
  } = context || {};
  return {
    lotSize,
    minLotSize,
    minQty,
    leverage,
    marginPercent,
    marginPerLot,
    utilizationCap,
    marginBuffer,
    exchangeMarginMultiplier,
    costBuffer,
    drawdown,
    lossStreak,
    maxQty,
  };
}

function buildSeriesKey(ctx = {}, fallback = 'strategy') {
  if (!ctx || typeof ctx !== 'object') return null;
  const symbol = ctx.symbol ?? null;
  const timeframe = ctx.timeframe ?? ctx.interval ?? null;
  const suffix = fallback || 'strategy';
  if (symbol) return `${symbol}:${timeframe || suffix}`;
  if (timeframe) return `${timeframe}:${suffix}`;
  return null;
}

export function strategySupertrend(context = {}) {
  const {
    candles = [],
    features: providedFeatures,
    symbol,
    accountBalance = 0,
    riskPerTradePercentage = 0.01,
    spread = 0,
    liquidity = 0,
    atr: contextAtr,
  } = context;
  const cleanCandles = Array.isArray(candles)
    ? context.__sanitizedCandles
      ? candles
      : sanitizeCandles(candles)
    : [];
  if (cleanCandles.length < 20) return null;

  const seriesKey = buildSeriesKey(context, 'supertrend');
  const features =
    providedFeatures ??
    computeFeatures(cleanCandles, {
      seriesKey,
      supertrendSettings: DEFAULT_SUPERTREND_SETTINGS,
    });
  const { rsi, supertrend } = features || {};
  const atr = contextAtr ?? features?.atr ?? getATR(cleanCandles, 14);
  const last = cleanCandles[cleanCandles.length - 1];
  if (!supertrend) return null;

  // reject low-quality markets (excessive spread) before sizing
  const spct = toSpreadPct(spread ?? 0, last?.close ?? 0);
  if (spct > MAX_SPREAD_PCT || (liquidity ?? 0) < MIN_LIQUIDITY) return null;

  if (supertrend.signal === 'Buy' && rsi > 55) {
    const entry = last.close;
    const stopLoss = Math.min(
      last.low ?? entry,
      supertrend.lowerBand ?? supertrend.level ?? entry
    );
    const risk = Math.abs(entry - stopLoss);
    if (!Number.isFinite(risk) || risk <= 0) return null;
    const rr = Math.max(RISK_REWARD_RATIO, 2);
    let qty = calculatePositionSize({
      capital: accountBalance,
      risk: accountBalance * riskPerTradePercentage,
      slPoints: risk,
      price: entry,
      volatility: atr,
      ...extractSizingParams(context),
    });
    qty = Math.max(1, Math.floor(qty || 0));
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
      algoSignal: { strategy: 'trend-following' },
    };
  }

  if (supertrend.signal === 'Sell' && rsi < 45) {
    const entry = last.close;
    const stopLoss = Math.max(
      last.high ?? entry,
      supertrend.upperBand ?? supertrend.level ?? entry
    );
    const risk = Math.abs(stopLoss - entry);
    if (!Number.isFinite(risk) || risk <= 0) return null;
    const rr = Math.max(RISK_REWARD_RATIO, 2);
    let qty = calculatePositionSize({
      capital: accountBalance,
      risk: accountBalance * riskPerTradePercentage,
      slPoints: risk,
      price: entry,
      volatility: atr,
      ...extractSizingParams(context),
    });
    qty = Math.max(1, Math.floor(qty || 0));
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
      algoSignal: { strategy: 'trend-following' },
    };
  }

  return null;
}

export function strategyEMAReversal(context = {}) {
  const {
    candles = [],
    features: providedFeatures,
    symbol,
    accountBalance = 0,
    riskPerTradePercentage = 0.01,
    spread = 0,
    liquidity = 0,
    atr: contextAtr,
  } = context;
  const cleanCandles = Array.isArray(candles)
    ? context.__sanitizedCandles
      ? candles
      : sanitizeCandles(candles)
    : [];
  if (cleanCandles.length < 20) return null;

  const seriesKey = buildSeriesKey(context, 'ema');
  const features =
    providedFeatures ??
    computeFeatures(cleanCandles, {
      seriesKey,
      supertrendSettings: DEFAULT_SUPERTREND_SETTINGS,
    });

  const closes = cleanCandles.map(c => c.close);
  const ema20 = calculateEMA(closes, 20, seriesKey ? `${seriesKey}:ema20` : undefined);
  const ema50 = calculateEMA(closes, 50, seriesKey ? `${seriesKey}:ema50` : undefined);
  const last = cleanCandles[cleanCandles.length - 1];
  const prev = cleanCandles[cleanCandles.length - 2];
  const atr = contextAtr ?? features?.atr ?? getATR(cleanCandles, 14);
  const spct = toSpreadPct(spread ?? 0, last?.close ?? 0);
  if (spct > MAX_SPREAD_PCT || (liquidity ?? 0) < MIN_LIQUIDITY) return null;

  if (prev.close < ema20 && last.close > ema20 && ema20 > ema50) {
    const entry = last.close;
    const stopLoss = prev.low;
    const risk = Math.abs(entry - stopLoss);
    if (!Number.isFinite(risk) || risk <= 0) return null;
    let qty = calculatePositionSize({
      capital: accountBalance,
      risk: accountBalance * riskPerTradePercentage,
      slPoints: risk,
      price: entry,
      volatility: atr,
      ...extractSizingParams(context),
    });
    qty = Math.max(1, Math.floor(qty || 0));
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
      algoSignal: { strategy: 'mean-reversion' },
    };
  }

  if (prev.close > ema20 && last.close < ema20 && ema20 < ema50) {
    const entry = last.close;
    const stopLoss = prev.high;
    const risk = Math.abs(stopLoss - entry);
    if (!Number.isFinite(risk) || risk <= 0) return null;
    let qty = calculatePositionSize({
      capital: accountBalance,
      risk: accountBalance * riskPerTradePercentage,
      slPoints: risk,
      price: entry,
      volatility: atr,
      ...extractSizingParams(context),
    });
    qty = Math.max(1, Math.floor(qty || 0));
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
      algoSignal: { strategy: 'mean-reversion' },
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
  const cleanCandles = Array.isArray(candles)
    ? context.__sanitizedCandles
      ? candles
      : sanitizeCandles(candles)
    : [];
  if (!Array.isArray(cleanCandles) || cleanCandles.length < 7) return null;

  const seriesKey = buildSeriesKey(context, 'tripleTop');
  const featureSet =
    features ??
    computeFeatures(cleanCandles, {
      seriesKey,
      supertrendSettings: DEFAULT_SUPERTREND_SETTINGS,
    });
  if (!featureSet) return null;

  const atr = (contextAtr ?? featureSet?.atr ?? getATR(cleanCandles, 14)) ?? 0;
  const patterns = detectAllPatterns(cleanCandles, atr, 5);
  const tripleTop = patterns.find(p => p.type === 'Triple Top');
  if (!tripleTop) return null;

  if (featureSet?.rsi > 60) return null;

  const entry = tripleTop.breakout;
  const spct = toSpreadPct(spread ?? 0, entry ?? 0);
  if (spct > MAX_SPREAD_PCT || (liquidity ?? 0) < MIN_LIQUIDITY) return null;
  const stopLoss = tripleTop.stopLoss;
  const risk = Math.abs(stopLoss - entry);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  let qty = calculatePositionSize({
    capital: accountBalance,
    risk: accountBalance * riskPerTradePercentage,
    slPoints: risk,
    price: entry,
    volatility: atr,
    ...extractSizingParams(context),
  });
  qty = Math.max(1, Math.floor(qty || 0));
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
    algoSignal: { strategy: 'breakout' },
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
  const cleanCandles = Array.isArray(candles)
    ? context.__sanitizedCandles
      ? candles
      : sanitizeCandles(candles)
    : [];
  if (!Array.isArray(cleanCandles) || cleanCandles.length < 5) return null;

  const seriesKey = buildSeriesKey(context, 'vwap');
  const featureSet =
    features ??
    computeFeatures(cleanCandles, {
      seriesKey,
      supertrendSettings: DEFAULT_SUPERTREND_SETTINGS,
    });
  if (!featureSet) return null;

  const atr = (contextAtr ?? featureSet?.atr ?? getATR(cleanCandles, 14)) ?? 0;
  const patterns = detectAllPatterns(cleanCandles, atr, 5);
  const pattern = patterns.find(p => p.type === 'VWAP Reversal');
  if (!pattern) return null;

  const entry = pattern.breakout;
  const spct = toSpreadPct(spread ?? 0, entry ?? 0);
  if (spct > MAX_SPREAD_PCT || (liquidity ?? 0) < MIN_LIQUIDITY) return null;
  const stopLoss = pattern.stopLoss;
  const risk = Math.abs(entry - stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const direction = pattern.direction;
  let qty = calculatePositionSize({
    capital: accountBalance,
    risk: accountBalance * riskPerTradePercentage,
    slPoints: risk,
    price: entry,
    volatility: atr,
    ...extractSizingParams(context),
  });
  qty = Math.max(1, Math.floor(qty || 0));

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
    algoSignal: { strategy: 'mean-reversion' },
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
  const cleanCandles = Array.isArray(candles)
    ? context.__sanitizedCandles
      ? candles
      : sanitizeCandles(candles)
    : [];
  if (!Array.isArray(cleanCandles) || cleanCandles.length < 5) return null;

  const seriesKey = buildSeriesKey(context, 'pattern');
  const featureSet =
    features ??
    computeFeatures(cleanCandles, {
      seriesKey,
      supertrendSettings: DEFAULT_SUPERTREND_SETTINGS,
    });
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
  const spct = toSpreadPct(spread ?? 0, entry ?? 0);
  if (spct > MAX_SPREAD_PCT || (liquidity ?? 0) < MIN_LIQUIDITY) return null;
  // optional retest confirmation boost
  const retested = confirmRetest(cleanCandles, entry, direction, { atr });
  let qty = calculatePositionSize({
    capital: accountBalance,
    risk: accountBalance * riskPerTradePercentage,
    slPoints: risk,
    price: entry,
    volatility: atr,
    ...extractSizingParams(context),
  });
  qty = Math.max(1, Math.floor(qty || 0));
  const dir = direction === 'Long' ? 1 : -1;
  const target1 = entry + dir * risk * (RISK_REWARD_RATIO * 0.5);
  const target2 = entry + dir * risk * RISK_REWARD_RATIO;
  const strategyCategory = /breakout|flag|triangle|channel|bos/i.test(best.type)
    ? 'breakout'
    : 'mean-reversion';
  let confidence =
    best.confidence === 'High'
      ? 0.7
      : best.confidence === 'Medium'
        ? 0.55
        : 0.4;
  if (retested) confidence = Math.min(confidence + 0.05, 0.85);

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
    confidence,
    generatedAt: new Date().toISOString(),
    source: 'patternBasedStrategy',
    strategyCategory,
    algoSignal: { strategy: strategyCategory },
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
    atr: contextAtr,
  } = context;

  const daily = Array.isArray(dailyHistory) ? sanitizeCandles(dailyHistory) : [];
  const session = Array.isArray(sessionCandles) ? sanitizeCandles(sessionCandles) : [];
  const pattern = detectGapUpOrDown({ dailyHistory: daily, sessionCandles: session });
  if (!pattern) return null;
  const atr =
    contextAtr ??
    getATR(session, 14) ??
    getATR(daily, 14) ??
    0;

  const entry = pattern.breakout;
  const spct = toSpreadPct(spread ?? 0, entry ?? 0);
  if (spct > MAX_SPREAD_PCT || (liquidity ?? 0) < MIN_LIQUIDITY) return null;
  const stopLoss = pattern.stopLoss;
  const risk = Math.abs(entry - stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  let qty = calculatePositionSize({
    capital: accountBalance,
    risk: accountBalance * riskPerTradePercentage,
    slPoints: risk,
    price: entry,
    volatility: atr,
    ...extractSizingParams(context),
  });
  qty = Math.max(1, Math.floor(qty || 0));
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
    algoSignal: { strategy: 'news-event' },
  };
}

export function evaluateAllStrategies(context = {}) {
  const base = { ...context };
  if (Array.isArray(base.candles)) {
    const cleanCandles = sanitizeCandles(base.candles);
    base.candles = cleanCandles;
    base.__sanitizedCandles = true;
    const seriesKey = buildSeriesKey(base, 'strategy');
    base.features =
      base.features ??
      computeFeatures(cleanCandles, {
        seriesKey,
        supertrendSettings: DEFAULT_SUPERTREND_SETTINGS,
      });
    base.atr = base.atr ?? base.features?.atr ?? getATR(cleanCandles, 14);
  }
  if (Array.isArray(base.dailyHistory)) {
    base.dailyHistory = sanitizeCandles(base.dailyHistory);
  }
  if (Array.isArray(base.sessionCandles)) {
    base.sessionCandles = sanitizeCandles(base.sessionCandles);
  }
  const strategies = [
    patternBasedStrategy,
    strategyGapUpDown,
    strategySupertrend,
    strategyEMAReversal,
    strategyTripleTop,
    strategyVWAPReversal,
  ];
  return strategies
    .map((fn) => fn(base))
    .filter(Boolean);
}
