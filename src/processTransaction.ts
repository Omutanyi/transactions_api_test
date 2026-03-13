import { UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { ddbDoc, TABLE_NAME, writeAuditEntry, type TransactionStatus } from "./shared.js";
import { createLogger } from "./logger.js";

const log = createLogger({ service: "processTransaction" });

// ─── Simulated processing logic ──────────────────────────────────────────────

/**
 * Simulates payment-processor behaviour:
 *   - 90 % of transactions succeed
 *   - 10 % fail (to exercise the FAILED path in tests / demos)
 *
 * In a production system this would call a real payment gateway.
 */
async function runProcessing(
  txId: string,
): Promise<{ status: "COMPLETED" | "FAILED"; failureReason?: string }> {
  // Simulate I/O latency (≤ 200 ms so the Lambda stays well within timeout)
  await new Promise((r) => setTimeout(r, 100));

  if (Math.random() < 0.9) {
    return { status: "COMPLETED" };
  }
  return { status: "FAILED", failureReason: "Payment processor declined the transaction." };
}

// ─── DynamoDB helpers ─────────────────────────────────────────────────────────

async function transitionStatus(
  id: string,
  from: TransactionStatus,
  to: TransactionStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date().toISOString();
  const extraKeys = Object.keys(extra);

  const ExpressionAttributeNames: Record<string, string> = {
    "#s": "status",
    "#u": "updatedAt",
  };
  const ExpressionAttributeValues: Record<string, unknown> = {
    ":to":   to,
    ":from": from,
    ":now":  now,
  };

  let setExpr = "SET #s = :to, #u = :now";
  for (const k of extraKeys) {
    const nameKey  = `#${k}`;
    const valueKey = `:${k}`;
    ExpressionAttributeNames[nameKey]   = k;
    ExpressionAttributeValues[valueKey] = extra[k];
    setExpr += `, ${nameKey} = ${valueKey}`;
  }

  await ddbDoc.send(
    new UpdateCommand({
      TableName:                 TABLE_NAME,
      Key:                       { id },
      UpdateExpression:          setExpr,
      ConditionExpression:       "#s = :from",
      ExpressionAttributeNames,
      ExpressionAttributeValues,
    }),
  );
}

// ─── Per-record processor ─────────────────────────────────────────────────────

async function processRecord(record: SQSRecord): Promise<void> {
  let transactionId: string;

  try {
    const payload = JSON.parse(record.body) as { transactionId: string };
    transactionId = payload.transactionId;
  } catch {
    log.error("Malformed SQS message body, skipping", { messageId: record.messageId, body: record.body });
    // Do not throw – message is unprocessable, skip it (no DLQ retry needed)
    return;
  }

  const txLog = log.child({ transactionId, messageId: record.messageId });
  txLog.info("ProcessingStarted");

  // Guard: only process PENDING transactions (idempotency)
  const existing = await ddbDoc.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { id: transactionId } }),
  );
  if (!existing.Item) {
    txLog.warn("TransactionNotFound, skipping");
    return;
  }
  if (existing.Item.status !== "PENDING") {
    txLog.warn("TransactionAlreadyProcessed, skipping", { currentStatus: existing.Item.status });
    return;
  }

  // PENDING → PROCESSING
  try {
    await transitionStatus(transactionId, "PENDING", "PROCESSING");
    txLog.info("StatusTransitioned", { from: "PENDING", to: "PROCESSING" });

    try {
      await writeAuditEntry({
        transactionId,
        action:   "TRANSACTION_PROCESSING_STARTED",
        snapshot: { status: "PROCESSING" },
        actor:    `sqs:${record.messageId}`,
      });
    } catch (err) {
      txLog.error("Audit write failed on PROCESSING_STARTED", {}, err);
    }
  } catch (err: any) {
    if (err.name === "ConditionalCheckFailedException") {
      // Another invocation already picked this up
      txLog.warn("ConcurrencyRace on PENDING→PROCESSING, skipping");
      return;
    }
    throw err;
  }

  // Run the business logic
  let outcome: { status: "COMPLETED" | "FAILED"; failureReason?: string };
  try {
    outcome = await runProcessing(transactionId);
  } catch (err: unknown) {
    txLog.error("ProcessingStepThrew, marking FAILED", {}, err);
    outcome = { status: "FAILED", failureReason: "Unexpected processing error." };
  }

  txLog.info("ProcessingOutcome", { outcome: outcome.status, failureReason: outcome.failureReason });

  // PROCESSING → COMPLETED / FAILED
  const extra: Record<string, unknown> = {};
  if (outcome.failureReason) extra.failureReason = outcome.failureReason;

  try {
    await transitionStatus(transactionId, "PROCESSING", outcome.status, extra);
    txLog.info("StatusTransitioned", { from: "PROCESSING", to: outcome.status });

    const auditAction = outcome.status === "COMPLETED"
      ? "TRANSACTION_COMPLETED" as const
      : "TRANSACTION_FAILED" as const;

    try {
      await writeAuditEntry({
        transactionId,
        action:   auditAction,
        snapshot: { status: outcome.status, failureReason: outcome.failureReason },
        actor:    `sqs:${record.messageId}`,
      });
    } catch (err) {
      txLog.error("Audit write failed on final status", { auditAction }, err);
    }
  } catch (err: any) {
    if (err.name === "ConditionalCheckFailedException") {
      txLog.warn("ConcurrencyRace on PROCESSING→final, skipping");
      return;
    }
    throw err;
  }

  txLog.info("ProcessingFinished", { finalStatus: outcome.status });
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

export async function handler(
  event: SQSEvent,
): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const failures: { itemIdentifier: string }[] = [];

  await Promise.allSettled(
    event.Records.map(async (record) => {
      try {
        await processRecord(record);
      } catch (err) {
        log.error("UnhandledError for SQS message", { messageId: record.messageId }, err);
        // Report partial batch failure so SQS retries only this message
        failures.push({ itemIdentifier: record.messageId });
      }
    }),
  );

  return { batchItemFailures: failures };
}
