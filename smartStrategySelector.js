// smartStrategySelector.js
// Provides market regime detection and strategy filtering utilities

export const marketContext = {
  regime: 'sideways',
  vix: null,
  adx: null,
  emaSlope: 0,
  breadth: 1,
  history: [],
  sectorBreadth: {},
  economicEvents: [],
  volatility: 'normal',
  overrides: {},
  lastUpdate: null,
  lastTransition: null,
};

export function supportUserOverrides(overrides = {}) {
  marketContext.overrides = { ...marketContext.overrides, ...overrides };
}

export function applyVIXThresholds(vix) {
  marketContext.vix = vix;
  const calm = marketContext.overrides.vixCalm ?? 14;
  const high = marketContext.overrides.vixChoppy ?? 20;
  marketContext.volatility = vix > high ? 'high' : vix < calm ? 'low' : 'normal';
}

export function detectMarketRegime({ ema50, ema200, adx, vix, breadth } = {}) {
  if (typeof ema50 === 'number' && typeof ema200 === 'number') {
    marketContext.emaSlope = ((ema50 - ema200) / ema200) * 100;
  }
  if (typeof adx === 'number') marketContext.adx = adx;
  if (typeof vix === 'number') applyVIXThresholds(vix);
  if (typeof breadth === 'number') marketContext.breadth = breadth;

  const slope = marketContext.emaSlope;
  const trendSlope = marketContext.overrides.trendSlope ?? 0.1;
  const adxTrend = marketContext.overrides.adxTrend ?? 20;
  const adxChoppy = marketContext.overrides.adxChoppy ?? 15;
  const vixTrend = marketContext.overrides.vixCalm ?? 18;
  const vixChoppy = marketContext.overrides.vixChoppy ?? 20;
  const breadthTrend = marketContext.overrides.breadthTrend ?? 1;
  const breadthWeak = marketContext.overrides.breadthWeak ?? 0.9;

  let regime = 'sideways';
  if (
    slope > trendSlope &&
    marketContext.adx > adxTrend &&
    marketContext.vix < vixTrend &&
    marketContext.breadth >= breadthTrend
  ) {
    regime = 'trending';
  } else if (
    marketContext.adx < adxChoppy ||
    marketContext.vix > vixChoppy ||
    marketContext.breadth < breadthWeak
  ) {
    regime = 'choppy';
  }

  marketContext.history.push(regime);
  if (marketContext.history.length > 3) marketContext.history.shift();

  const counts = { trending: 0, choppy: 0, sideways: 0 };
  for (const r of marketContext.history) counts[r]++;
  const majority = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  if (majority !== marketContext.regime && counts[majority] >= 2) {
    marketContext.regime = majority;
    marketContext.lastTransition = new Date();
  }
  marketContext.lastUpdate = new Date();
  return marketContext.regime;
}

export function trackSectorBreadth(data = {}) {
  marketContext.sectorBreadth = data;
  const weak = {};
  const partThresh = marketContext.overrides.participation ?? 0.4;
  const breadthWeak = marketContext.overrides.breadthWeak ?? 0.9;
  for (const [sec, info] of Object.entries(data)) {
    const ratio = (info.advance || 0) / Math.max(info.decline || 1, 1);
    if (ratio < breadthWeak || (info.above50 || 0) < partThresh * 100) {
      weak[sec] = true;
    }
  }
  marketContext.weakSectors = weak;
  return weak;
}

export function handleEconomicEvents(events = []) {
  marketContext.economicEvents = events;
  marketContext.eventActive = events.some((e) => e.active);
}

const PRIORITY = {
  trending: 4,
  momentum: 3,
  breakout: 2,
  'mean-reversion': 1,
  scalping: 1,
};

export function resolveStrategyConflicts(signals = [], regime = marketContext.regime) {
  if (!Array.isArray(signals) || signals.length === 0) return null;
  const filtered = filterStrategiesByRegime(signals, marketContext);
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => (PRIORITY[b.category] || 0) - (PRIORITY[a.category] || 0));
  return filtered[0];
}

export function filterStrategiesByRegime(strategies = [], ctx = marketContext) {
  const reg = ctx.regime;
  return strategies.filter((s) => {
    const cat = (s.category || '').toLowerCase();
    if (reg === 'trending') {
      if (ctx.volatility === 'high') return false;
      return cat === 'trend' || cat === 'momentum' || (cat === 'breakout' && ctx.vix < 18);
    }
    if (reg === 'choppy') {
      return cat === 'mean-reversion' || cat === 'scalping';
    }
    // sideways
    if (reg === 'sideways') {
      return cat !== 'trend';
    }
    return true;
  });
}

export function backtestRegimeSelector(data = []) {
  let trades = 0;
  let wins = 0;
  const dd = { trending: [], choppy: [], sideways: [] };
  for (const d of data) {
    detectMarketRegime(d);
    const allowed = filterStrategiesByRegime(d.strategies || [], marketContext);
    const best = resolveStrategyConflicts(allowed, marketContext.regime);
    if (best) {
      trades++;
      if (best.result > 0) wins++;
      dd[marketContext.regime].push(best.result);
    }
  }
  const winRate = trades ? wins / trades : 0;
  return { winRate, trades, returnsByRegime: dd };
}

