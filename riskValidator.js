// riskValidator.js
// Provides pre-execution risk validation utilities
import { logSignalRejected } from './auditLogger.js';
import { toISTDate } from './util.js';

function resolveStrategyCategory(name = '') {
  const s = String(name).toLowerCase();
  if (s.includes('supertrend')) return 'trend';
  if (s.includes('ema') && s.includes('reversal')) return 'mean-reversion';
  if (s.includes('vwap')) return 'mean-reversion';
  if (s.includes('triple top') || s.includes('double top') || s.includes('head & shoulders'))
    return 'breakout';
  if (s.includes('gap')) return 'breakout';
  if (s.includes('scalp') || s.includes('fade')) return 'scalping';
  if (s.includes('trend')) return 'trend';
  return s;
}

export function getMinRRForStrategy(strategy, winrate = 0) {
  const s = resolveStrategyCategory(strategy);
  switch (s) {
    case 'trend-following':
    case 'trend':
      return 2;
    case 'breakout':
      return 1.8;
    case 'mean-reversion':
      return 1.5;
    case 'scalping':
    case 'fade':
      return 1.2; // require high winrate separately
    case 'news':
    case 'news-event':
    case 'news/event setups':
      return 2;
    default:
      return 1.5;
  }
}

export function validateRR({ strategy, entry, stopLoss, target, winrate = 0 }) {
  const risk = Math.abs(entry - stopLoss);
  if (!risk) return { valid: false, rr: 0, minRR: Infinity };
  const rr = Math.abs((target - entry) / risk);
  const minRR = getMinRRForStrategy(strategy, winrate);
  // extra rule: scalping/fade needs winrate > 0.65
  const s = resolveStrategyCategory(strategy);
  if ((s === 'scalping' || s === 'fade') && winrate <= 0.65) {
    return { valid: false, rr, minRR, reason: 'winrateTooLowForScalping' };
  }
  if (rr < minRR) return { valid: false, rr, minRR, reason: 'rrBelowMin' };
  return { valid: true, rr, minRR };
}

export function adjustStopLoss({ price, stopLoss, direction, atr, structureBreak = false }) {
  let newSL = stopLoss;
  const safeAtr = Number.isFinite(atr) ? atr : price * 0.005;
  const thresh = safeAtr * 0.5;
  if (structureBreak) {
    return direction === 'Long' ? Math.max(stopLoss, price) : Math.min(stopLoss, price);
  }
  if (direction === 'Long') {
    if (price - stopLoss > thresh) {
      newSL = Math.max(stopLoss, price - thresh);
    }
  } else {
    if (stopLoss - price > thresh) {
      newSL = Math.min(stopLoss, price + thresh);
    }
  }
  return newSL;
}

export function isSLInvalid({ price, stopLoss, atr, structureBreak = false }) {
  // we don't auto-invalidate on structureBreak; SL is validated by distance
  const proximity = Math.abs(price - stopLoss);
  return proximity <= atr * 0.2;
}

// Ensure stop-loss distance is sensible relative to ATR
export function validateATRStopLoss({
  entry,
  stopLoss,
  atr,
  minMult = 0.5,
  maxMult = 3,
}) {
  if (!Number.isFinite(atr)) return true;
  if (![entry, stopLoss].every((n) => typeof n === 'number' && Number.isFinite(n)))
    return false;
  const dist = Math.abs(entry - stopLoss);
  if (dist <= atr * minMult) return false;
  if (dist > atr * maxMult) return false;
  return true;
}

// Validate trade entry against nearest support/resistance levels
export function validateSupportResistance({
  entry,
  direction,
  support,
  resistance,
  atr,
}) {
  const buffer = atr ? atr * 0.5 : entry * 0.01;
  if (direction === 'Long') {
    // block if too close to resistance
    if (typeof resistance === 'number' && resistance - entry <= buffer) return false;
  } else if (direction === 'Short') {
    // block if too close to support
    if (typeof support === 'number' && entry - support <= buffer) return false;
  }
  return true;
}

// Require current volume to exceed average volume by a multiplier
export function validateVolumeSpike({ volume, avgVolume, minSpike = 1.5 }) {
  if (!volume || !avgVolume) return true;
  return volume >= avgVolume * minSpike;
}

// Additional volatility and slippage checks
function computeSpreadLimit({ price, maxSpread, maxSpreadPct }) {
  if (typeof maxSpread === 'number') return maxSpread;
  if (typeof maxSpreadPct === 'number') {
    const p = Number(price);
    if (Number.isFinite(p) && p > 0) return (maxSpreadPct / 100) * p;
  }
  return null;
}

