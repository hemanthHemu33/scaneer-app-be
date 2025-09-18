import db from "../db.js";
import { setStockSymbol, removeStockSymbol } from "../kite.js";
import { logError } from "../logger.js";

export const addStockSymbol = async (req, res) => {
  const { symbol } = req.body;
  if (!symbol || typeof symbol !== "string") {
    return res.status(400).json({ error: "Invalid symbol" });
  }
  try {
    await setStockSymbol(`NSE:${symbol}`);
    const updated = await db.collection("stock_symbols").findOne({});
    res.json({ status: "success", symbols: updated?.symbols || [] });
  } catch (err) {
    logError("update symbols", err);
    res.status(500).json({ error: "Failed to update symbols" });
  }
};

export const getStockSymbols = async (req, res) => {
  try {
    const stockSymbols = await db.collection("stock_symbols").findOne({});
    res.json(stockSymbols || { symbols: [] });
  } catch (err) {
    logError("fetching stock symbols", err);
    res.status(500).json({ error: "Failed to fetch stock symbols" });
  }
};

export const deleteStockSymbol = async (req, res) => {
  const { symbol } = req.params;
  if (!symbol || typeof symbol !== "string") {
    return res.status(400).json({ error: "Invalid stock symbol" });
  }
  try {
    await removeStockSymbol(symbol);
    res.json({
      status: "success",
      deletedSymbol: symbol.includes(":") ? symbol : `NSE:${symbol}`,
    });
  } catch (err) {
    logError("delete stock symbol", err);
    res.status(500).json({ error: "Failed to delete stock symbol" });
  }
};
