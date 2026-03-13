import { UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { ddbDoc, TABLE_NAME, type TransactionStatus } from "./shared";

// ─── Simulated processing logic ──────────────────────────────────────────────

/**
 * Simulates payment-processor behaviour:
 *   - 90 % of transactions succeed
 *   - 10 % fail (to exercise the FAILED path in tests / demos)
 *
 * In a production system this would call a real payment gateway.
 */
async function runProcessing(
  txId: string
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
  extra: Record<string, unknown> = {}
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
    ExpressionAttributeNames[nameKey]  = k;
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
    })
  );
}

// ─── Per-record processor ─────────────────────────────────────────────────────

async function processRecord(record: SQSRecord): Promise<void> {
  let transactionId: string;

  try {
    const payload = JSON.parse(record.body) as { transactionId: string };
    transactionId = payload.transactionId;
  } catch {
    console.error("processTransaction: malformed SQS message body", record.body);
    // Do not throw – message is unprocessable, skip it (no DLQ retry needed)
    return;
  }

  console.log("processTransaction: starting", transactionId);

  // Guard: only process PENDING transactions (idempotency)
  const existing = await ddbDoc.send(new GetCommand({ TableName: TABLE_NAME, Key: { id: transactionId } }));
  if (!existing.Item) {
    console.warn("processTransaction: transaction not found, skipping", transactionId);
    return;
  }
  if (existing.Item.status !== "PENDING") {
    console.warn("processTransaction: transaction already processed, skipping", transactionId, existing.Item.status);
    return;
  }

  // PENDING → PROCESSING
  try {
    await transitionStatus(transactionId, "PENDING", "PROCESSING");
  } catch (err: any) {
    if (err.name === "ConditionalCheckFailedException") {
      // Another invocation already picked this up
      console.warn("processTransaction: concurrency race on PENDING→PROCESSING, skipping", transactionId);
      return;
    }
    throw err;
  }

  // Run the business logic
  let outcome: { status: "COMPLETED" | "FAILED"; failureReason?: string };
  try {
    outcome = await runProcessing(transactionId);
  } catch (err: any) {
    console.error("processTransaction: processing step threw, marking FAILED", transactionId, err);
    outcome = { status: "FAILED", failureReason: "Unexpected processing error." };
  }

  // PROCESSING → COMPLETED / FAILED
  const extra: Record<string, unknown> = {};
  if (outcome.failureReason) extra.failureReason = outcome.failureReason;

  try {
    await transitionStatus(transactionId, "PROCESSING", outcome.status, extra);
  } catch (err: any) {
    if (err.name === "ConditionalCheckFailedException") {
      console.warn("processTransaction: concurrency race on PROCESSING→final, skipping", transactionId);
      return;
    }
    throw err;
  }

  console.log("processTransaction: finished", transactionId, outcome.status);
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

export async function handler(event: SQSEvent): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const failures: { itemIdentifier: string }[] = [];

  await Promise.allSettled(
    event.Records.map(async (record) => {
      try {
        await processRecord(record);
      } catch (err) {
        console.error("processTransaction: unhandled error for message", record.messageId, err);
        // Report partial batch failure so SQS retries only this message
        failures.push({ itemIdentifier: record.messageId });
      }
    })
  );

  return { batchItemFailures: failures };
}
