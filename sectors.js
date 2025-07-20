export const sectorMap = {
  AAA: 'IT',
  BBB: 'FIN',
  CCC: 'CONS',
};

export function getSector(symbol = '') {
  return sectorMap[symbol] || 'GEN';
}
