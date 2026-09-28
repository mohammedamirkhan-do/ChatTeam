import { MongoClient } from 'mongodb';
import { config } from '../config/index.js';

const client = new MongoClient(config.databaseUrl, {
  maxPoolSize: 10,
  connectTimeoutMS: 5000,
});
let connected = false;

export async function getDb() {
  if (!connected) {
    await client.connect();
    connected = true;
  }
  return client.db('teamchat');
}

export async function checkMongoDB() {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function closeMongoDB() {
  await client.close();
}
