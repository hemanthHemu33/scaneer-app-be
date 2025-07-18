// confidence.js
import { getHigherTimeframeData } from './kite.js';

// In-memory strategy statistics { symbol: { strategy: { wins, trades } } }
export const strategyStats = {};

export function recordStrategyResult(symbol, strategy, win) {
  if (!strategyStats[symbol]) strategyStats[symbol] = {};
  const stat = strategyStats[symbol][strategy] || { wins: 0, trades: 0 };
  stat.trades += 1;
  if (win) stat.wins += 1;
  strategyStats[symbol][strategy] = stat;
}

export function getStrategyHitRate(symbol, strategy) {
  const stat = strategyStats[symbol]?.[strategy];
  if (!stat || stat.trades === 0) return 0.5;
  return stat.wins / stat.trades;
}

export function timeOfDayScore(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 9 && h < 11) return 1; // early session
  if (h >= 11 && h < 14) return 0.8;
  return 0.6; // later in the day
}

export function confirmationScore(count = 0) {
  return Math.min(count / 3, 1); // saturate at 3
}

export function signalQualityScore({
  atr,
  rvol,
  strongPriceAction = false,
  cleanBody = true,
  rrRatio = 1,
  atrStable = true,
  awayFromConsolidation = true,
} = {}) {
  const atrScore = Math.min(atr / 2, 1);
  const volumeScore = Math.min(rvol / 2, 1);
  const priceActionScore = strongPriceAction ? 1 : 0.5;
  const wickScore = cleanBody ? 1 : 0.5;
  const rrScore = Math.min(rrRatio / 3, 1);
  const stabilityScore = atrStable ? 1 : 0.5;
  const consolidationScore = awayFromConsolidation ? 1 : 0.5;
  return (
    atrScore * 0.2 +
    volumeScore * 0.2 +
    priceActionScore * 0.2 +
    wickScore * 0.1 +
    rrScore * 0.2 +
    stabilityScore * 0.05 +
    consolidationScore * 0.05
  );
}

export function computeConfidenceScore({
  hitRate = 0.5,
  date = new Date(),
  confirmations = 0,
  quality = 0.5,
} = {}) {
  const score =
    hitRate * 0.4 +
    timeOfDayScore(date) * 0.2 +
    confirmationScore(confirmations) * 0.2 +
    quality * 0.2;
  return Math.max(0, Math.min(score, 1));
}

export function evaluateCoreFactors(context = {}, pattern = {}) {
  const {
    features = {},
    last = {},
    rvol = 1,
    higherTimeframe = {},
    retested = false,
  } = context;

  const {
    ema9 = 0,
    ema21 = 0,
    ema50 = 0,
    rsi = 50,
    macd = {},
    supertrend = {},
    vwap,
    pivot = {},
    fibRetracements = {},
  } = features;

  const { ema50: hEMA50 = 0, supertrend: hSuper = {} } = higherTimeframe;

  const direction = pattern.direction;
  const price = last?.close ?? pattern.breakout ?? 0;

  const scores = [];

  const up = ema9 > ema21 && ema21 > ema50;
  const down = ema9 < ema21 && ema21 < ema50;
  scores.push((direction === 'Long' && up) || (direction === 'Short' && down) ? 1 : 0);

  let confirm = 0;
  if ((direction === 'Long' && rsi >= 50) || (direction === 'Short' && rsi <= 50)) confirm += 1;
  if (macd && typeof macd.histogram === 'number') {
    if ((direction === 'Long' && macd.histogram > 0) || (direction === 'Short' && macd.histogram < 0)) confirm += 1;
  }
  if ((direction === 'Long' && ema9 > ema21) || (direction === 'Short' && ema9 < ema21)) confirm += 1;
  scores.push(confirm / 3);

  if (typeof pattern.strength === 'number') scores.push(Math.min(pattern.strength / 3, 1));
  else scores.push(0.5);

  scores.push(Math.min((rvol || 1) / 2, 1));

  if (pattern.type === 'Breakout') scores.push(retested ? 1 : 0);
  else scores.push(0.5);

  let keyLevel = 0;
  if (vwap && price) {
    if (Math.abs(price - vwap) / price < 0.005) keyLevel = 1;
  }
  if (!keyLevel && pivot?.pp && price) {
    if (Math.abs(price - pivot.pp) / price < 0.005) keyLevel = 1;
  }
  if (!keyLevel && fibRetracements && price) {
    for (const lvl of Object.values(fibRetracements)) {
      if (Math.abs(price - lvl) / price < 0.01) {
        keyLevel = 1;
        break;
      }
    }
  }
  scores.push(keyLevel);

  const higherOk =
    (direction === 'Long' && hSuper.signal === 'Buy' && price >= hEMA50) ||
    (direction === 'Short' && hSuper.signal === 'Sell' && price <= hEMA50);
  scores.push(higherOk ? 1 : 0.5);

  const stOk = supertrend.signal === (direction === 'Long' ? 'Buy' : 'Sell');
  scores.push(stOk ? 1 : 0);

  const total = scores.reduce((a, b) => a + b, 0);
  return { score: total / scores.length };
}

