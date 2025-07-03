export function rankSignals(signals = []) {
  if (!Array.isArray(signals) || signals.length === 0) return [];
  return [...signals].sort((a, b) => {
    const ca = a.confidenceScore || a.confidence || 0;
    const cb = b.confidenceScore || b.confidence || 0;
    const ba = a.backtestScore || 0;
    const bb = b.backtestScore || 0;
    return cb + bb - (ca + ba);
  });
}

export function selectTopSignal(signals = []) {
  const ranked = rankSignals(signals);
  return ranked[0] || null;
}
