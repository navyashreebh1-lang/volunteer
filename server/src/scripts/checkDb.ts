/** Verifies the configured MongoDB: connects, builds indexes and runs a transaction. */
import mongoose from 'mongoose';
import { loadConfig } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../db.js';

const { mongoUri } = loadConfig();
if (!mongoUri) throw new Error('MONGODB_URI is not set. See server/.env.example.');

await connectDatabase(mongoUri);
try {
  const db = mongoose.connection.db!;
  const hello = await db.admin().command({ hello: 1 });
  console.log(`Connected to database "${db.databaseName}" (replica set: ${hello.setName ?? 'none'})`);

  // Promotions rely on transactions; prove they work here, then roll back.
  await mongoose.connection.transaction(async (session) => {
    await db.collection('notifications').findOne({}, { session });
  });
  console.log('Transactions: supported');

  const collections = await db.listCollections().toArray();
  console.log(`Collections: ${collections.map((c) => c.name).sort().join(', ')}`);
} finally {
  await disconnectDatabase();
}
