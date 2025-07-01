// orderExecutor.js
import { KiteConnect } from "kiteconnect";
import dotenv from "dotenv";
import { logError } from "./kite.js"; // or move logError to a common logger.js
import { symbolTokenMap, historicalCache } from "./kite.js"; // to access token mapping and cache

dotenv.config();

const apiKey = process.env.KITE_API_KEY;
const kc = new KiteConnect({ api_key: apiKey });

// Ensure access token is loaded
export function setAccessToken(token) {
  kc.setAccessToken(token);
}

// Place an order
export async function placeOrder(variety = "regular", order) {
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
