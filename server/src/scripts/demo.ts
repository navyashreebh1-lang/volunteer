/**
 * Zero-setup local demo: starts a throwaway in-memory MongoDB replica set,
 * seeds development sample accounts and runs the API. All data is lost when
 * the process stops. Nothing here is used in production.
 */
process.env.NODE_ENV ??= 'development';
process.env.FACULTY_EMAIL_DOMAINS ??= 'college.edu';
process.env.AUTH_PROVIDER ??= 'local';
process.env.STORAGE_DRIVER ??= 'local';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const { buildContext, start } = await import('../index.js');
const { seedDevelopmentData } = await import('./seed.js');

console.log('[voluntrix] starting in-memory MongoDB (first run downloads the MongoDB binary)…');
const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
process.env.MONGODB_URI = replSet.getUri('voluntrix_demo');

const ctx = buildContext();
await start(ctx);
const seeded = await seedDevelopmentData(ctx);

console.log('\n[voluntrix] Development sample accounts (data is in-memory and temporary):');
console.table(seeded.accounts);
console.log(`Password for all sample accounts: ${seeded.password}\n`);

const stop = async () => {
  await replSet.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

export {};
