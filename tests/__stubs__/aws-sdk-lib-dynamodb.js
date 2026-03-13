// Stub for @aws-sdk/lib-dynamodb used during unit tests.
export const DynamoDBDocumentClient = {
  from: (_client) => ({ send: () => Promise.resolve({}) }),
};
export class PutCommand    { constructor(input) { this.input = input; } }
export class GetCommand    { constructor(input) { this.input = input; } }
export class UpdateCommand { constructor(input) { this.input = input; } }
