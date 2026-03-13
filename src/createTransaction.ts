import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  ddbDoc, sqsClient, TABLE_NAME,
  json, errorResponse, requireApiKey, writeAuditEntry,
  type Transaction,
} from "./shared.js";
import { createLogger } from "./logger.js";
import { InvalidJSONError, ValidationError } from "./errors.js";

// ─── Zod schema ───────────────────────────────────────────────────────────────

const CreateTransactionSchema = z.object({
  amount: z
    .number({ required_error: "amount is required", invalid_type_error: "amount must be a number" })
    .positive("amount must be a positive number"),
  currency: z
    .string({ required_error: "currency is required" })
    .regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO 4217 code (e.g. USD)"),
  reference: z
    .string({ required_error: "reference is required" })
    .trim()
    .min(1, "reference must not be empty"),
  metadata: z.record(z.unknown()).optional(),
});

type CreateTransactionBody = z.infer<typeof CreateTransactionSchema>;

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handler(event: APIGatewayProxyEventV2 | any) {
  const requestId: string =
    (event as any)?.requestContext?.requestId ??
    (event as any)?.requestContext?.http?.requestId ??
    uuidv4();

  const log = createLogger({ service: "createTransaction", requestId });

  try {
    // ── 1. API-key guard ──────────────────────────────────────────────────────
    requireApiKey(event);

    // ── 2. Parse body ─────────────────────────────────────────────────────────
    let raw: unknown;
    try {
      raw = event.body ? JSON.parse(event.body) : {};
    } catch {
      throw new InvalidJSONError();
    }

    // ── 3. Zod validation ─────────────────────────────────────────────────────
    const parsed = CreateTransactionSchema.safeParse(raw);
    if (!parsed.success) {
      const details = parsed.error.errors.map((e) => ({
        field:   e.path.join("."),
        message: e.message,
      }));
      throw new ValidationError(
        "Request body failed validation.",
        details,
      );
    }

    const body: CreateTransactionBody = parsed.data;

    // ── 4. Build & persist transaction ────────────────────────────────────────
    const now = new Date().toISOString();
    const tx: Transaction = {
      id:        uuidv4(),
      amount:    body.amount,
      currency:  body.currency,
      reference: body.reference,
      status:    "PENDING",
      createdAt: now,
      updatedAt: now,
    };

    await ddbDoc.send(new PutCommand({
      TableName:           TABLE_NAME,
      Item:                tx,
      ConditionExpression: "attribute_not_exists(id)",
    }));

    log.info("TransactionCreated", {
      transactionId: tx.id,
      amount:        tx.amount,
      currency:      tx.currency,
      reference:     tx.reference,
    });

    // ── 5. Audit ──────────────────────────────────────────────────────────────
    await writeAuditEntry({
      transactionId: tx.id,
      action:        "TRANSACTION_CREATED",
      snapshot:      { status: tx.status, amount: tx.amount, currency: tx.currency, reference: tx.reference },
      actor:         `api:${requestId}`,
    }).catch((err) => log.error("Audit write failed on TRANSACTION_CREATED", { transactionId: tx.id }, err));

    // ── 6. Enqueue for async processing ───────────────────────────────────────
    const queueUrl = process.env.QUEUE_URL ?? "";
    if (queueUrl) {
      await sqsClient.send(new SendMessageCommand({
        QueueUrl:    queueUrl,
        MessageBody: JSON.stringify({ transactionId: tx.id }),
      }));
      log.debug("TransactionEnqueued", { transactionId: tx.id });
    }

    return json(201, tx);
  } catch (err: unknown) {
    if (err instanceof Error && !("statusCode" in err)) {
      log.error("Unhandled error in createTransaction", {}, err);
    }
    return errorResponse(err);
  }
}
