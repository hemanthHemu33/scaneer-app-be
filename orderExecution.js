// orderExecutor.js
import dotenv from "dotenv";
const logError = (ctx, err) => console.error(`[${ctx}]`, err?.message || err);
import {
  kc,
  symbolTokenMap,
  historicalCache,
  initSession,
  onOrderUpdate,
} from "./kite.js"; // reuse shared Kite instance and session handler
import { getAccountMargin } from "./account.js";
import { calculateDynamicStopLoss } from "./dynamicRiskModel.js";

// Store order id -> metadata mapping for traceability
export const orderMetadata = new Map();

// --- Failed signal retry queue ---
export const retryQueue = [];
const RETRY_BASE_MS = 60000; // 1 minute

export function queueFailedSignal(signal, opts = {}) {
  retryQueue.push({
    signal,
    opts,
    attempt: 0,
    nextAttempt: Date.now() + RETRY_BASE_MS,
  });
}

export function getRetryQueue() {
  return retryQueue;
}

dotenv.config();

// kc instance and session handled in kite.js

// Place an order
export async function sendOrder(variety = "regular", order, opts = {}) {
  const { retries = 3, retryDelayMs = 1000 } = opts;
  let attempt = 0;
  while (attempt < retries) {
    try {
      await initSession();

      // Extract optional metadata for traceability
      const { meta, ...orderParams } = order || {};
      if (meta) {
        const { strategy, signalId, confidence } = meta;
        const tag = [signalId, strategy, confidence]
          .filter((v) => v !== undefined && v !== null)
          .join('_');
        orderParams.tag = orderParams.tag || tag;
      }

      // If caller wants a bracket/GTT style order and provided SL/target
      // parameters, convert to a two-leg GTT order. This helps lock in
      // both risk and reward in a single request.
      if (variety === "gtt" || (orderParams.stopLoss && orderParams.target)) {
        const sl = orderParams.stopLoss ?? orderParams.sl;
        const target = orderParams.target ?? orderParams.squareoff;
        if (sl != null && target != null) {
          const exitType =
            orderParams.transaction_type === "BUY" ? "SELL" : "BUY";
          const gttParams = {
            trigger_type: kc.GTT_TYPE_OCO,
            exchange: orderParams.exchange,
            tradingsymbol: orderParams.tradingsymbol,
            last_price: orderParams.last_price ?? orderParams.price,
            trigger_values: [sl, target].sort((a, b) => a - b),
            orders: [
              {
                transaction_type: exitType,
                order_type: "SL",
                product: orderParams.product,
                quantity: orderParams.quantity,
                price: sl,
              },
              {
                transaction_type: exitType,
                order_type: "LIMIT",
                product: orderParams.product,
                quantity: orderParams.quantity,
                price: target,
              },
            ],
          };
          const response = await kc.placeGTT(gttParams);
          console.log("✅ GTT Order placed:", response);
          if (meta) {
            if (response?.order_id) orderMetadata.set(response.order_id, meta);
            if (response?.trigger_id) orderMetadata.set(response.trigger_id, meta);
          }
          return response;
        }
      }

      const response = await kc.placeOrder({ variety, ...orderParams });
      console.log("✅ Order placed:", response);
      if (meta) {
        if (response?.order_id) orderMetadata.set(response.order_id, meta);
        if (response?.trigger_id) orderMetadata.set(response.trigger_id, meta);
      }
      return response;
    } catch (err) {
      attempt += 1;
      if (attempt >= retries) {
        logError("Error placing order", err);
        return null;
      }
      await new Promise((r) => setTimeout(r, retryDelayMs * Math.pow(2, attempt - 1)));
    }
  }
}

// Modify an existing order
export async function modifyOrder(orderId, order) {
  try {
    await initSession();
    const response = await kc.modifyOrder(orderId, order);
    console.log("✏️ Order modified:", response);
    return response;
  } catch (err) {
    logError("Error modifying order", err);
    return null;
  }
}

// Cancel an existing order
export async function cancelOrder(variety, orderId) {
  try {
    await initSession();
    const response = await kc.cancelOrder(variety, orderId);
    console.log("❌ Order cancelled:", response);
    return response;
  } catch (err) {
    logError("Error canceling order", err);
    return null;
  }
}

// Fetch all orders
export async function getAllOrders() {
  try {
    await initSession();
    const orders = await kc.getOrders();
    return orders;
  } catch (err) {
    logError("Error fetching orders", err);
    return [];
  }
}

// Fetch open positions
export async function getOpenPositions() {
  try {
    await initSession();
    const positions = await kc.getPositions();
    return positions;
  } catch (err) {
    logError("Error fetching positions", err);
    return [];
  }
}

