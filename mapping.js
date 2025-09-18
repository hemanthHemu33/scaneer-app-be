import { canonSymbol, canonToken } from "./canon.js";

export const tokenSymbolMap = new Map();
export const symbolTokenMap = new Map();

let loadPromise = null;

export function setMapping(token, symbol) {
  const tokenStr = canonToken(token);
  const symbolStr = canonSymbol(symbol);
  if (!tokenStr || !symbolStr) return;
  tokenSymbolMap.set(tokenStr, symbolStr);
  symbolTokenMap.set(symbolStr, tokenStr);
}

export function deleteMapping(tokenOrSymbol) {
  const tokenKey = canonToken(tokenOrSymbol);
  if (tokenSymbolMap.has(tokenKey)) {
    const sym = tokenSymbolMap.get(tokenKey);
    tokenSymbolMap.delete(tokenKey);
    if (sym) symbolTokenMap.delete(sym);
    return;
  }

  const symbolKey = canonSymbol(tokenOrSymbol);
  if (symbolTokenMap.has(symbolKey)) {
    const tok = symbolTokenMap.get(symbolKey);
    symbolTokenMap.delete(symbolKey);
    if (tok) tokenSymbolMap.delete(tok);
  }
}

export function getSymbolForToken(token) {
  return tokenSymbolMap.get(canonToken(token));
}

export function getTokenForSymbol(symbol) {
  return symbolTokenMap.get(canonSymbol(symbol));
}

export function mappingLoaded() {
  return tokenSymbolMap.size > 0;
}

export async function loadInstrumentsFromDB(db) {
  if (!db) throw new Error("loadInstrumentsFromDB requires a database handle");
  tokenSymbolMap.clear();
  symbolTokenMap.clear();
  const list = await db
    .collection("instruments")
    .find({ exchange: "NSE" })
    .project({ instrument_token: 1, tradingsymbol: 1, exchange: 1 })
    .toArray();
  for (const instrument of list) {
    const token = instrument.instrument_token;
    const symbol = `${instrument.exchange || "NSE"}:${instrument.tradingsymbol}`;
    setMapping(token, symbol);
  }
  return list.length;
}

export function ensureLoad(db) {
  if (mappingLoaded()) return Promise.resolve(tokenSymbolMap.size);
  if (!loadPromise) {
    loadPromise = loadInstrumentsFromDB(db).finally(() => {
      loadPromise = null;
    });
  }
  return loadPromise;
}
