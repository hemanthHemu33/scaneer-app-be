let trailingPct = 0.5;

export function setTrailingPercent(pct) {
  trailingPct = pct;
}

export function getTrailingStop(entry, direction) {
  const dist = entry * (trailingPct / 100);
  return direction === 'Long' ? entry - dist : entry + dist;
}

export function shouldExit(signal, price, timeHeldMs) {
  if (!signal) return false;
  const slHit =
    signal.direction === 'Long'
      ? price <= signal.stopLoss
      : price >= signal.stopLoss;
  if (slHit) return true;
  if (signal.expiresAt && Date.now() > new Date(signal.expiresAt).getTime())
    return true;
  return false;
}
