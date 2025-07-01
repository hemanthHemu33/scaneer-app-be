// tradeLifecycle.js
import { placeOrder, cancelOrder, getAllOrders } from './orderExecution.js';
import { validatePreExecution } from './riskValidator.js';
import { calculatePositionSize } from './positionSizing.js';
import { updateSignalOrders } from './signalManager.js';
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
  if (!validatePreExecution(signal, opts.market || {})) return null;
  const signalId = signal.signalId || signal.algoSignal?.signalId;
  if (signalId) updateSignalOrders(symbol, signalId, { state: 'entryPending' });
  const tradeValue = signal.entry * (signal.qty || 1);
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
  if (!allowed) {
    if (signalId) updateSignalOrders(symbol, signalId, { state: 'blocked' });
    return null;
  }
  const qty =
    signal.qty ||
    calculatePositionSize({
      capital: opts.capital || opts.totalCapital || 0,
      risk: opts.risk || 0.01,
      slPoints: Math.abs(signal.entry - signal.stopLoss),
      price: signal.entry,
    });
  if (qty <= 0) {
    if (signalId) updateSignalOrders(symbol, signalId, { state: 'blocked' });
    return null;
  }

  const entryOrder = await placeOrder('regular', {
    exchange: 'NSE',
    tradingsymbol: symbol,
    transaction_type: signal.direction === 'Long' ? 'BUY' : 'SELL',
    quantity: qty,
    order_type: 'LIMIT',
    price: signal.entry,
    product: 'MIS',
  });
  if (!entryOrder) {
    if (signalId) updateSignalOrders(symbol, signalId, { state: 'entryFailed' });
    return null;
  }
  if (signalId)
    updateSignalOrders(symbol, signalId, {
      entryId: entryOrder.order_id,
      state: 'entryPlaced',
    });
  const filled = await waitForOrderFill(entryOrder.order_id);
  if (!filled) {
    if (signalId) updateSignalOrders(symbol, signalId, { state: 'entryCancelled' });
    return null;
  }
  if (signalId) updateSignalOrders(symbol, signalId, { state: 'inTrade' });

  const exitType = signal.direction === 'Long' ? 'SELL' : 'BUY';
  const slOrder = await placeOrder('regular', {
    exchange: 'NSE',
    tradingsymbol: symbol,
    transaction_type: exitType,
    quantity: qty,
    order_type: 'SL',
    price: signal.stopLoss,
    trigger_price: signal.stopLoss,
    product: 'MIS',
  });
  const targetOrder = await placeOrder('regular', {
    exchange: 'NSE',
    tradingsymbol: symbol,
    transaction_type: exitType,
    quantity: qty,
    order_type: 'LIMIT',
    price: signal.target2 || signal.target,
    product: 'MIS',
  });
  if (!slOrder || !targetOrder) {
    if (signalId) updateSignalOrders(symbol, signalId, { state: 'bracketFailed' });
    return null;
  }
  if (signalId)
    updateSignalOrders(symbol, signalId, {
      slId: slOrder.order_id,
      targetId: targetOrder.order_id,
    });
  const result = await monitorBracketOrders(slOrder.order_id, targetOrder.order_id);
  if (signalId)
    updateSignalOrders(symbol, signalId, {
      state: result === 'TARGET' ? 'targetHit' : 'slHit',
    });
  return {
    entryId: entryOrder.order_id,
    slId: slOrder.order_id,
    targetId: targetOrder.order_id,
    result,
  };
}

