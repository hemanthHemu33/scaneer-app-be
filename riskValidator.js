// riskValidator.js
// Provides pre-execution risk validation utilities
import { logSignalRejected } from './auditLogger.js';
import { toISTDate } from './util.js';

export function getMinRRForStrategy(strategy, winrate = 0) {
  const s = (strategy || '').toLowerCase();
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
      return winrate > 0.65 ? 1.2 : Infinity;
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
  return { valid: rr >= minRR, rr, minRR };
}

export function adjustStopLoss({ price, stopLoss, direction, atr, structureBreak = false }) {
  let newSL = stopLoss;
  const thresh = atr * 0.5;
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
  if (structureBreak) return true;
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
  if (!atr) return true;
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
    if (typeof support === 'number' && entry - support <= buffer) return false;
    if (typeof resistance === 'number' && resistance - entry <= buffer)
      return false;
  } else if (direction === 'Short') {
    if (typeof resistance === 'number' && resistance - entry <= buffer)
      return false;
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
    // Spread limit handling (supports absolute or percentage thresholds)
    let spreadLimit = null;
    if (typeof maxSpread === 'number') {
      spreadLimit = maxSpread;
    } else if (typeof maxSpreadPct === 'number') {
      if (typeof price === 'number' && price > 0) {
        spreadLimit = (maxSpreadPct / 100) * price;
      } else {
        // Fallback: interpret maxSpreadPct as an absolute if price is unavailable
        spreadLimit = maxSpreadPct;
      }
    }
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
    let spreadLimit = 0.3;
    if (typeof maxSpread === 'number') {
      spreadLimit = maxSpread;
    } else if (typeof maxSpreadPct === 'number') {
      if (typeof price === 'number' && price > 0) {
        spreadLimit = (maxSpreadPct / 100) * price;
      } else {
        spreadLimit = maxSpreadPct;
      }
    }
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
      'rRTooLow',
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
