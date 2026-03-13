/**
 * Unit tests for all Lambda handlers.
 *
 * All AWS SDK calls are mocked so no real DynamoDB / SQS is required.
 * Uses jest.unstable_mockModule (required for ESM + ts-jest).
 */

//  Shared mock functions 

const mockDdbSend = jest.fn();
const mockSqsSend = jest.fn();

//  Mock AWS SDK modules (ESM-compatible) 

(jest as any).unstable_mockModule("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

(jest as any).unstable_mockModule("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: jest.fn().mockReturnValue({ send: mockDdbSend }),
  },
  PutCommand:    jest.fn().mockImplementation((input: unknown) => ({ input })),
  GetCommand:    jest.fn().mockImplementation((input: unknown) => ({ input })),
  UpdateCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

(jest as any).unstable_mockModule("@aws-sdk/client-sqs", () => ({
  SQSClient:          jest.fn().mockImplementation(() => ({ send: mockSqsSend })),
  SendMessageCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

(jest as any).unstable_mockModule("uuid", () => ({
  v4: jest.fn().mockReturnValue("mock-uuid-1234"),
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

function makeCreateEvent(body: unknown) {
  return { body: JSON.stringify(body) } as any;
}

function makeGetEvent(id: string) {
  return { pathParameters: { id } } as any;
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
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});

//  createTransaction 

describe("createTransaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDdbSend.mockResolvedValue({});
    mockSqsSend.mockResolvedValue({});
    process.env.QUEUE_URL = "http://sqs.us-east-1.localhost:4566/000000000000/transaction-queue";
  });

  test("returns 201 with PENDING transaction for valid input", async () => {
    const res: any = await createHandler(
      makeCreateEvent({ amount: 100, currency: "USD", reference: "REF-001" })
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
      makeCreateEvent({ amount: 50.5, currency: "EUR", reference: "REF-002" })
    );
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    const sqsCallArg = mockSqsSend.mock.calls[0][0];
    expect(sqsCallArg.input.MessageBody).toContain("mock-uuid-1234");
  });

  test("returns 400 for missing amount", async () => {
    const res: any = await createHandler(
      makeCreateEvent({ currency: "USD", reference: "REF-003" })
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("ValidationError");
  });

  test("returns 400 for non-positive amount", async () => {
    const res: any = await createHandler(
      makeCreateEvent({ amount: -10, currency: "USD", reference: "REF-004" })
    );
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 for invalid currency format (lowercase)", async () => {
    const res: any = await createHandler(
      makeCreateEvent({ amount: 100, currency: "us", reference: "REF-005" })
    );
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 for empty reference", async () => {
    const res: any = await createHandler(
      makeCreateEvent({ amount: 100, currency: "USD", reference: "   " })
    );
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 for invalid JSON body", async () => {
    const res: any = await createHandler({ body: "not-json{" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("InvalidJSON");
  });

  test("returns 500 when DynamoDB throws", async () => {
    mockDdbSend.mockRejectedValueOnce(new Error("DDB failure"));
    const res: any = await createHandler(
      makeCreateEvent({ amount: 100, currency: "USD", reference: "REF-006" })
    );
    expect(res.statusCode).toBe(500);
  });

  test("does not call SQS if QUEUE_URL is empty", async () => {
    process.env.QUEUE_URL = "";
    const res: any = await createHandler(
      makeCreateEvent({ amount: 100, currency: "GBP", reference: "REF-007" })
    );
    expect(res.statusCode).toBe(201);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });
});

//  getTransaction 

describe("getTransaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    const res: any = await getHandler({ pathParameters: {} });
    expect(res.statusCode).toBe(400);
  });

  test("returns 500 when DynamoDB throws", async () => {
    mockDdbSend.mockRejectedValueOnce(new Error("DDB failure"));
    const res: any = await getHandler(makeGetEvent("tx-err"));
    expect(res.statusCode).toBe(500);
  });
});

//  processTransaction 

describe("processTransaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("transitions PENDING to final status for a happy-path transaction", async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { id: "tx-1", status: "PENDING" } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result: any = await processHandler(makeSQSEvent("tx-1"));
    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockDdbSend).toHaveBeenCalledTimes(3);
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
