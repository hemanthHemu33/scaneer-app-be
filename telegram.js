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
    console.warn("Telegram bot not configured properly.");
    return;
  }

  const { stock, direction, entry, stopLoss, target1, target2, confidence } =
    signal;

  // CHANGE THE DIRECTION COLOR BASED ON DIRECTION
  const directionColor = direction === "Long" ? "green" : "red";
  // Format the direction with color
  const formattedDirection = `<span style="color:${directionColor}">${direction}</span>`;
  const text = `\u{1F4C8} *${stock}*\nDirection: *${formattedDirection}*\nEntry: ${entry}\nSL: ${stopLoss}\nT1: ${target1} | T2: ${target2}\nConfidence: ${confidence}`;

  bot
    .sendMessage(chatId, text, { parse_mode: "Markdown" })
    .catch((err) => console.error("Telegram send error", err));
}
