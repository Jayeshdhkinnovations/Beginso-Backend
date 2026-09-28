export default async function globalTeardown(): Promise<void> {
  await (globalThis as any).__JEST_MONGOD__?.stop();
}
