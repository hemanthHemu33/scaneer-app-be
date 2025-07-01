import dotenv from "dotenv";
dotenv.config();
import { MongoClient } from "mongodb";

//db init
let uri = `mongodb+srv://${process.env.DB_USER_NAME}:${process.env.DB_PASSWORD}@cluster0.53r8xqg.mongodb.net/?retryWrites=true&w=majority`;
let client;
let database;

async function ensureIndexes(db) {
  await db.collection("historical_session_data").createIndex({ token: 1, date: 1 });
  await db.collection("signals").createIndex(
    { generatedAt: 1 },
    { expireAfterSeconds: 60 * 60 * 24 * 7 }
  );
}

export const connectDB = async (attempt = 0) => {
  if (database) return database;
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
