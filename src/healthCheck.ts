import type { APIGatewayProxyEvent } from "aws-lambda";
import { json, errorResponse } from "./shared.js";
import { createLogger } from "./logger.js";

const log = createLogger({ service: "healthCheck" });

export async function handler(event: APIGatewayProxyEvent | any) {
  try {
    const path: string =
      event?.path ??
      event?.rawPath ??
      event?.requestContext?.http?.path ??
      "";

    const resource: string = event?.resource ?? "";

    if (path.endsWith("/health") || resource === "/health" || path === "") {
      log.debug("HealthCheckOk");
      return json(200, { ok: true, timestamp: new Date().toISOString() });
    }

    return json(404, { error: "NotFound", message: "Route not found." });
  } catch (err: unknown) {
    log.error("HealthCheckError", {}, err);
    return errorResponse(err);
  }
}
