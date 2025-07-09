// account.js
import { getAccountMargin } from "./orderExecution.js";

let accountBalance = 0;

export function getAccountBalance() {
  return accountBalance;
}

export async function initAccountBalance() {
  try {
    const margin = await getAccountMargin();
    // console.log("Account Margin:", margin);
    // accountBalance = margin?.equity?.available?.cash ?? 0;
    accountBalance = margin?.net;
     console.log(`[ACCOUNT] Account balance initialized: ${accountBalance}`);
  } catch (err) {
    console.error(`[ACCOUNT] Failed to fetch margin`, err?.message || err);
    accountBalance = 0;
  }
  return accountBalance;
}
