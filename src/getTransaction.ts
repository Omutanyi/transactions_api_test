import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { ddbDoc, TABLE_NAME, json, errorResponse, requireApiKey } from "./shared.js";
import { createLogger } from "./logger.js";
import { NotFoundError, ValidationError } from "./errors.js";

export async function handler(event: APIGatewayProxyEvent | any) {
  const requestId: string =
    (event as any)?.requestContext?.requestId ??
    (event as any)?.requestContext?.http?.requestId ??
    uuidv4();

  const log = createLogger({ service: "getTransaction", requestId });

  try {
    // ── 1. API-key guard ──────────────────────────────────────────────────────
    requireApiKey(event);

    // ── 2. Validate path param ────────────────────────────────────────────────
    const id: string | undefined =
      event?.pathParameters?.id ??
      event?.pathParameters?.["id"];

    if (!id || id.trim() === "") {
      throw new ValidationError("Transaction id path parameter is required.");
    }

    log.debug("FetchingTransaction", { transactionId: id });

    // ── 3. DynamoDB lookup ────────────────────────────────────────────────────
    const result = await ddbDoc.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { id } }),
    );

    if (!result.Item) {
      throw new NotFoundError(`Transaction '${id}'`);
    }

    log.info("TransactionFetched", { transactionId: id, status: result.Item.status });

    return json(200, result.Item);
  } catch (err: unknown) {
    if (err instanceof Error && !("statusCode" in err)) {
      log.error("Unhandled error in getTransaction", {}, err);
    }
    return errorResponse(err);
  }
}
