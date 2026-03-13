import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";

export const TABLE_NAME = process.env.TABLE_NAME ?? "transactions";
export const QUEUE_URL  = process.env.QUEUE_URL  ?? "";

// ─── Transaction types ───────────────────────────────────────────────────────

export type TransactionStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface Transaction {
  id: string;
  amount: number;
  currency: string;
  reference: string;
  status: TransactionStatus;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
}

// ─── AWS clients ─────────────────────────────────────────────────────────────

function clientConfig() {
  return {
    endpoint: process.env.AWS_ENDPOINT_URL,
    region: process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    credentials: {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID     ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  };
}

export const ddbDoc = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig()));
export const sqsClient = new SQSClient(clientConfig());

export function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type,x-idempotency-key",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}