// Get holding positions
export async function getHoldings() {
  try {
    await initSession();
    const holdings = await kc.getHoldings();
    return holdings;
  } catch (err) {
    logError("Error fetching holdings", err);
    return [];
  }
}

// Get margin requirement for a specific stock order
export async function getMarginForStock(order) {
  try {
    await initSession();
    const response = await kc.orderMargins(order);

    const token = symbolTokenMap[order.tradingsymbol];
    const hist = historicalCache[token] || [];
    const avgRange =
      hist.length > 1
        ? hist.slice(-20).reduce((a, b) => a + (b.high - b.low), 0) /
          Math.min(hist.length, 20)
        : 0;

    return { ...response, avgRange };
  } catch (err) {
    logError("Error fetching margin for stock", err);
    return null;
  }
}

export async function canPlaceTrade(signal, sampleQty = 10) {
  const marginInfo = await getAccountMargin();
  const available = marginInfo?.equity?.available?.cash ?? 0;
  const order = {
    exchange: "NSE",
    tradingsymbol: signal.stock || signal.symbol,
    transaction_type: signal.direction === "Long" ? "BUY" : "SELL",
    quantity: sampleQty,
    order_type: "MARKET",
    product: "MIS",
  };
  const margin = await getMarginForStock(order);
  const info = Array.isArray(margin) ? margin[0] : margin;
  const required = info?.required ?? info?.total ?? 0;
  const perUnit = sampleQty > 0 ? required / sampleQty : 0;
  if (!perUnit || available < perUnit) {
    return { canPlace: false, quantity: 0, required: perUnit, available };
  }
  const maxQty = Math.floor(available / perUnit);
  return {
    canPlace: maxQty > 0,
    quantity: maxQty,
    required: maxQty * perUnit,
    available,
  };
}

// Place a GTT (Good Till Triggered) order
export async function placeGTTOrder(order) {
  try {
    await initSession();
    const response = await kc.placeGTT(order);
    console.log("✅ GTT Order placed:", response);
    return response;
  } catch (err) {
    logError("Error placing GTT order", err);
    return null;
  }
}

// --- High level execution helpers ---
const activeOrders = new Map();

function trackOrder(id, info) {
  if (!id) return;
  activeOrders.set(id, { ...info, timestamp: Date.now() });
}

export async function monitorOrder(orderId, timeout = 30000, interval = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await initSession();
      const orders = await kc.getOrders();
      const ord = orders.find((o) => o.order_id === orderId);
      if (!ord) {
        await new Promise((r) => setTimeout(r, interval));
        continue;
      }
      if (ord.status === "COMPLETE") return "FILLED";
      if (["REJECTED", "CANCELLED"].includes(ord.status)) return "REJECTED";
    } catch (err) {
      logError("Error monitoring order", err);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return "OPEN";
}

export async function cancelStaleOrders(maxAgeMs = 60000) {
  const now = Date.now();
  await initSession();
  const orders = await kc.getOrders();
  for (const ord of orders) {
    if (!activeOrders.has(ord.order_id)) continue;
    const info = activeOrders.get(ord.order_id);
    if (ord.status === "COMPLETE" || ord.status === "CANCELLED") {
      activeOrders.delete(ord.order_id);
      continue;
    }
    if (now - info.timestamp > maxAgeMs) {
      try {
        await kc.cancelOrder("regular", ord.order_id);
        activeOrders.delete(ord.order_id);
      } catch (err) {
        logError("Error canceling stale order", err);
      }
    }
  }
}

/**
 * Place entry order and related SL/TP for a signal.
 * Implements retry and dynamic stop-loss/target placement.
 * @param {Object} signal Trading signal
 * @param {number} [maxRetries=3]
 * @returns {Promise<Object|null>} order ids on success
 */
