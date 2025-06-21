import dotenv from "dotenv";
dotenv.config();
import { MongoClient } from "mongodb";

//db init
let uri = `mongodb+srv://${process.env.DB_USER_NAME}:${process.env.DB_PASSWORD}@cluster0.53r8xqg.mongodb.net/?retryWrites=true&w=majority`;
let client;
let database;

export const connectDB = async () => {
  if (!client) {
    client = new MongoClient(uri, {
      maxPoolSize: 100, // Limits max connections to avoid overload
    });

    await client.connect();
    database = client.db(process.env.DB_NAME);
    console.log(`connected to db ${process.env.DB_NAME}`)
  }
  return database;
};

const db = await connectDB();

export default db;