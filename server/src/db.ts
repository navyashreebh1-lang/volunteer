import dns from 'node:dns';
import mongoose from 'mongoose';
import './models.js';

/**
 * Connects and builds all indexes up front. The unique indexes are part of
 * the security model (unique USN / email / username, one open promotion
 * request per student), so the app must not serve requests before they exist.
 *
 * Multi-document transactions are used for promotions, which requires a
 * replica set: MongoDB Atlas qualifies, a bare standalone `mongod` does not.
 */
export async function connectDatabase(uri: string) {
  // mongodb+srv:// needs DNS SRV lookups. On some Windows setups Node only
  // sees a loopback resolver that refuses them (querySrv ECONNREFUSED) even
  // though the system resolves fine; DNS_SERVERS lets you name resolvers.
  const dnsServers = (process.env.DNS_SERVERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (dnsServers.length) dns.setServers(dnsServers);

  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  await Promise.all(Object.values(mongoose.models).map((model) => model.createCollection()));
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