export async function placeOrder(signal, maxRetries = 3) {
  const symbol = signal.stock || signal.symbol;
  const qty = signal.qty || 1;
  const exitType = signal.direction === "Long" ? "SELL" : "BUY";

  const meta = {
    strategy: signal.pattern || signal.strategy,
    signalId: signal.signalId || signal.algoSignal?.signalId,
    confidence: signal.confidence ?? signal.confidenceScore,
  };

  const entryParams = {
    exchange: "NSE",
    tradingsymbol: symbol,
    transaction_type: signal.direction === "Long" ? "BUY" : "SELL",
    quantity: qty,
    order_type: "LIMIT",
    price: signal.entry,
    product: "MIS",
    meta,
  };

  const marginInfo = await getAccountMargin();
  const available = marginInfo?.equity?.available?.cash ?? 0;
  const req = await getMarginForStock(entryParams);
  const required = Array.isArray(req) ? req[0]?.total : req?.total;
  if (required && required > available) {
    console.log(
      `[MARGIN] Insufficient funds for ${symbol}: required ${required}, available ${available}`
    );
    return null;
  }

  let attempt = 0;
  let entry;
  while (attempt < maxRetries) {
    entry = await sendOrder("regular", entryParams);
    if (!entry) {
      attempt++;
      continue;
    }
    const status = await monitorOrder(entry.order_id, 20000);
    if (status === "FILLED") break;
    attempt++;
  }
  if (!entry) return null;

  trackOrder(entry.order_id, { type: "ENTRY", symbol });

  const stopLoss =
    signal.stopLoss ??
    calculateDynamicStopLoss({
      atr: signal.atr,
      entry: signal.entry,
      direction: signal.direction,
    });
  const risk = Math.abs(signal.entry - stopLoss);
  const target =
    signal.target2 ||
    signal.target ||
    (signal.direction === "Long"
      ? signal.entry + risk * 2
      : signal.entry - risk * 2);

  const slParams = {
    exchange: "NSE",
    tradingsymbol: symbol,
    transaction_type: exitType,
    quantity: qty,
    order_type: "SL",
    price: stopLoss,
    trigger_price: stopLoss,
    product: "MIS",
    meta,
  };
  const tgtParams = {
    exchange: "NSE",
    tradingsymbol: symbol,
    transaction_type: exitType,
    quantity: qty,
    order_type: "LIMIT",
    price: target,
    product: "MIS",
    meta,
  };

  const slOrder = await sendOrder("regular", slParams);
  const tgtOrder = await sendOrder("regular", tgtParams);
  if (slOrder) trackOrder(slOrder.order_id, { type: "SL", symbol });
  if (tgtOrder) trackOrder(tgtOrder.order_id, { type: "TARGET", symbol });

  return slOrder && tgtOrder && entry
    ? {
        entryId: entry.order_id,
        slId: slOrder.order_id,
        targetId: tgtOrder.order_id,
      }
    : null;
}

// --- Execution facade ---
export const openTrades = new Map();

// Update openTrades based on real-time order events
onOrderUpdate((update) => {
  for (const [id, trade] of openTrades.entries()) {
    if (id === update.order_id) {
      trade.status = update.status;
      if (update.status === "COMPLETE") openTrades.delete(id);
    } else if (trade.slId === update.order_id) {
      trade.status = "SL_FILLED";
      openTrades.delete(id);
    } else if (trade.targetId === update.order_id) {
      trade.status = "TARGET_FILLED";
      openTrades.delete(id);
    }
  }
});

/**
 * Send trading signal to execution layer.
 * In live mode uses placeOrder; in tests/sim mode just logs and tracks.
 * @param {Object} signal
 * @param {Object} [opts]
 * @param {boolean} [opts.simulate]
 * @returns {Promise<Object|null>}
 */
export async function sendToExecution(signal, opts = {}) {
  const {
    simulate = process.env.NODE_ENV === "test",
    retryOnFail = true,
  } = opts;
  if (simulate) {
    const simId = `SIM-${Date.now()}`;
    openTrades.set(simId, { signal, status: "SIMULATED" });
    console.log(`[SIM] Executing signal for ${signal.stock || signal.symbol}`);
    return { entryId: simId, slId: simId, targetId: simId };
  }
  const marginCheck = await canPlaceTrade(signal);
  if (!marginCheck.canPlace) {
    console.log(
      `[MARGIN] Cannot place trade for ${
        signal.stock || signal.symbol
      }: required ${marginCheck.required}, available ${marginCheck.available}`
    );
    if (retryOnFail) queueFailedSignal(signal, opts);
    return null;
  }
  const sizedSignal = { ...signal, qty: marginCheck.quantity };
  const orders = await placeOrder(sizedSignal);
  if (orders) {
    openTrades.set(orders.entryId, {
      signal: sizedSignal,
      status: "OPEN",
      ...orders,
    });
  }
  if (!orders && retryOnFail) queueFailedSignal(signal, opts);
  return orders;
}

export async function processRetryQueue() {
  const now = Date.now();
  for (const item of [...retryQueue]) {
    if (item.nextAttempt > now) continue;
    const result = await sendToExecution(item.signal, {
      ...item.opts,
      retryOnFail: false,
    });
    if (result) {
      retryQueue.splice(retryQueue.indexOf(item), 1);
    } else {
      item.attempt += 1;
      item.nextAttempt = now + RETRY_BASE_MS * Math.pow(2, item.attempt);
    }
  }
}

if (process.env.NODE_ENV !== "test") {
  setInterval(() => processRetryQueue().catch(() => {}), 60 * 1000);
}
