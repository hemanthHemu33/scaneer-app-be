// TELEGRAM.JS
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

export function sendSignal(signal) {
  if (!bot || !chatId) {
    const err = new Error("TELEGRAM_NOT_CONFIGURED");
    err.code = "TELEGRAM_NOT_CONFIGURED";
    return Promise.reject(err);
  }

  const data = signal.algoSignal || signal;
  const stock = signal.stock || data.symbol;
  const direction =
    signal.direction || (data.side === "buy" ? "Long" : "Short");
  const entry = signal.entry || data.entry;
  const stopLoss = signal.stopLoss || data.stopLoss;
  const target1 = signal.target1 || (data.targets ? data.targets[0] : null);
  const target2 = signal.target2 || (data.targets ? data.targets[1] : null);
  const confidence = signal.confidence || data.confidenceScore;
  const formattedDirection =
    direction === "Long" ? "🟢 Long Bias" : "🔴 Short Bias";

  const text =
    `🚨 *Trade Signal Activated*\n\n` +
    `📌 *Instrument:* *${stock}*\n` +
    `📈 *Direction:* ${formattedDirection}\n` +
    `🎯 *Entry:* ${entry}\n` +
    `🛑 *Stop Loss:* ${stopLoss}\n` +
    `🎯 *Targets:* T1: ${target1} | T2: ${target2}\n` +
    `📊 *Confidence Level:* ${confidence}\n\n` +
    `🕒 _Stay sharp. Market conditions may change quickly._`;

  return bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

export function sendNotification(message) {
  if (!bot || !chatId) return;
  bot.sendMessage(chatId, message).catch((err) => console.error("Telegram send error", err));
}
