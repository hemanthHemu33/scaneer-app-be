// positionSizing.js

import {
  calculateDynamicStopLoss,
  adjustRiskBasedOnDrawdown,
  adjustRiskAfterLossStreak,
} from './dynamicRiskModel.js';
import { adjustStopLoss } from './riskValidator.js';
import { DEFAULT_MARGIN_PERCENT } from './util.js';

// Default risk to reward ratio used for target calculations
export const RISK_REWARD_RATIO = 1.5;

let tradeCount = 0;

export function estimateRequiredMarginPerLot({
  price,
  lotSize = 1,
  marginPercent,
  leverage = 0,
  exchangeMarginMultiplier = 1,
  marginBuffer = 1,
  fallbackPercent = DEFAULT_MARGIN_PERCENT,
}) {
  if (!price) return 0;
  const pct =
    typeof marginPercent === 'number'
      ? marginPercent
      : leverage > 0
      ? 1 / leverage
      : fallbackPercent;
  return (
    price *
    lotSize *
    pct *
    (exchangeMarginMultiplier || 1) *
    (marginBuffer || 1)
  );
}

// --- Position Sizing Models ---

export function fixedRupeeRiskModel({ riskAmount, slPoints }) {
  if (!riskAmount || !slPoints) return 0;
  return riskAmount / Math.max(slPoints, 1e-6);
}

export function fixedPercentRiskModel({ capital, riskPercent = 0.01, slPoints }) {
  if (!capital || !slPoints) return 0;
  return (capital * riskPercent) / Math.max(slPoints, 1e-6);
}

export function kellyCriterionSize({ capital, winRate, winLossRatio, slPoints, fraction = 1 }) {
  if (!capital || !slPoints || !winRate || !winLossRatio) return 0;
  const k = winRate - (1 - winRate) / winLossRatio;
  if (k <= 0) return 0;
  return (capital * k * fraction) / Math.max(slPoints, 1e-6);
}

export function volatilityWeightedSize({
  capital,
  baseRisk = 0.01,
  volatility,
  benchmarkVolatility,
  slPoints,
}) {
  if (!capital || !slPoints || !volatility) return 0;
  const vol = Math.max(volatility, 1e-6);
  const bench = typeof benchmarkVolatility === 'number' ? benchmarkVolatility : vol;
  const weight = bench / vol;
  return (capital * baseRisk * weight) / Math.max(slPoints, 1e-6);
}

export function equalCapitalAllocation({ capital, numPositions = 1, price }) {
  if (!capital || !price || numPositions <= 0) return 0;
  return (capital / numPositions) / price;
}

export function equalRiskAllocation({ capital, numPositions = 1, slPoints }) {
  if (!capital || !slPoints || numPositions <= 0) return 0;
  return (capital / numPositions) / Math.max(slPoints, 1e-6);
}

export function confidenceBasedSizing({ baseQty, confidence = 1, maxConfidence = 1 }) {
  if (!baseQty) return 0;
  const conf = Math.min(confidence, maxConfidence);
  return baseQty * conf;
}

export function atrBasedSizing({ capital, atr, atrMult = 1, riskPercent = 0.01 }) {
  if (!capital || !atr) return 0;
  const sl = atr * atrMult;
  return ((capital * riskPercent) / sl);
}

export function dollarVolatilitySizing({ capital, atr, price, riskPercent = 0.01 }) {
  if (!capital || !atr || !price) return 0;
  const dv = atr * price;
  return ((capital * riskPercent) / dv);
}

