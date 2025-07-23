import db from './db.js';

export async function logTrade(trade, exitReason = undefined, exitPrice = undefined) {
  if (!db?.collection) return;
  const col = db.collection('trade_logs');
  const logEntry = { ...trade, timestamp: new Date() };
  if (exitReason) logEntry.exitReason = exitReason;
  if (typeof exitPrice === 'number') logEntry.exitPrice = exitPrice;
  await col.insertOne(logEntry);
}

export async function recordPnL(symbol, pnl) {
  await logTrade({ symbol, pnl });
}

export async function logOrderUpdate(update) {
  if (!db?.collection) return;
  const col = db.collection('order_updates');
  await col.insertOne({ ...update, timestamp: new Date() });
}
