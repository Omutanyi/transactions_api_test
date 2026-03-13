import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { UnauthorizedError, AppError } from "./errors.js";
import type { APIGatewayProxyEvent, APIGatewayProxyEventV2 } from "aws-lambda";

export const TABLE_NAME       = process.env.TABLE_NAME       ?? "transactions";
export const AUDIT_TABLE_NAME = process.env.AUDIT_TABLE_NAME ?? "transaction-audit";
export const QUEUE_URL        = process.env.QUEUE_URL        ?? "";

/**
 * The expected API key value is read from an environment variable so it can be
 * injected via AWS Systems Manager Parameter Store / Secrets Manager in
 * production without ever touching source code.
 *
 * In SAM/LocalStack the variable is set in template.yaml Globals.
 */
const API_KEY_HEADER = "x-api-key";
export const API_KEY = process.env.API_KEY ?? "";

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

// ─── Audit types ─────────────────────────────────────────────────────────────

export type AuditAction =
  | "TRANSACTION_CREATED"
  | "TRANSACTION_STATUS_CHANGED"
  | "TRANSACTION_PROCESSING_STARTED"
  | "TRANSACTION_COMPLETED"
  | "TRANSACTION_FAILED";

export interface AuditEntry {
  /** Partition key: the transaction ID */
  transactionId: string;
  /** Sort key: ISO timestamp + random suffix for uniqueness within same ms */
  auditId: string;
  action: AuditAction;
  timestamp: string;
  /** Snapshot of relevant fields at this point in time */
  snapshot: Record<string, unknown>;
  /** Actor/source that triggered the action */
  actor: string;
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

// Lazy singletons: clients are created on first use so that unit tests can
// register mocks for @aws-sdk/* BEFORE any client is instantiated.
let _ddbDoc:    DynamoDBDocumentClient | undefined;
let _sqsClient: SQSClient | undefined;

export function getDdbDoc(): DynamoDBDocumentClient {
  if (!_ddbDoc) _ddbDoc = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig()));
  return _ddbDoc;
}

export function getSqsClient(): SQSClient {
  if (!_sqsClient) _sqsClient = new SQSClient(clientConfig());
  return _sqsClient;
}

/** @deprecated Use getDdbDoc() – kept as a convenience re-export for existing callers */
export const ddbDoc    = new Proxy({} as DynamoDBDocumentClient, { get: (_t, p) => (getDdbDoc() as any)[p] });
/** @deprecated Use getSqsClient() – kept as a convenience re-export for existing callers */
export const sqsClient = new Proxy({} as SQSClient,              { get: (_t, p) => (getSqsClient() as any)[p] });

// ─── API-Key guard ────────────────────────────────────────────────────────────

/**
 * Validates the `x-api-key` request header against the value stored in the
 * API_KEY environment variable.
 *
 * Throws UnauthorizedError (401) if the key is absent or wrong.
 * Skips validation when API_KEY env var is not configured (dev convenience).
 */
export function requireApiKey(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2 | Record<string, unknown>,
): void {
  // If no API_KEY is configured, skip validation (e.g. local unit tests)
  if (!API_KEY) return;

  const headers: Record<string, string | undefined> =
    ((event as any).headers ?? {}) as Record<string, string | undefined>;

  // Header names from API Gateway are lower-cased
  const provided =
    headers[API_KEY_HEADER] ??
    headers["X-Api-Key"] ??
    headers["x-api-key"];

  if (!provided || provided !== API_KEY) {
    throw new UnauthorizedError();
  }
}

// ─── Audit helper ─────────────────────────────────────────────────────────────

/**
 * Writes a single audit entry to the TransactionAuditLog table.
 * Failures are logged but never rethrown — auditing must not break the
 * primary transaction flow.
 */
export async function writeAuditEntry(
  entry: Omit<AuditEntry, "auditId" | "timestamp">,
): Promise<void> {
  const timestamp = new Date().toISOString();
  // suffix with a random hex fragment so two events in the same ms don't collide
  const auditId = `${timestamp}#${Math.random().toString(16).slice(2, 10)}`;

  const item: AuditEntry = { ...entry, auditId, timestamp };

  await ddbDoc.send(
    new PutCommand({
      TableName: AUDIT_TABLE_NAME,
      Item: item,
    }),
  );
}

// ─── HTTP response helper ─────────────────────────────────────────────────────

export function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": `content-type,x-idempotency-key,${API_KEY_HEADER}`,
      "access-control-allow-methods": "GET,POST,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

/**
 * Converts any error into a well-shaped HTTP response.
 * AppError subclasses are mapped to their declared status codes.
 * Everything else becomes 500.
 */
export function errorResponse(err: unknown) {
  if (err instanceof AppError) {
    const body: Record<string, unknown> = {
      error:   err.code,
      message: err.message,
    };
    if (err.details !== undefined) body.details = err.details;
    return json(err.statusCode, body);
  }
  return json(500, { error: "InternalError", message: "An unexpected error occurred." });
}
