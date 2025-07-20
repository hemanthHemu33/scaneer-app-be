import { kc, initSession, tickBuffer, candleHistory, symbolTokenMap } from './kite.js';
import db from './db.js';
import { logError } from './logger.js';

export function getLiveTicks(token) {
  return tickBuffer[token] || [];
}

export function getCandleHistory(token, interval = 'minute', count = 60) {
  const history = candleHistory[token] || [];
  return history.slice(-count);
}

export async function getLTP(symbol) {
  await initSession();
  const data = await kc.getLTP([symbol]);
  return data?.[symbol]?.last_price;
}

export async function getInstrumentToken(symbol) {
  if (symbolTokenMap[symbol]) {
    return symbolTokenMap[symbol];
  }
  await initSession();
  const data = await kc.getLTP([symbol]);
  const token = data?.[symbol]?.instrument_token;
  if (token) {
    symbolTokenMap[symbol] = token;
  }
  return token;
}

export async function getFundamentals(symbol) {
  try {
    return await db.collection('fundamentals').findOne({ symbol });
  } catch (err) {
    logError('Fundamental fetch error', err);
    return null;
  }
}

export async function getNews(symbol) {
  try {
    return await db.collection('news').find({ symbol }).toArray();
  } catch (err) {
    logError('News fetch error', err);
    return [];
  }
}

export { candleHistory, symbolTokenMap, tickBuffer };
