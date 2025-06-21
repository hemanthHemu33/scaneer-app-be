// openAI.js

import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Get signal explanation in human-readable format
 */
export async function getSignalExplanation(signal) {
  //   const prompt = `Explain this trading signal in simple and very short :
  // Stock: ${signal.stock}
  // Pattern: ${signal.pattern}
  // Direction: ${signal.direction}
  // Confidence: ${signal.confidence}
  // Indicators: EMA9=${signal.ema9}, EMA21=${signal.ema21}, RSI=${signal.rsi}, ATR=${signal.atr}
  // Volume: ${signal.liquidity}
  // Why is this a good trade setup?`;
  //   const response = await openai.chat.completions.create({
  //     model: "gpt-4-turbo",
  //     messages: [{ role: "user", content: prompt }],
  //   });
  //   return response.choices[0].message.content.trim();
}

/**
 * Let GPT rate the confidence based on context
 */
export async function getConfidenceScore(signal) {
  //   const prompt = `Given this trade setup in very short and simple words:
  // Pattern: ${signal.pattern}
  // Indicators: EMA9=${signal.ema9}, EMA21=${signal.ema21}, RSI=${signal.rsi}, Supertrend=${signal.supertrend.signal}
  // Trend direction: ${signal.direction}
  // Rate signal confidence as High, Medium or Low and why.`;
  //   const response = await openai.chat.completions.create({
  //     model: "gpt-4-turbo",
  //     messages: [{ role: "user", content: prompt }],
  //   });
  //   return response.choices[0].message.content.trim();
}

/**
 * Use GPT to validate and filter weak or risky signals
 */
export async function getFilteredAdvice(signal) {
  const prompt = `Evaluate the trade quality based on this data in simple and very short words my R:R is 1:2 and 1:2.5 per trade:
  Signal: ${signal.pattern} ${signal.direction}
  Spread: ${signal.spread}, Liquidity: ${signal.liquidity}, ATR: ${signal.atr}
  Depth: BuyQty=${signal.liveTickData?.total_buy_quantity}, SellQty=${signal.liveTickData?.total_sell_quantity}
  Give a short advice whether this should be traded or avoided.`;
  const response = await openai.chat.completions.create({
    model: "gpt-4-turbo",
    messages: [{ role: "user", content: prompt }],
  });
  return response.choices[0].message.content.trim();
}

/**
 * Generate full trade plan summary
 */
export async function generateTradePlan(signal) {
  //   const prompt = `Given a small ₹20,000 capital and strict 1:2 risk-reward ratio in very short and simple words, create a trade plan for this signal:
  // Stock: ${signal.stock}
  // Direction: ${signal.direction}
  // Entry: ${signal.entry}
  // Stoploss: ${signal.stopLoss}
  // Target1: ${signal.target1}
  // Target2: ${signal.target2}
  // Qty: ${signal.qty}
  // Explain briefly why this setup looks good. `;
  //   const response = await openai.chat.completions.create({
  //     model: "gpt-4-turbo",
  //     messages: [{ role: "user", content: prompt }],
  //   });
  //   return response.choices[0].message.content.trim();
}
