// tradeLifecycle.js
import { sendOrder, cancelOrder, getAllOrders } from './orderExecution.js';
import { isSignalValid } from './riskEngine.js';
import { calculatePositionSize } from './positionSizing.js';
import {
  checkExposureLimits,
  preventReEntry,
  resolveSignalConflicts,
} from './portfolioContext.js';

/**
 * Wait for an order to be filled by polling getAllOrders()
 * @param {string} orderId
 * @param {number} [timeout=30000]
 * @param {number} [interval=1000]
 * @returns {Promise<boolean>} fill status
 */
export async function waitForOrderFill(orderId, timeout = 30000, interval = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const orders = await getAllOrders();
    const ord = orders.find((o) => o.order_id === orderId);
    if (ord && ord.status === 'COMPLETE') return true;
    if (ord && ['CANCELLED', 'REJECTED'].includes(ord.status)) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

/**
 * Monitor SL and target orders. Cancels the opposite when one is filled.
 * @param {string} slId
 * @param {string} targetId
 * @param {number} [interval=1000]
 * @returns {Promise<'TARGET'|'SL'>}
 */
export async function monitorBracketOrders(slId, targetId, interval = 1000) {
  while (true) {
    const orders = await getAllOrders();
    const sl = orders.find((o) => o.order_id === slId);
    const tgt = orders.find((o) => o.order_id === targetId);
    if (tgt && tgt.status === 'COMPLETE') {
      if (sl) await cancelOrder('regular', slId);
      return 'TARGET';
    }
    if (sl && sl.status === 'COMPLETE') {
      if (tgt) await cancelOrder('regular', targetId);
      return 'SL';
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Execute a trading signal with risk and exposure checks.
 * Places entry order, waits for fill, then places SL and target orders.
 * @param {Object} signal
 * @param {Object} opts
 * @param {number} [opts.capital]
 * @param {number} [opts.risk]
 * @param {number} [opts.totalCapital]
 * @returns {Promise<Object|null>} order ids or null when blocked
 */
export async function executeSignal(signal, opts = {}) {
  const symbol = signal.stock || signal.symbol;
  const qty =
    signal.qty ||
    calculatePositionSize({
      capital: opts.capital || opts.totalCapital || 0,
      risk: opts.risk || 0.01,
      slPoints: Math.abs(signal.entry - signal.stopLoss),
      price: signal.entry,
      minQty: opts.minQty,
      maxQty: opts.maxQty,
    });
  if (qty <= 0) return null;
  const tradeValue = signal.entry * qty;
  if (
    !isSignalValid(signal, {
      ...(opts.market || {}),
      tradeValue,
      openPositionsCount: opts.openPositionsCount,
    })
  )
    return null;
  const allowed =
    checkExposureLimits({
      symbol,
      tradeValue,
      sector: signal.sector || 'GEN',
      totalCapital: opts.totalCapital || opts.capital || 0,
    }) &&
    preventReEntry(symbol) &&
    resolveSignalConflicts({
      symbol,
      side: signal.direction === 'Long' ? 'long' : 'short',
      strategy: signal.pattern,
    });
  if (!allowed) return null;

  const entryOrder = await sendOrder('regular', {
    exchange: 'NSE',
    tradingsymbol: symbol,
    transaction_type: signal.direction === 'Long' ? 'BUY' : 'SELL',
    quantity: qty,
    order_type: 'LIMIT',
    price: signal.entry,
    product: 'MIS',
  });
  if (!entryOrder) return null;
  const filled = await waitForOrderFill(entryOrder.order_id);
  if (!filled) return null;

  const exitType = signal.direction === 'Long' ? 'SELL' : 'BUY';
  const slOrder = await sendOrder('regular', {
    exchange: 'NSE',
    tradingsymbol: symbol,
    transaction_type: exitType,
    quantity: qty,
    order_type: 'SL',
    price: signal.stopLoss,
    trigger_price: signal.stopLoss,
    product: 'MIS',
  });
  const targetOrder = await sendOrder('regular', {
    exchange: 'NSE',
    tradingsymbol: symbol,
    transaction_type: exitType,
    quantity: qty,
    order_type: 'LIMIT',
    price: signal.target2 || signal.target,
    product: 'MIS',
  });
  if (!slOrder || !targetOrder) return null;
  await monitorBracketOrders(slOrder.order_id, targetOrder.order_id);
  return {
    entryId: entryOrder.order_id,
    slId: slOrder.order_id,
    targetId: targetOrder.order_id,
  };
}

