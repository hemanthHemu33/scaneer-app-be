import db from './db.js';
import cron from 'node-cron';
import { logError } from './logger.js';

/**
 * Compare executed_signals and trade_logs for a given date.
 * Returns lists of missing and unexpected trades.
 * @param {Date} [date]
 */
export async function reconcileOrders(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);

  try {
    const [executed, trades] = await Promise.all([
      db
        .collection('executed_signals')
        .find({ timestamp: { $gte: start, $lt: end } })
        .toArray(),
      db
        .collection('trade_logs')
        .find({ timestamp: { $gte: start, $lt: end } })
        .toArray(),
    ]);

    const executedIds = new Set(
      executed.map((e) => e.signalId).filter(Boolean)
    );
    const tradeIds = new Set(trades.map((t) => t.signalId).filter(Boolean));

    const missing = [...executedIds].filter((id) => !tradeIds.has(id));
    const unexpected = [...tradeIds].filter((id) => !executedIds.has(id));

    return { missing, unexpected, executedCount: executed.length, tradeCount: trades.length };
  } catch (err) {
    logError('dailyAudit', err);
    return { missing: [], unexpected: [], executedCount: 0, tradeCount: 0 };
  }
}

export function startAuditSchedule() {
  if (process.env.NODE_ENV === 'test') return;
  cron.schedule(
    '10 16 * * 1-5',
    async () => {
      const res = await reconcileOrders();
      console.log('[AUDIT] Executed:', res.executedCount, 'Trades:', res.tradeCount);
      if (res.missing.length)
        console.log('[AUDIT] Missing trades for signals:', res.missing.join(', '));
      if (res.unexpected.length)
        console.log(
          '[AUDIT] Unexpected trades with no executed signal:',
          res.unexpected.join(', ')
        );
      if (!res.missing.length && !res.unexpected.length)
        console.log('[AUDIT] \u2705 All trades reconciled.');
    },
    { timezone: 'Asia/Kolkata' }
  );
}

startAuditSchedule();
