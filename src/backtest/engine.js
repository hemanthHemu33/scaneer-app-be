export async function evaluateOnCandles({
  candles = [],
  symbol,
  market = {},
  filters = {},
}) {
  if (!Array.isArray(candles) || candles.length === 0 || !symbol) return null;
  const last = candles[candles.length - 1] || {};
  const liveTick = {
    last_price: last.close,
    volume_traded: last.volume,
    total_buy_quantity: market.totalBuy ?? 1000,
    total_sell_quantity: market.totalSell ?? 1000,
  };

  const { analyzeCandles } = await import('../../scanner.js');
  return analyzeCandles(
    candles,
    symbol,
    null,
    liveTick.total_buy_quantity,
    liveTick.total_sell_quantity,
    market.slippage ?? 0.1,
    market.spread ?? 0.3,
    market.liquidity ?? 5000,
    liveTick,
    filters
  );
}

export function computeDynamicExitPlan(signal = {}, opts = {}) {
  const direction = signal.direction || 'Long';
  const entry = Number(signal.entry);
  const stopLoss = Number(signal.stopLoss);
  const atr = Math.max(0.01, Number(opts.atr ?? signal.atr ?? Math.abs(entry - stopLoss)));
  const rr = Number.isFinite(opts.targetRR) ? opts.targetRR : 2;
  const trailAtr = Number.isFinite(opts.trailAtr) ? opts.trailAtr : 1.2;

  if (!Number.isFinite(entry) || !Number.isFinite(stopLoss) || entry <= 0) {
    return null;
  }

  const risk = Math.max(0.01, Math.abs(entry - stopLoss));
  const target = direction === 'Long'
    ? entry + risk * rr
    : entry - risk * rr;

  return {
    direction,
    entry,
    initialStop: stopLoss,
    activeStop: stopLoss,
    target,
    risk,
    atr,
    trailDistance: atr * trailAtr,
  };
}

export function updateDynamicExitPlan(plan, candle = {}) {
  if (!plan) return null;
  if (plan.direction === 'Long') {
    const candidate = Number(candle.high) - plan.trailDistance;
    if (Number.isFinite(candidate) && candidate > plan.activeStop) {
      plan.activeStop = Math.min(candidate, Number(candle.close) || candidate);
    }
  } else {
    const candidate = Number(candle.low) + plan.trailDistance;
    if (Number.isFinite(candidate) && candidate < plan.activeStop) {
      plan.activeStop = Math.max(candidate, Number(candle.close) || candidate);
    }
  }
  return plan;
}

export function evaluateExit(plan, candle = {}) {
  if (!plan) return null;
  const low = Number(candle.low);
  const high = Number(candle.high);

  if (plan.direction === 'Long') {
    if (Number.isFinite(low) && low <= plan.activeStop) {
      return { reason: 'stop', exit: plan.activeStop };
    }
    if (Number.isFinite(high) && high >= plan.target) {
      return { reason: 'target', exit: plan.target };
    }
  } else {
    if (Number.isFinite(high) && high >= plan.activeStop) {
      return { reason: 'stop', exit: plan.activeStop };
    }
    if (Number.isFinite(low) && low <= plan.target) {
      return { reason: 'target', exit: plan.target };
    }
  }

  return null;
}
