/** Seeds clearly-labelled development sample data into MONGODB_URI. Never for production. */
import { connectDatabase, disconnectDatabase } from '../db.js';
import { buildContext } from '../index.js';
import { seedDevelopmentData } from './seed.js';

const ctx = buildContext();
await connectDatabase(ctx.config.mongoUri);
try {
  const result = await seedDevelopmentData(ctx);
  console.table(result.accounts);
  console.log(`Password for all sample accounts: ${result.password}`);
} finally {
  await disconnectDatabase();
}
