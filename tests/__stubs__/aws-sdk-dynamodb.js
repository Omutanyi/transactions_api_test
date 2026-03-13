// Stub for @aws-sdk/client-dynamodb used during unit tests.
// The real implementation is mocked by jest.unstable_mockModule in handlers.test.ts;
// this file exists only so Jest's ESM module linker can resolve the import path.
export class DynamoDBClient {
  constructor(_config) {}
  send(_command) { return Promise.resolve({}); }
}
