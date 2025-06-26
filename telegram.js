import dotenv from "dotenv";
dotenv.config();

import TelegramBot from "node-telegram-bot-api";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot;
if (token) {
  bot = new TelegramBot(token, { polling: false });
} else {
  console.warn("Telegram bot token not provided.");
}

// export function sendSignal(signal) {
//   if (!bot || !chatId) {
//     console.warn("Telegram bot not configured properly.");
//     return;
//   }
//   const { stock, direction, entry, stopLoss, target1, target2, confidence } =
//     signal;
//   const formattedDirection = direction === "Long" ? "🟢 Long" : "🔴 Short";
//   const text = `\u{1F4C8} *${stock}*\nDirection: *${formattedDirection}*\nEntry: ${entry}\nSL: ${stopLoss}\nT1: ${target1} | T2: ${target2}\nConfidence: ${confidence}`;

//   bot
//     .sendMessage(chatId, text, { parse_mode: "Markdown" })
//     .catch((err) => console.error("Telegram send error", err));
// }
export function sendSignal(signal) {
  if (!bot || !chatId) {
    console.warn("Telegram bot not configured properly.");
    return;
  }

  const { stock, direction, entry, stopLoss, target1, target2, confidence } =
    signal;
  const formattedDirection =
    direction === "Long" ? "🟢 Long Bias" : "🔴 Short Bias";

  const text =
    `🚨 *Trade Signal Activated*\n\n` +
    `📌 *Instrument:* *${stock}*\n` +
    `📈 *Direction:* ${formattedDirection}\n` +
    `🎯 *Entry:* ${entry}\n` +
    `🛑 *Stop Loss:* ${stopLoss}\n` +
    `🎯 *Targets:* T1: ${target1} | T2: ${target2}\n` +
    `📊 *Confidence Level:* ${confidence}/10\n\n` +
    `🕒 _Stay sharp. Market conditions may change quickly._`;

  bot
    .sendMessage(chatId, text, { parse_mode: "Markdown" })
    .catch((err) => console.error("Telegram send error", err));
}