export async function evaluateTrendConfidence(context = {}, pattern = {}) {
  const {
    features = {},
    tick,
    liquidity,
    spread = 0,
    depth,
    totalBuy = 0,
    totalSell = 0,
    last,
    filters = {},
    symbol,
    quality = 0.5,
    history = {},
  } = context;

  const {
    ema9 = 0,
    ema21 = 0,
    ema50 = 0,
    supertrend = {},
  } = features;

  const { minBuySellRatio = 0.8, maxSpread = Infinity, minLiquidity = 0 } =
    filters;

  const isUptrend = ema9 > ema21 && ema21 > ema50;
  const isDowntrend = ema9 < ema21 && ema21 < ema50;
  const isTrendClean =
    (pattern.direction === 'Long' && isUptrend) ||
    (pattern.direction === 'Short' && isDowntrend);

  let confidence = isTrendClean ? 'High' : 'Medium';

  if (tick?.volume_traded && liquidity && liquidity !== 'NA') {
    const ratio = tick.volume_traded / liquidity;
    if (ratio > 2.5) {
      if (
        pattern.direction === 'Long' &&
        tick.total_buy_quantity > tick.total_sell_quantity * 1.5
      ) {
        confidence = 'High';
      } else if (
        pattern.direction === 'Short' &&
        tick.total_sell_quantity > tick.total_buy_quantity * 1.5
      ) {
        confidence = 'High';
      }
    }
    if (ratio < 0.3) {
      return { confidence: 'Low', score: 0 };
    }
  }

  if (
    (pattern.direction === 'Long' && ema9 < ema21 * 0.98) ||
    (pattern.direction === 'Short' && ema9 > ema21 * 1.02)
  ) {
    confidence = 'Medium';
  }

  if (
    (pattern.direction === 'Long' && supertrend.signal === 'Sell') ||
    (pattern.direction === 'Short' && supertrend.signal === 'Buy')
  ) {
    confidence = 'Low';
  }

  if (
    (pattern.direction === 'Long' && totalBuy < totalSell * 0.9) ||
    (pattern.direction === 'Short' && totalSell < totalBuy * 0.9)
  ) {
    confidence = 'Low';
  }

  const higherTF = await getHigherTimeframeData(symbol, '15minute');
  if (!higherTF) return { confidence: 'Low', score: 0 };

  const { ema50: higherEMA50 = 0, supertrend: higherSuper = {} } = higherTF;
  const higherTrendOk =
    (pattern.direction === 'Long' &&
      higherSuper.signal === 'Buy' &&
      last?.close > higherEMA50 * 0.98) ||
    (pattern.direction === 'Short' &&
      higherSuper.signal === 'Sell' &&
      last?.close < higherEMA50 * 1.02);

  if (!higherTrendOk && confidence !== 'Low') confidence = 'Medium';

  if (depth) {
    const bestBid = depth.buy?.[0]?.price || 0;
    const bestAsk = depth.sell?.[0]?.price || 0;
    const ratio = totalBuy / (totalSell || 1);
    if (
      (pattern.direction === 'Long' && bestBid < last.close * 0.995) ||
      (pattern.direction === 'Short' && bestAsk > last.close * 1.005)
    ) {
      confidence = 'Low';
    }
    if (
      (pattern.direction === 'Long' && ratio < minBuySellRatio) ||
      (pattern.direction === 'Short' && ratio > 1 / minBuySellRatio)
    ) {
      confidence = 'Low';
    }
  }

  if (spread > maxSpread || liquidity < Math.max(minLiquidity, liquidity * 0.6)) {
    confidence = 'Low';
  }

  if (confidence === 'Low') return { confidence: 'Low', score: 0 };

  let confirmations = 0;
  const hist = history[symbol] || {};
  for (const arr of Object.values(hist)) {
    confirmations += arr.filter(
      (s) => Date.now() - s.timestamp < 5 * 60 * 1000 && s.direction === pattern.direction
    ).length;
  }
  const baseScore = confidence === 'High' ? 0.8 : confidence === 'Medium' ? 0.6 : 0.4;
  const hitRate = getStrategyHitRate(symbol, pattern.type);
  const dynamicScore = computeConfidenceScore({
    hitRate,
    confirmations,
    quality,
    date: new Date(),
  });
  const finalScore = (baseScore + dynamicScore) / 2;
  const core = evaluateCoreFactors(
    { features, last, rvol: features.rvol, higherTimeframe: higherTF },
    pattern
  );
  const combined = finalScore * 0.8 + core.score * 0.2;
  const finalConfidence =
    combined >= 0.75 ? 'High' : combined >= 0.5 ? 'Medium' : 'Low';

  return { confidence: finalConfidence, score: combined };
}
