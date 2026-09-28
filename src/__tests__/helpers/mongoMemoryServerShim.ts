import crypto from "crypto";
import { MongoClient } from "mongodb";

// Stands in for `mongodb-memory-server` inside test suites (jest.config moduleNameMapper).
// Suites keep calling MongoMemoryServer.create() / getUri() / stop() unchanged, but they now get
// a private database on the single shared mongod started in globalSetup.
export class MongoMemoryServer {
  private readonly dbName = `t_${crypto.randomBytes(6).toString("hex")}`;
  private readonly base = process.env.JEST_MONGO_URI as string;

  static async create(): Promise<MongoMemoryServer> {
    if (!process.env.JEST_MONGO_URI) throw new Error("JEST_MONGO_URI is not set (jest globalSetup did not run)");
    return new MongoMemoryServer();
  }

  getUri(dbName: string = this.dbName): string {
    return `${this.base}${dbName}`;
  }

  async stop(): Promise<boolean> {
    const client = new MongoClient(this.base);
    try {
      await client.connect();
      await client.db(this.dbName).dropDatabase();
    } finally {
      await client.close();
    }
    return true;
  }
}
