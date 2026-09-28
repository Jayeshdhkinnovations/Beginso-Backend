import { MongoMemoryServer } from "mongodb-memory-server";

// One mongod for the whole run. Every suite gets its own database on it (see the shim), which
// removes ~30 separate mongod start-ups.
export default async function globalSetup(): Promise<void> {
  const server = await MongoMemoryServer.create();
  process.env.JEST_MONGO_URI = server.getUri();
  (globalThis as any).__JEST_MONGOD__ = server;
}