export function validateVolatilitySlippage({
  atr,
  minATR,
  maxATR,
  dailyRangePct,
  maxDailySpikePct,
  wickPct,
  volume,
  avgVolume,
  consolidationRatio = 0.3,
  slippage,
  maxSlippage,
  spread,
  maxSpreadPct,
  price,
  maxSpread,
}) {
  if (typeof minATR === 'number' && typeof atr === 'number' && atr < minATR)
    return false;
  if (typeof maxATR === 'number' && typeof atr === 'number' && atr > maxATR)
    return false;
  if (
    typeof maxDailySpikePct === 'number' &&
    typeof dailyRangePct === 'number' &&
    dailyRangePct > maxDailySpikePct
  )
    return false;
  if (typeof wickPct === 'number' && wickPct > 0.6) return false;
  if (
    typeof volume === 'number' &&
    typeof avgVolume === 'number' &&
    typeof consolidationRatio === 'number' &&
    volume < avgVolume * consolidationRatio
  )
    return false;
  if (
    typeof slippage === 'number' &&
    typeof maxSlippage === 'number' &&
    slippage > maxSlippage
  )
    return false;
  {
    const spreadLimit = computeSpreadLimit({ price, maxSpread, maxSpreadPct });
    if (typeof spread === 'number' && spreadLimit !== null && spread > spreadLimit)
      return false;
  }
  return true;
}

export function checkMarketConditions({
  atr,
  avgAtr,
  indexTrend,
  signalDirection,
  timeSinceSignal = 0,
  volume,
  spread,
  maxSpread,
  maxSpreadPct,
  price,
  newsImpact = false,
  eventActive = false,
}) {
  if (avgAtr && atr > avgAtr * 1.5) return false;
  if (indexTrend && signalDirection && indexTrend !== signalDirection) return false;
  if (timeSinceSignal > 2 * 60 * 1000) return false;
  if (typeof spread === 'number') {
    let spreadLimit = computeSpreadLimit({ price, maxSpread, maxSpreadPct });
    if (spreadLimit == null) spreadLimit = 0.3; // final fallback
    if (spread > spreadLimit) return false;
  }
  if (typeof volume === 'number' && volume <= 0) return false;
  if (newsImpact || eventActive) return false;
  return true;
}

export function checkTimingFilters({
  now = new Date(),
  minutesBeforeClose = 0,
  minutesAfterOpen = 0,
  holidays = [],
  specialSessions = [],
  eventActive = false,
  earningsCalendar = {},
  symbol,
  indexRebalanceDays = [],
  expiryDates = [],
}) {
  const local = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const total = local.getHours() * 60 + local.getMinutes();
  const open = 9 * 60 + 15;
  const close = 15 * 60 + 30;
  if (minutesBeforeClose && close - total <= minutesBeforeClose) return false;
  if (minutesAfterOpen && total - open < minutesAfterOpen) return false;
  const dateStr = toISTDate(local);
  if (holidays.includes(dateStr)) return false;
  if (specialSessions.includes(dateStr)) return false;
  if (eventActive) return false;
  if (indexRebalanceDays.includes(dateStr)) return false;
  if (expiryDates.includes(dateStr)) return false;
  const oneJan = new Date(local.getFullYear(), 0, 1);
  const week = Math.floor((local - oneJan) / (7 * 24 * 60 * 60 * 1000));
  if (symbol && Array.isArray(earningsCalendar[symbol]) && earningsCalendar[symbol].includes(week))
    return false;
  return true;
}

export function validatePreExecution(signal, market) {
  const { strategy } = signal.algoSignal || { strategy: signal.pattern };
  const rrInfo = validateRR({
    strategy,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    target: signal.target2,
    winrate: market.winrate || 0,
  });
  if (!rrInfo.valid) {
    console.log(
      `[RISK] ${signal.stock || signal.symbol} RR ${rrInfo.rr.toFixed(2)} below ${rrInfo.minRR}`
    );
    logSignalRejected(
      signal.signalId || signal.algoSignal?.signalId,
      rrInfo.reason || 'rRTooLow',
      { rr: rrInfo.rr, minRR: rrInfo.minRR },
      signal
    );
    return false;
  }

  if (
    isSLInvalid({
      price: market.currentPrice ?? signal.entry,
      stopLoss: signal.stopLoss,
      atr: signal.atr,
      structureBreak: market.structureBreak,
    })
  ) {
    console.log(`[RISK] ${signal.stock || signal.symbol} stop-loss invalid`);
    logSignalRejected(
      signal.signalId || signal.algoSignal?.signalId,
      'slInvalid',
      { price: market.currentPrice ?? signal.entry, stopLoss: signal.stopLoss },
      signal
    );
    return false;
  }

  if (
    !checkMarketConditions({
      atr: signal.atr,
      avgAtr: market.avgAtr,
      indexTrend: market.indexTrend,
      signalDirection: signal.direction === 'Long' ? 'up' : 'down',
      timeSinceSignal: market.timeSinceSignal,
      volume: market.volume,
      spread: signal.spread,
      price: market.currentPrice ?? signal.entry,
      maxSpread: market.maxSpread,
      maxSpreadPct: market.maxSpreadPct,
      newsImpact: market.newsImpact,
      eventActive: market.eventActive,
    })
  ) {
    console.log(`[RISK] ${signal.stock || signal.symbol} market conditions fail`);
    logSignalRejected(
      signal.signalId || signal.algoSignal?.signalId,
      'conflict',
      { market },
      signal
    );
    return false;
  }

  return true;
}
