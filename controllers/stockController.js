import { setStockSymbol, removeStockSymbol, resetInMemoryData } from "../kite.js";
import db from "../db.js";
import { logError } from "../logger.js";

export async function addStockSymbol(req, res) {
  const { symbol } = req.body;
  if (!symbol || typeof symbol !== "string") {
    return res.status(400).json({ error: "Invalid symbol" });
  }
  try {
    await setStockSymbol(`NSE:${symbol}`);
    const doc = await db.collection("stock_symbols").findOne({});
    res.json({ status: "success", symbols: doc?.symbols || [] });
  } catch (err) {
    logError("update symbols", err);
    res.status(500).json({ error: "Failed to update symbols" });
  }
}

export async function getStockSymbols(req, res) {
  try {
    const stockSymbols = await db.collection("stock_symbols").findOne({});
    res.json(stockSymbols || { symbols: [] });
  } catch (err) {
    logError("fetching stock symbols", err);
    res.status(500).json({ error: "Failed to fetch stock symbols" });
  }
}

export async function deleteStockSymbol(req, res) {
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
}

export async function resetCollections(req, res) {
  try {
    const collections = await db.collections();
    for (const collection of collections) {
      if (
        collection.collectionName !== "instruments" &&
        collection.collectionName !== "nifty50stocksymbols" &&
        collection.collectionName !== "nifty100qualitystocksymbols"
      ) {
        await collection.deleteMany({});
      }
    }
    await db.collection("stock_symbols").deleteMany({});
    await db.collection("stock_symbols").insertOne({ symbols: [] });
    resetInMemoryData();
    res.json({ status: "success", message: "Collections reset successfully" });
  } catch (err) {
    logError("reset collections", err);
    res.status(500).json({ error: "Failed to reset collections" });
  }
}
