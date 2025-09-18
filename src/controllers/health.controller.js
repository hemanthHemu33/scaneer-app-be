import db from "../db.js";
import { isMarketOpen, kc, tickBuffer, lastTickTs } from "../kite.js";

export const getHealth = async (req, res) => {
  const doc = await db.collection("stock_symbols").findOne({});
  res.json({
    session: Boolean(kc._access_token),
    marketOpen: isMarketOpen(),
    universeCount: doc?.symbols?.length || 0,
    subscribedCount: Object.keys(tickBuffer).length,
    lastTickTs,
  });
};
