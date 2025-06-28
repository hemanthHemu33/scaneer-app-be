# Scanner App Backend

This repository contains the backend services for the Scanner application.

## Node Version

The project requires **Node.js v18** or later.

## Environment Variables

Create a `.env` file in the project root (or export variables in your environment) with the following variables:

- `DB_USER_NAME` – MongoDB username
- `DB_PASSWORD` – MongoDB password
- `DB_NAME` – Database name
- `KITE_API_KEY` – Kite Connect API key
- `KITE_API_SECRET` – Kite Connect API secret
- `OPENAI_API_KEY` – OpenAI API key
- `TELEGRAM_BOT_TOKEN` – Telegram bot token
- `TELEGRAM_CHAT_ID` – Telegram chat ID for notifications

## Starting the Server

Install dependencies and start the backend server:

```bash
npm install
npm start
```

The server listens on port **3000**.

## Running Tests

Execute the basic test suite with:

```bash
npm test
```

