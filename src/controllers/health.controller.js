import db from "../db.js";
import {
  isMarketOpen,
  kc,
  tickBuffer,
  lastTickTs,
  getInstrumentTokenCount,
} from "../kite.js";

export const getHealth = async (req, res) => {
  const doc = await db.collection("stock_symbols").findOne({});
  const subscribedCount = Object.keys(tickBuffer).length;
  const instrumentTokenCount = getInstrumentTokenCount();
  res.json({
    session: Boolean(kc._access_token),
    marketOpen: isMarketOpen(),
    universeCount: doc?.symbols?.length || 0,
    subscribedCount,
    instrumentTokenCount,
    lastTickTs,
  });
};
