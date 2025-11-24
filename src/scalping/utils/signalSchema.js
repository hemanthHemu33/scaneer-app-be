export function buildSignal({
  symbol,
  side,
  entryType = "MARKET",
  entryPriceHint,
  stopLoss,
  target,
  quantity = 0,
  strategyId = "SCALP_V1",
  confidence = 0,
  timeValidTill,
}) {
  const now = Date.now();
  return {
    symbol,
    side,
    entryType,
    entryPriceHint,
    stopLoss,
    target,
    quantity,
    strategyId,
    confidence,
    timeValidTill,
    createdAt: now,
  };
}
