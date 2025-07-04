let trailingPct = 0.5;

export function setTrailingPercent(pct) {
  trailingPct = pct;
}

export function getTrailingStop(entry, direction) {
  const dist = entry * (trailingPct / 100);
  return direction === 'Long' ? entry - dist : entry + dist;
}

/**
 * Update trailing stop on the position and return true if stop triggered.
 * @param {Object} position - {side, entryPrice, stopLoss, lastPrice}
 * @returns {boolean} exit due to stop hit
 */
export function applyTrailingSL(position) {
  if (!position || typeof position.lastPrice !== 'number') return false;
  if (position.side === 'Long' || position.side === 'long') {
    position.highest = Math.max(position.highest ?? position.entryPrice, position.lastPrice);
    const sl = position.highest * (1 - trailingPct / 100);
    if (!position.stopLoss || sl > position.stopLoss) position.stopLoss = sl;
    return position.lastPrice <= position.stopLoss;
  }
  position.lowest = Math.min(position.lowest ?? position.entryPrice, position.lastPrice);
  const sl = position.lowest * (1 + trailingPct / 100);
  if (!position.stopLoss || sl < position.stopLoss) position.stopLoss = sl;
  return position.lastPrice >= position.stopLoss;
}

/**
 * Force exit based on holding duration.
 * @param {Object} position - {openTime, maxHoldMs}
 * @returns {boolean}
 */
export function forceTimeExit(position) {
  if (!position?.openTime) return false;
  const hold = Date.now() - position.openTime;
  const max = position.maxHoldMs ?? 6 * 60 * 60 * 1000; // default 6h
  return hold >= max;
}

/**
 * Detect simple price reversal using last 3 prices.
 * @param {Object} position - {side, history: number[]}
 * @returns {boolean}
 */
export function detectReversalExit(position) {
  const hist = position?.history || [];
  if (hist.length < 3) return false;
  const [p3, p2, p1] = hist.slice(-3);
  if (position.side === 'Long' || position.side === 'long') {
    return p1 < p2 && p2 < p3;
  }
  return p1 > p2 && p2 > p3;
}

export function checkExitConditions(position) {
  if (applyTrailingSL(position)) return 'trailing';
  if (forceTimeExit(position)) return 'time';
  if (detectReversalExit(position)) return 'reversal';
  return null;
}

export function shouldExit(signal, price, timeHeldMs) {
  if (!signal) return false;
  const slHit = signal.direction === 'Long' ? price <= signal.stopLoss : price >= signal.stopLoss;
  if (slHit) return true;
  if (signal.expiresAt && Date.now() > new Date(signal.expiresAt).getTime()) return true;
  return false;
}
