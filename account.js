// account.js
import { getAccountMargin } from './orderExecution.js';

let accountBalance = 0;

export function getAccountBalance() {
  return accountBalance;
}

export async function initAccountBalance() {
  try {
    const margin = await getAccountMargin();
    accountBalance = margin?.equity?.available?.cash ?? 0;
  } catch (err) {
    console.error(`[ACCOUNT] Failed to fetch margin`, err?.message || err);
    accountBalance = 0;
  }
  return accountBalance;
}
