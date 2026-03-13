// Stub for @aws-sdk/client-sqs used during unit tests.
export class SQSClient {
  constructor(_config) {}
  send(_command) { return Promise.resolve({}); }
}
export class SendMessageCommand { constructor(input) { this.input = input; } }
