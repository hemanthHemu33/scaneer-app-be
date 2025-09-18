import db from "../db.js";
import { resetInMemoryData } from "../kite.js";
import { logError } from "../logger.js";

export const resetAllCollections = async (req, res) => {
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

    await resetInMemoryData();
    res.json({ status: "success", message: "Collections reset successfully" });
  } catch (err) {
    logError("reset collections", err);
    res.status(500).json({ error: "Failed to reset collections" });
  }
};
