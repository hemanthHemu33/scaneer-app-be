import db from "./db.js";
import { canonSymbol, canonToken } from "./canon.js";
import { setMapping, tokenSymbolMap, symbolTokenMap } from "./mapping.js";

function buildInstrumentQuery(symOrToken) {
  const clauses = [];
  const token = Number(symOrToken);
  if (!Number.isNaN(token)) {
    clauses.push({ instrument_token: token });
  }
  const symbolKey = canonSymbol(symOrToken).split(":")[1];
  if (symbolKey) {
    clauses.push({ tradingsymbol: symbolKey });
  }
  return {
    exchange: "NSE",
    $or: clauses.length ? clauses : [{ tradingsymbol: symbolKey }],
  };
}

export async function resolveInstrument(symOrToken, database = db) {
  const tokenKey = canonToken(symOrToken);
  let symbol = tokenSymbolMap.get(tokenKey);
  if (!symbol) {
    const symbolKey = canonSymbol(symOrToken);
    const tokenFromSymbol = symbolTokenMap.get(symbolKey);
    if (tokenFromSymbol) {
      symbol = symbolKey;
      setMapping(tokenFromSymbol, symbolKey);
      return { token: canonToken(tokenFromSymbol), symbol: symbolKey };
    }
  } else {
    return { token: tokenKey, symbol };
  }

  const query = buildInstrumentQuery(symOrToken);
  const doc = await database.collection("instruments").findOne(query);
  if (!doc) {
    return { token: tokenKey || null, symbol: null };
  }

  const resolvedToken = canonToken(doc.instrument_token);
  const resolvedSymbol = canonSymbol(`${doc.exchange || "NSE"}:${doc.tradingsymbol}`);
  setMapping(resolvedToken, resolvedSymbol);
  return { token: resolvedToken, symbol: resolvedSymbol, instrument: doc };
}

export async function fallbackFetch(symOrToken, fetchFn, database = db) {
  const { token, symbol } = await resolveInstrument(symOrToken, database);
  if (!symbol) {
    const err = new Error("MAPPING_STILL_MISSING");
    err.code = "MAPPING_STILL_MISSING";
    throw err;
  }
  if (typeof fetchFn === "function") {
    return fetchFn({ token, symbol });
  }
  return { token, symbol };
}
