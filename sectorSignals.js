export const sectorSignalHistory = {};

export function recordSectorSignal(sector, direction, timestamp = Date.now()) {
  if (!sector) return;
  if (!sectorSignalHistory[sector]) sectorSignalHistory[sector] = [];
  sectorSignalHistory[sector].push({ direction, timestamp });
  sectorSignalHistory[sector] = sectorSignalHistory[sector].filter(
    (s) => timestamp - s.timestamp < 5 * 60 * 1000
  );
}

export function countSectorSignals(sector, direction, windowMs = 5 * 60 * 1000) {
  const now = Date.now();
  return (sectorSignalHistory[sector] || []).filter(
    (s) => now - s.timestamp < windowMs && s.direction === direction
  ).length;
}
