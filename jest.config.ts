import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  globalSetup: '<rootDir>/src/__tests__/helpers/globalSetup.ts',
  globalTeardown: '<rootDir>/src/__tests__/helpers/globalTeardown.ts',
  moduleNameMapper: {
    // Suites use a private database on one shared mongod instead of booting their own.
    '^mongodb-memory-server$': '<rootDir>/src/__tests__/helpers/mongoMemoryServerShim.ts',
  },
  verbose: true,
  forceExit: true,
  // Also applies to beforeAll/afterAll; generous because CI runners can be slow.
  testTimeout: 120000,
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
  transform: {
    // isolatedModules skips per-file type-checking (much faster). `npm run type-check` /
    // `npm run build` (tsc, which includes the tests) is the type gate.
    '^.+\\.[tj]sx?$': ['ts-jest', { isolatedModules: true }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(jose)/)',
  ],
};

export default config;
