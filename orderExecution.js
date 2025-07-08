// orderExecutor.js
import dotenv from "dotenv";
const logError = (ctx, err) => console.error(`[${ctx}]`, err?.message || err);
import { kc, symbolTokenMap, historicalCache } from "./kite.js"; // reuse shared Kite instance
import { calculateDynamicStopLoss } from "./dynamicRiskModel.js";

dotenv.config();

// kc instance and session handled in kite.js

// Place an order
export async function sendOrder(variety = "regular", order) {
  try {
    const response = await kc.placeOrder({ variety, ...order });
    console.log("✅ Order placed:", response);
    return response;
  } catch (err) {
    logError("Error placing order", err);
    return null;
  }
}

// Modify an existing order
export async function modifyOrder(orderId, order) {
  try {
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
    const holdings = await kc.getHoldings();
    return holdings;
  } catch (err) {
    logError("Error fetching holdings", err);
    return [];
  }
}

// Get margin available across equity
export async function getAccountMargin() {
  try {
    const response = await kc.getMargins("equity");
    // console the account margin details
    console.log("Account Margin:", response);
    return response;
  } catch (err) {
    logError("Error fetching account margin", err);
    return null;
  }
}

// Get margin requirement for a specific stock order
export async function getMarginForStock(order) {
  try {
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

  const entryParams = {
    exchange: "NSE",
    tradingsymbol: symbol,
    transaction_type: signal.direction === "Long" ? "BUY" : "SELL",
    quantity: qty,
    order_type: "LIMIT",
    price: signal.entry,
    product: "MIS",
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
  };
  const tgtParams = {
    exchange: "NSE",
    tradingsymbol: symbol,
    transaction_type: exitType,
    quantity: qty,
    order_type: "LIMIT",
    price: target,
    product: "MIS",
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

/**
 * Send trading signal to execution layer.
 * In live mode uses placeOrder; in tests/sim mode just logs and tracks.
 * @param {Object} signal
 * @param {Object} [opts]
 * @param {boolean} [opts.simulate]
 * @returns {Promise<Object|null>}
 */
export async function sendToExecution(signal, opts = {}) {
  const simulate = opts.simulate ?? process.env.NODE_ENV === "test";
  if (simulate) {
    const simId = `SIM-${Date.now()}`;
    openTrades.set(simId, { signal, status: "SIMULATED" });
    console.log(`[SIM] Executing signal for ${signal.stock || signal.symbol}`);
    return { entryId: simId, slId: simId, targetId: simId };
  }
  const marginCheck = await canPlaceTrade(signal);
  if (!marginCheck.canPlace) {
    console.log(
      `[MARGIN] Cannot place trade for ${signal.stock || signal.symbol}: required ${marginCheck.required}, available ${marginCheck.available}`
    );
    return null;
  }
  const sizedSignal = { ...signal, qty: marginCheck.quantity };
  const orders = await placeOrder(sizedSignal);
  if (orders) {
    openTrades.set(orders.entryId, { signal: sizedSignal, status: "OPEN", ...orders });
  }
  return orders;
}