/**
 * Calculate tradable quantity based on risk parameters.
 * Supports optional volatility and margin considerations.
 *
 * @param {Object} opts
 * @param {number} opts.capital            Total trading capital available.
 * @param {number} [opts.risk=0.01]        Risk per trade. If <=1 treated as percentage of capital, otherwise absolute amount.
 * @param {number} opts.slPoints           Stop loss distance in points.
 * @param {number} [opts.price]            Entry price used for margin estimation.
 * @param {number} [opts.volatility]       Instrument volatility (e.g. ATR).
 * @param {number} [opts.drawdown]         Current equity drawdown (0-1).
 * @param {number} [opts.lossStreak]       Current consecutive loss count.
 * @param {number} [opts.vix]              Market volatility index.
 * @param {number} [opts.lotSize=1]        Minimum tradable lot size.
 * @param {number} [opts.utilizationCap=1] Max portion of capital to allocate when marginPerLot is provided.
 * @param {number} [opts.minLotSize]       Minimum allowable quantity for F&O instruments.
 * @param {boolean} [opts.roundToLot=true] Whether to round quantity down to nearest lot.
 * @param {number} [opts.marginPerLot]     Margin required per lot. Defaults to Zerodha intraday policy if price is supplied.
 * @param {number} [opts.marginPercent]    Broker margin percentage (if not using leverage).
 * @param {number} [opts.leverage]         Leverage multiplier available from broker.
 * @param {number} [opts.marginBuffer=1]   Safety buffer on required margin.
 * @param {number} [opts.exchangeMarginMultiplier=1] Exchange specified margin multiplier.
 * @param {number} [opts.costBuffer=1]     Buffer for taxes and slippage.
 * @param {number} [opts.slippage=0]       Expected slippage per unit.
 * @param {number} [opts.spread=0]         Spread cost per unit.
 * @param {number} [opts.volatilityGuard]  ATR/VIX threshold beyond which position size is scaled down.
 * @param {Object} [opts.marketDepth]      Current market depth { buy, sell }.
 * @param {number} [opts.priceMovement]    Recent price movement for dynamic scaling.
 * @param {string} [opts.method]           Optional sizing method ('fixed-rupee', 'fixed-percent', 'kelly',
 *                                         'volatility-weighted', 'equal-capital', 'equal-risk',
 *                                         'confidence', 'atr', 'dollar-volatility').
 * @param {Object} [opts.debug]            Optional object populated with sizing diagnostics.
 * Additional fields may be required based on the chosen method (e.g. winRate).
 */
