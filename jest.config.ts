import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  verbose: true,
  forceExit: true,
  // Also applies to beforeAll/afterAll: each suite boots its own in-memory mongod, which can
  // take well over 30s on the shared self-hosted deploy runner.
  testTimeout: 120000,
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
  transform: {
    // 151002: hybrid Node16 module kind warning; tsc (npm run build) is the type-check gate.
    '^.+\\.[tj]sx?$': ['ts-jest', { diagnostics: { ignoreCodes: [151002] } }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(jose)/)',
  ],
};

export default config;
