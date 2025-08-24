// account.js
// Provides utilities for fetching and caching account related data
import { kc, initSession } from "./kite.js";

let accountBalance = 0;

// Fetch margin available across equity using the shared Kite instance
export async function getAccountMargin() {
  try {
    await initSession();
    const response = await kc.getMargins("equity");
    return response;
  } catch (err) {
    console.error(`[ACCOUNT] Error fetching account margin`, err?.message || err);
    return null;
  }
}

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