export function calculatePositionSize({
  capital,
  risk = 0.01,
  slPoints,
  price,
  volatility,
  drawdown,
  lossStreak = 0,
  vix,
  lotSize = 1,
  utilizationCap = 1,
  minLotSize,
  roundToLot = true,
  marginPerLot,
  marginPercent,
  leverage = 0,
  marginBuffer = 1,
  exchangeMarginMultiplier = 1,
  costBuffer = 1,
  slippage = 0,
  spread = 0,
  volatilityGuard,
  marketDepth,
  priceMovement,
  minQty,
  maxQty,
  method,
  winRate,
  winLossRatio,
  fraction = 1,
  benchmarkVolatility,
  numPositions,
  confidence,
  atrMult = 1,
  debug,
}) {
  if (!capital) return 0;
  const methodName = method || 'default';
  const noSLNeeded = ['equal-capital', 'atr', 'dollar-volatility'].includes(methodName);

  const baseDistance = Number.isFinite(slPoints) ? Math.max(slPoints, 0) : 0;
  const slip = Number.isFinite(slippage) ? Math.max(slippage, 0) : 0;
  const spr = Number.isFinite(spread) ? Math.max(spread, 0) : 0;
  const buffer = Number.isFinite(costBuffer) && costBuffer > 0 ? costBuffer : 1;
  const effectiveDistance = Math.max((baseDistance + slip + spr) * buffer, 0);
  if (!noSLNeeded && effectiveDistance <= 0) return 0;

  const debugInfo = debug && typeof debug === 'object' ? debug : null;
  if (debugInfo) {
    debugInfo.rawDistance = baseDistance;
    debugInfo.slippage = slip;
    debugInfo.spread = spr;
    debugInfo.costBuffer = buffer;
    debugInfo.effectiveDistance = effectiveDistance;
  }

  tradeCount += 1;

  const sl = noSLNeeded
    ? Math.max((slPoints || 0) * buffer, 1e-6)
    : Math.max(effectiveDistance, 1e-6);

  // Determine base quantity using selected model
  let qty;
  switch (methodName) {
    case 'fixed-rupee':
      qty = fixedRupeeRiskModel({ riskAmount: risk, slPoints: sl });
      break;
    case 'fixed-percent':
      qty = fixedPercentRiskModel({ capital, riskPercent: risk, slPoints: sl });
      break;
    case 'kelly':
      qty = kellyCriterionSize({
        capital,
        winRate,
        winLossRatio,
        slPoints: sl,
        fraction,
      });
      break;
    case 'volatility-weighted':
      qty = volatilityWeightedSize({
        capital,
        baseRisk: risk,
        volatility,
        benchmarkVolatility,
        slPoints: sl,
      });
      break;
    case 'equal-capital':
      qty = equalCapitalAllocation({ capital, numPositions, price });
      break;
    case 'equal-risk':
      qty = equalRiskAllocation({ capital, numPositions, slPoints: sl });
      break;
    case 'confidence': {
      const baseQty = fixedPercentRiskModel({
        capital,
        riskPercent: risk,
        slPoints: sl,
      });
      qty = confidenceBasedSizing({ baseQty, confidence });
      break;
    }
    case 'atr':
      qty = atrBasedSizing({ capital, atr: volatility, atrMult, riskPercent: risk });
      break;
    case 'dollar-volatility':
      qty = dollarVolatilitySizing({ capital, atr: volatility, price, riskPercent: risk });
      break;
    default: {
      const riskAmount = risk <= 1 ? capital * risk : risk;
      if (riskAmount <= 0) return 0;
      qty = riskAmount / sl;
    }
  }

  if (!qty || qty <= 0) return 0;

  if (debugInfo) {
    debugInfo.requestedQty = qty;
  }

  if (volatility && volatilityGuard && volatility > volatilityGuard) {
    const factor = volatility / volatilityGuard;
    qty /= factor;
  }

  if (volatilityGuard && vix && volatility) {
    const combined = volatility * vix;
    if (combined > volatilityGuard) {
      const factor = combined / volatilityGuard;
      qty /= factor;
    }
  }

  if (priceMovement && volatility && Math.abs(priceMovement) > volatility) {
    qty *= 0.9;
  }

  if (marketDepth && marketDepth.buy && marketDepth.sell) {
    const ratio = marketDepth.buy / (marketDepth.sell || 1);
    if (ratio < 0.7) qty *= 0.9;
    else if (ratio > 1.5) qty *= 1.1;
  }

  if (debugInfo) {
    debugInfo.modelAdjustedQty = qty;
  }

  qty = Math.floor(Number.isFinite(qty) ? qty : 0);

  if (debugInfo) {
    debugInfo.roundedQty = qty;
  }

  if (roundToLot && lotSize > 1) {
    const beforeLotRound = qty;
    qty = Math.floor(qty / lotSize) * lotSize;
    if (debugInfo) {
      debugInfo.roundToLot = {
        before: beforeLotRound,
        after: qty,
        lotSize,
      };
    }
  }

  const effectiveMarginPerLot =
    (typeof marginPerLot === 'number' && marginPerLot > 0
      ? marginPerLot * (exchangeMarginMultiplier || 1) * (marginBuffer || 1)
      : estimateRequiredMarginPerLot({
          price,
          lotSize,
          marginPercent,
          leverage,
          exchangeMarginMultiplier,
          marginBuffer,
        }));
  if (effectiveMarginPerLot > 0) {
    const cap = Number.isFinite(utilizationCap) ? utilizationCap : 1;
    const maxLots = Math.floor(((capital || 0) * cap) / effectiveMarginPerLot);
    const capQty = maxLots * lotSize;
    if (debugInfo) {
      debugInfo.marginCap = {
        maxLots,
        capQty,
      };
    }
    const beforeCapQty = qty;
    qty = Math.max(0, Math.min(qty, capQty));
    if (debugInfo) {
      debugInfo.marginCapped = capQty > 0 && qty < beforeCapQty;
      debugInfo.qtyAfterMargin = qty;
    }
  }

  if (typeof drawdown === 'number') {
    qty = adjustRiskBasedOnDrawdown({ drawdown, lotSize: qty });
  }
  if (typeof lossStreak === 'number') {
    qty = adjustRiskAfterLossStreak({ lossStreak, lotSize: qty });
  }

  if (typeof minQty === 'number' && qty < minQty) {
    if (debugInfo) {
      debugInfo.rejectedByMinQty = true;
      debugInfo.finalQty = 0;
    }
    return 0;
  }
  if (typeof minLotSize === 'number' && qty < minLotSize) {
    if (debugInfo) {
      debugInfo.rejectedByMinLot = true;
      debugInfo.finalQty = 0;
    }
    return 0;
  }
  if (typeof maxQty === 'number' && qty > maxQty) {
    if (debugInfo) {
      debugInfo.cappedByMaxQty = maxQty;
    }
    qty = maxQty;
  }

  if (debugInfo) {
    debugInfo.finalQty = qty;
  }

  return qty > 0 ? qty : 0;
}

