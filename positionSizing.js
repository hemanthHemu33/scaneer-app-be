// positionSizing.js

// Zerodha intraday margin (approx. 20% of trade value)
const ZERODHA_INTRADAY_MARGIN = 0.2;

// Default risk to reward ratio used for target calculations
export const RISK_REWARD_RATIO = 1.5;

let tradeCount = 0;

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
 * @param {number} [opts.vix]              Market volatility index.
 * @param {number} [opts.lotSize=1]        Minimum tradable lot size.
 * @param {number} [opts.utilizationCap=1] Max portion of capital to allocate when marginPerLot is provided.
 * @param {number} [opts.marginPerLot]     Margin required per lot. Defaults to Zerodha intraday policy if price is supplied.
 * @param {number} [opts.volatilityGuard]  ATR/VIX threshold beyond which position size is scaled down.
 * @param {Object} [opts.marketDepth]      Current market depth { buy, sell }.
 * @param {number} [opts.priceMovement]    Recent price movement for dynamic scaling.
 */
export function calculatePositionSize({
  capital,
  risk = 0.01,
  slPoints,
  price,
  volatility,
  vix,
  lotSize = 1,
  utilizationCap = 1,
  marginPerLot,
  volatilityGuard,
  marketDepth,
  priceMovement,
}) {
  if (!capital || !slPoints || slPoints <= 0) return 0;

  tradeCount += 1;
  if (tradeCount === 1) {
    utilizationCap = 1;
  }

  // Determine risk amount
  const riskAmount = risk <= 1 ? capital * risk : risk;
  if (riskAmount <= 0) return 0;

  let qty = riskAmount / slPoints;

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

  qty = Math.floor(qty);

  if (lotSize > 1) qty = Math.floor(qty / lotSize) * lotSize;

  const effectiveMarginPerLot =
    marginPerLot || (price ? price * lotSize * ZERODHA_INTRADAY_MARGIN : 0);
  if (effectiveMarginPerLot > 0) {
    const maxLots = Math.floor((capital * utilizationCap) / effectiveMarginPerLot);
    qty = Math.min(qty, maxLots * lotSize);
  }

  return qty > 0 ? qty : lotSize;
}


