/**
 * Unit tests for all Lambda handlers.
 *
 * All AWS SDK calls are mocked so no real DynamoDB / SQS is required.
 * Uses jest.unstable_mockModule (required for ESM + ts-jest).
 *
 * Module linking strategy:
 *   jest.config.js maps all AWS SDK / uuid imports to lightweight JS stubs
 *   in tests/__stubs__/.  jest.unstable_mockModule then replaces those stubs
 *   with proper jest.fn() mocks before any handler is dynamically imported.
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from "@jest/globals";

//  Shared mock functions

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDdbSend = jest.fn() as jest.MockedFunction<(...args: any[]) => any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSqsSend = jest.fn() as jest.MockedFunction<(...args: any[]) => any>;

//  Mock AWS SDK modules (ESM-compatible)

jest.unstable_mockModule("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

jest.unstable_mockModule("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: jest.fn().mockReturnValue({ send: mockDdbSend }),
  },
  PutCommand:    jest.fn().mockImplementation((input: unknown) => ({ input })),
  GetCommand:    jest.fn().mockImplementation((input: unknown) => ({ input })),
  UpdateCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

jest.unstable_mockModule("@aws-sdk/client-sqs", () => ({
  SQSClient:          jest.fn().mockImplementation(() => ({ send: mockSqsSend })),
  SendMessageCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

jest.unstable_mockModule("uuid", () => ({
  v4: jest.fn().mockReturnValue("mock-uuid-1234"),
}));

// Mock logger so it doesn't produce output during tests
jest.unstable_mockModule("../src/logger.js", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    child: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() }),
  }),
}));

// Mock shared.ts so that AWS SDK transitive deps don't need real packages
// when Jest links modules. The mock exposes the same surface that handlers use.
jest.unstable_mockModule("../src/shared.js", () => ({
  TABLE_NAME:       "transactions",
  AUDIT_TABLE_NAME: "transaction-audit",
  get QUEUE_URL()   { return process.env.QUEUE_URL ?? ""; },
  get API_KEY()     { return process.env.API_KEY ?? ""; },
  ddbDoc:           { send: mockDdbSend },
  sqsClient:        { send: mockSqsSend },
  requireApiKey(event: any) {
    const key = process.env.API_KEY;
    if (!key) return;
    const provided = event?.headers?.["x-api-key"] ?? event?.headers?.["X-Api-Key"];
    if (!provided || provided !== key) {
      // Inline UnauthorizedError so no import needed at mock-registration time
      const err: any = new Error("Missing or invalid API key.");
      err.name = "UnauthorizedError";
      err.code = "Unauthorized";
      err.statusCode = 401;
      throw err;
    }
  },
  writeAuditEntry: (jest.fn() as jest.MockedFunction<(...args: any[]) => any>).mockResolvedValue(undefined),
  json(statusCode: number, body: unknown) {
    return { statusCode, headers: {}, body: JSON.stringify(body) };
  },
  errorResponse(err: unknown) {
    // Inline the AppError check so we don't import shared at test load time
    if (err && typeof err === "object" && "statusCode" in err && "code" in err) {
      const e = err as any;
      const body: any = { error: e.code, message: e.message };
      if (e.details !== undefined) body.details = e.details;
      return { statusCode: e.statusCode, headers: {}, body: JSON.stringify(body) };
    }
    return { statusCode: 500, headers: {}, body: JSON.stringify({ error: "InternalError", message: "An unexpected error occurred." }) };
  },
}));

//  Lazily import handlers AFTER mocks are registered

let healthHandler:  (e: any) => Promise<any>;
let createHandler:  (e: any) => Promise<any>;
let getHandler:     (e: any) => Promise<any>;
let processHandler: (e: any) => Promise<any>;

beforeAll(async () => {
  const [healthMod, createMod, getMod, processMod] = await Promise.all([
    import("../src/healthCheck.js"),
    import("../src/createTransaction.js"),
    import("../src/getTransaction.js"),
    import("../src/processTransaction.js"),
  ]);
  healthHandler  = healthMod.handler;
  createHandler  = createMod.handler;
  getHandler     = getMod.handler;
  processHandler = processMod.handler;
});

//  Helpers

const VALID_API_KEY = "test-api-key";

function makeCreateEvent(body: unknown, apiKey?: string) {
  return {
    body: JSON.stringify(body),
    headers: apiKey !== undefined ? { "x-api-key": apiKey } : {},
  } as any;
}

function makeGetEvent(id: string, apiKey?: string) {
  return {
    pathParameters: { id },
    headers: apiKey !== undefined ? { "x-api-key": apiKey } : {},
  } as any;
}

function makeSQSEvent(transactionId: string, messageId = "msg-001") {
  return {
    Records: [{ messageId, body: JSON.stringify({ transactionId }) }],
  } as any;
}

//  healthCheck

describe("healthCheck", () => {
  test("returns 200 with { ok: true } on /health", async () => {
    const res: any = await healthHandler({ rawPath: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.timestamp).toBeDefined();
  });
});

//  createTransaction

describe("createTransaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDdbSend.mockResolvedValue({});
    mockSqsSend.mockResolvedValue({});
    process.env.QUEUE_URL = "http://sqs.us-east-1.localhost:4566/000000000000/transaction-queue";
    // Disable API-key enforcement so existing functional tests are unaffected
    process.env.API_KEY = "";
  });

  test("returns 201 with PENDING transaction for valid input", async () => {
    const res: any = await createHandler(
      makeCreateEvent({ amount: 100, currency: "USD", reference: "REF-001" }),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBe("mock-uuid-1234");
    expect(body.status).toBe("PENDING");
    expect(body.amount).toBe(100);
    expect(body.currency).toBe("USD");
    expect(body.reference).toBe("REF-001");
    expect(body.createdAt).toBeDefined();
    expect(body.updatedAt).toBeDefined();
  });

  test("publishes a message to SQS after persisting", async () => {
    await createHandler(
      makeCreateEvent({ amount: 50.5, currency: "EUR", reference: "REF-002" }),
    );
    expect(mockDdbSend).toHaveBeenCalledTimes(1); // PutCommand only (writeAuditEntry is mocked at shared level)
    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sqsCallArg = (mockSqsSend.mock.calls[0] as any[])[0] as any;
    expect(sqsCallArg.input.MessageBody).toContain("mock-uuid-1234");
  });

  test("returns 400 for missing amount", async () => {
    const res: any = await createHandler(
      makeCreateEvent({ currency: "USD", reference: "REF-003" }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("ValidationError");
  });

  test("returns 400 with Zod field details for non-positive amount", async () => {
    const res: any = await createHandler(
      makeCreateEvent({ amount: -10, currency: "USD", reference: "REF-004" }),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ValidationError");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details[0].field).toBe("amount");
  });

  test("returns 400 for invalid currency format (lowercase)", async () => {
    const res: any = await createHandler(
      makeCreateEvent({ amount: 100, currency: "us", reference: "REF-005" }),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.details[0].field).toBe("currency");
  });

  test("returns 400 for empty reference", async () => {
    const res: any = await createHandler(
      makeCreateEvent({ amount: 100, currency: "USD", reference: "   " }),
    );
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 for invalid JSON body", async () => {
    const res: any = await createHandler({ body: "not-json{", headers: {} });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("InvalidJSON");
  });

  test("returns 500 when DynamoDB throws", async () => {
    mockDdbSend.mockRejectedValueOnce(new Error("DDB failure"));
    const res: any = await createHandler(
      makeCreateEvent({ amount: 100, currency: "USD", reference: "REF-006" }),
    );
    expect(res.statusCode).toBe(500);
  });

  test("does not call SQS if QUEUE_URL is empty", async () => {
    process.env.QUEUE_URL = "";
    const res: any = await createHandler(
      makeCreateEvent({ amount: 100, currency: "GBP", reference: "REF-007" }),
    );
    expect(res.statusCode).toBe(201);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  // ── API-key enforcement tests ─────────────────────────────────────────────

  test("returns 401 when API_KEY is set and header is missing", async () => {
    process.env.API_KEY = VALID_API_KEY;
    const res: any = await createHandler(
      makeCreateEvent({ amount: 100, currency: "USD", reference: "REF-KEY-1" }),
    );
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("Unauthorized");
  });

  test("returns 401 when API_KEY is set and header is wrong", async () => {
    process.env.API_KEY = VALID_API_KEY;
    const res: any = await createHandler(
      makeCreateEvent({ amount: 100, currency: "USD", reference: "REF-KEY-2" }, "wrong-key"),
    );
    expect(res.statusCode).toBe(401);
  });

  test("returns 201 when API_KEY is set and correct key is provided", async () => {
    process.env.API_KEY = VALID_API_KEY;
    const res: any = await createHandler(
      makeCreateEvent({ amount: 100, currency: "USD", reference: "REF-KEY-3" }, VALID_API_KEY),
    );
    expect(res.statusCode).toBe(201);
  });
});

//  getTransaction

describe("getTransaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.API_KEY = "";
  });

  test("returns 200 with the transaction when found", async () => {
    const stored = {
      id: "tx-1",
      amount: 100,
      currency: "USD",
      reference: "REF-001",
      status: "COMPLETED",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    };
    mockDdbSend.mockResolvedValueOnce({ Item: stored });

    const res: any = await getHandler(makeGetEvent("tx-1"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(stored);
  });

  test("returns 404 when transaction is not found", async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });
    const res: any = await getHandler(makeGetEvent("nonexistent"));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("NotFound");
  });

  test("returns 400 when id is missing", async () => {
    const res: any = await getHandler({ pathParameters: {}, headers: {} });
    expect(res.statusCode).toBe(400);
  });

  test("returns 500 when DynamoDB throws", async () => {
    mockDdbSend.mockRejectedValueOnce(new Error("DDB failure"));
    const res: any = await getHandler(makeGetEvent("tx-err"));
    expect(res.statusCode).toBe(500);
  });

  // ── API-key enforcement tests ─────────────────────────────────────────────

  test("returns 401 when API_KEY is set and header is missing", async () => {
    process.env.API_KEY = VALID_API_KEY;
    const res: any = await getHandler(makeGetEvent("tx-1"));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("Unauthorized");
  });

  test("returns 200 when API_KEY is set and correct key is provided", async () => {
    process.env.API_KEY = VALID_API_KEY;
    const stored = { id: "tx-1", status: "PENDING" };
    mockDdbSend.mockResolvedValueOnce({ Item: stored });
    const res: any = await getHandler(makeGetEvent("tx-1", VALID_API_KEY));
    expect(res.statusCode).toBe(200);
  });
});

//  processTransaction

describe("processTransaction", () => {
  let sharedMod: any;

  beforeAll(async () => {
    // Grab the mocked shared module so we can restore writeAuditEntry after clearAllMocks
    sharedMod = await import("../src/shared.js");
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks wipes mockResolvedValue; restore it so writeAuditEntry returns a Promise
    sharedMod.writeAuditEntry.mockResolvedValue(undefined);
  });

  test("transitions PENDING to final status for a happy-path transaction", async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { id: "tx-1", status: "PENDING" } })
      .mockResolvedValueOnce({})   // PENDING→PROCESSING transition
      .mockResolvedValueOnce({});  // PROCESSING→COMPLETED transition

    const result: any = await processHandler(makeSQSEvent("tx-1"));
    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockDdbSend).toHaveBeenCalledTimes(3); // Get + 2 UpdateCommands (writeAuditEntry is mocked)
  });

  test("skips processing when transaction is already COMPLETED (idempotency)", async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: { id: "tx-2", status: "COMPLETED" } });

    const result: any = await processHandler(makeSQSEvent("tx-2"));
    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  test("skips processing when transaction does not exist", async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });

    const result: any = await processHandler(makeSQSEvent("ghost-tx"));
    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  test("reports batch item failure when an unhandled DDB error occurs", async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { id: "tx-3", status: "PENDING" } })
      .mockRejectedValueOnce(new Error("network failure"));

    const result: any = await processHandler(makeSQSEvent("tx-3"));
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe("msg-001");
  });

  test("handles malformed SQS message body without crashing", async () => {
    const event = { Records: [{ messageId: "bad-msg", body: "{{invalid-json}}" }] } as any;

    const result: any = await processHandler(event);
    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  test("handles ConditionalCheckFailedException on PENDING to PROCESSING gracefully", async () => {
    const ccfError = new Error("Condition failed");
    ccfError.name = "ConditionalCheckFailedException";

    mockDdbSend
      .mockResolvedValueOnce({ Item: { id: "tx-4", status: "PENDING" } })
      .mockRejectedValueOnce(ccfError);

    const result: any = await processHandler(makeSQSEvent("tx-4"));
    expect(result.batchItemFailures).toHaveLength(0);
  });
});