/**
 * Calculate trade parameters including stop loss, quantity and targets.
 * Handles dynamic and fallback stop losses, RR based target calculation
 * and drawdown based quantity adjustment.
 *
 * @param {Object} opts
 * @param {number} opts.entry       Trade entry price
 * @param {number} [opts.stopLoss]  Pattern provided stop loss
 * @param {'Long'|'Short'} opts.direction Trade direction
 * @param {number} opts.atr         Current ATR value
 * @param {number} opts.capital     Trading capital
 * @param {number} [opts.leverage]  Leverage multiplier
 * @param {number} [opts.marginPercent] Broker margin percentage
 * @param {number} [opts.drawdown]  Current drawdown percentage (0-1)
 * @param {number} [opts.slippage]  Expected slippage per unit
 * @param {number} [opts.spread]    Current bid/ask spread
 * @param {number} [opts.costBuffer] Buffer for taxes and slippage
 * @param {number} [opts.riskPercent=0.01] Risk per trade as a fraction of capital
 * @returns {Object} { stopLoss, qty, target1, target2 }
 */
export function calculateTradeParameters({
  entry,
  stopLoss,
  direction,
  atr,
  capital,
  leverage = 0,
  marginPercent,
  drawdown = 0,
  slippage = 0,
  spread = 0,
  costBuffer = 1,
  riskPercent = 0.01,
}) {
  const dynamicSL = calculateDynamicStopLoss({ atr, entry, direction });

  let finalSL = dynamicSL;

  if (typeof stopLoss === 'number') {
    const patternSL = stopLoss;
    const distDyn = Math.abs(entry - dynamicSL);
    const distPat = Math.abs(entry - patternSL);
    finalSL =
      direction === 'Long'
        ? Math.max(finalSL, patternSL)
        : Math.min(finalSL, patternSL);
    if (distPat < distDyn) finalSL = patternSL;
  }

  if (
    (direction === 'Long' && finalSL >= entry) ||
    (direction === 'Short' && finalSL <= entry)
  ) {
    finalSL = dynamicSL;
  }

  finalSL = adjustStopLoss({
    price: entry,
    stopLoss: finalSL,
    direction,
    atr,
  });

  const rawRisk = Math.abs(entry - finalSL);
  const effectiveRisk = rawRisk + slippage + spread;
  const riskAmount = capital * riskPercent;
  let qty = calculatePositionSize({
    capital,
    risk: riskAmount,
    slPoints: rawRisk,
    price: entry,
    volatility: atr,
    drawdown,
    lossStreak: 0,
    lotSize: 1,
    utilizationCap: 1,
    leverage,
    marginPercent,
    costBuffer,
    slippage,
    spread,
  });

  // drawdown/loss-streak throttling already applied inside calculatePositionSize

  const atrPct = entry ? (atr / entry) * 100 : 0;
  const rrMultiplier = atrPct > 2 ? RISK_REWARD_RATIO + 0.5 : RISK_REWARD_RATIO;
  const target1 =
    entry + (direction === 'Long' ? 1 : -1) * (rrMultiplier * 0.5) * effectiveRisk;
  const target2 =
    entry + (direction === 'Long' ? 1 : -1) * rrMultiplier * effectiveRisk;

  return { stopLoss: finalSL, qty, target1, target2 };
}



