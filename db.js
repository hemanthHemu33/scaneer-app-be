import dotenv from "dotenv";
dotenv.config();
import { MongoClient } from "mongodb";

let client;
let database;
let memoryServer;
const uri =
  process.env.DB_URI ||
  `mongodb+srv://${process.env.DB_USER_NAME}:${process.env.DB_PASSWORD}@cluster0.53r8xqg.mongodb.net/?retryWrites=true&w=majority`;

async function ensureIndexes(db) {
  if (typeof db.collection !== "function") return;
  await db.collection("historical_session_data").createIndex({ token: 1, date: 1 });
  await db.collection("signals").createIndex(
    { generatedAt: 1 },
    { expireAfterSeconds: 60 * 60 * 24 * 7 }
  );
  await db.collection("tick_data").createIndex(
    { timestamp: 1 },
    { expireAfterSeconds: 60 * 60 * 24 }
  );
  await db.collection("active_signals").createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 }
  );
  await db.collection("retry_queue").createIndex({ nextAttempt: 1 });
  await db.collection("open_trades").createIndex({ slId: 1 });
  await db.collection("open_trades").createIndex({ targetId: 1 });
  // Ensure aligned tick storage exists for minute-level tick aggregation
  await db
    .collection("aligned_ticks")
    .createIndex({ token: 1, minute: 1 }, { unique: true });
}

export const connectDB = async (attempt = 0) => {
  if (database) return database;
  if (process.env.NODE_ENV === "test") {
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    memoryServer = await MongoMemoryServer.create();
    const memUri = memoryServer.getUri();
    client = new MongoClient(memUri);
    await client.connect();
    database = client.db();
    return database;
  }
  const MAX = 5;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    client = new MongoClient(uri, { maxPoolSize: 100 });
    await client.connect();
    database = client.db(process.env.DB_NAME);
    await ensureIndexes(database);
    console.log(`connected to db ${process.env.DB_NAME}`);
    return database;
  } catch (err) {
    console.error("Mongo connection failed", err);
    if (attempt >= MAX) throw err;
    const wait = Math.pow(2, attempt) * 1000;
    console.log(`retrying connection in ${wait}ms`);
    await delay(wait);
    return connectDB(attempt + 1);
  }
};

const db = await connectDB();

export default db;

if (process.env.NODE_ENV === "test") {
  process.once("exit", async () => {
    try {
      await client?.close();
      await memoryServer?.stop();
    } catch {
      /* ignore */
    }
  });
}

