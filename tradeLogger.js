import db from './db.js';

export async function logTrade(trade) {
  if (!db?.collection) return;
  const col = db.collection('trade_logs');
  await col.insertOne({ ...trade, timestamp: new Date() });
}

export async function recordPnL(symbol, pnl) {
  await logTrade({ symbol, pnl });
}

export async function logOrderUpdate(update) {
  if (!db?.collection) return;
  const col = db.collection('order_updates');
  await col.insertOne({ ...update, timestamp: new Date() });
}
