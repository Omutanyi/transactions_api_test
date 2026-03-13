export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  globals: {
    'ts-jest': { useESM: true, tsconfig: 'tsconfig.json' }
  },
  injectGlobals: true,
  testMatch: ['**/tests/**/*.test.ts'],
  moduleNameMapper: {
    // Strip .js extension from relative imports (needed for ESM + ts-jest)
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Map AWS SDK and uuid to manual stubs so Jest's ESM linker never tries
    // to parse the real CJS packages (which causes "module not linked" errors).
    '^@aws-sdk/client-dynamodb$': '<rootDir>/tests/__stubs__/aws-sdk-dynamodb.js',
    '^@aws-sdk/lib-dynamodb$':    '<rootDir>/tests/__stubs__/aws-sdk-lib-dynamodb.js',
    '^@aws-sdk/client-sqs$':      '<rootDir>/tests/__stubs__/aws-sdk-sqs.js',
    '^uuid$':                     '<rootDir>/tests/__stubs__/uuid.js',
  },
};
