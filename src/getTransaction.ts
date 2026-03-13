import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { ddbDoc, TABLE_NAME, json } from "./shared";

export async function handler(event: APIGatewayProxyEvent | any) {
  try {
    const id: string | undefined =
      event?.pathParameters?.id ??
      event?.pathParameters?.["id"];

    if (!id || id.trim() === "") {
      return json(400, { error: "BadRequest", message: "Transaction id is required." });
    }

    const result = await ddbDoc.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { id } })
    );

    if (!result.Item) {
      return json(404, { error: "NotFound", message: `Transaction '${id}' not found.` });
    }

    return json(200, result.Item);
  } catch (err: any) {
    console.error("getTransaction error", err);
    return json(500, { error: "InternalError", message: "An unexpected error occurred." });
  }
}
