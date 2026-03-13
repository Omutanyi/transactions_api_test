import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { v4 as uuidv4 } from "uuid";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { ddbDoc, sqsClient, TABLE_NAME, QUEUE_URL, json, type Transaction } from "./shared";

// ─── Validation ───────────────────────────────────────────────────────────────

interface CreateTransactionBody {
  amount: number;
  currency: string;
  reference: string;
  [key: string]: unknown;
}

function validate(body: Record<string, unknown>): body is CreateTransactionBody {
  if (typeof body.amount !== "number" || body.amount <= 0) return false;
  if (typeof body.currency !== "string" || !/^[A-Z]{3}$/.test(body.currency)) return false;
  if (typeof body.reference !== "string" || body.reference.trim() === "") return false;
  return true;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    let body: Record<string, unknown>;
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      return json(400, { error: "InvalidJSON", message: "Request body is not valid JSON." });
    }

    if (!validate(body)) {
      return json(400, {
        error: "ValidationError",
        message: "Required fields: amount (positive number), currency (3-letter ISO), reference (non-empty string).",
      });
    }

    const now = new Date().toISOString();

    const tx: Transaction = {
      id:        uuidv4(),
      amount:    body.amount,
      currency:  body.currency,
      reference: body.reference.trim(),
      status:    "PENDING",
      createdAt: now,
      updatedAt: now,
    };

    // Persist with PENDING status; fail-safe against duplicate IDs
    await ddbDoc.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: tx,
      ConditionExpression: "attribute_not_exists(id)",
    }));

    // Enqueue for async processing (fire-and-forget from the API perspective)
    if (QUEUE_URL) {
      await sqsClient.send(new SendMessageCommand({
        QueueUrl:    QUEUE_URL,
        MessageBody: JSON.stringify({ transactionId: tx.id }),
      }));
    }

    console.log("TransactionCreated", JSON.stringify({ id: tx.id, reference: tx.reference }));

    return json(201, tx);
  } catch (err: any) {
    console.error("createTransaction error", err);
    return json(500, { error: "InternalError", message: "An unexpected error occurred." });
  }
}
