const DEFAULT_EXCHANGE = "NSE";
const EXCHANGE_PREFIX_REGEX = /^(NSE|BSE|MCX|NFO|CDS)/;

export function canonToken(token) {
  if (token === null || token === undefined) return "";
  if (typeof token === "object" && token.instrument_token !== undefined) {
    return String(token.instrument_token);
  }
  return String(token);
}

export function canonSymbol(value) {
  if (value === null || value === undefined) return "";
  let raw = String(value).trim();
  if (!raw) return "";
  raw = raw.toUpperCase();

  if (raw.includes(":")) {
    const [exchangePart, ...symbolParts] = raw.split(":");
    const exchange = exchangePart || DEFAULT_EXCHANGE;
    const symbol = symbolParts.join(":") || "";
    return `${exchange}:${symbol}`;
  }

  const match = raw.match(EXCHANGE_PREFIX_REGEX);
  if (match) {
    const exchange = match[0];
    const symbol = raw.slice(exchange.length);
    if (symbol.startsWith(":")) {
      return `${exchange}:${symbol.slice(1)}`;
    }
    return `${exchange}:${symbol}`;
  }

  return `${DEFAULT_EXCHANGE}:${raw}`;
}
