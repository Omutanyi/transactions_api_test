# Transaction Service (SAM + LocalStack)

A fully serverless transaction processing service built with **AWS SAM**, running locally on **LocalStack** via Docker. Implements a complete transaction lifecycle with asynchronous background processing, an immutable audit trail, and API key authentication.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [AWS Resources Provisioned](#aws-resources-provisioned)
- [Transaction Lifecycle](#transaction-lifecycle)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
- [Data Models](#data-models)
- [Error Handling](#error-handling)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Running Unit Tests](#running-unit-tests)
- [Tear Down](#tear-down)
- [LocalStack & SAM Notes](#localstack--sam-notes)
- [Design Decisions](#design-decisions)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        LocalStack (port 4566)                       │
│                                                                     │
│  Client ──► API Gateway (/local stage)                              │
│                   │                                                 │
│         ┌─────────┼──────────────┐                                  │
│         ▼         ▼              ▼                                  │
│   HealthCheck  CreateTx       GetTx                                 │
│   Lambda       Lambda         Lambda                                │
│                   │                │                                │
│                   ▼                ▼                                │
│              DynamoDB         DynamoDB                              │
│          (transactions)    (transactions)                           │
│                   │                                                 │
│                   ▼                                                 │
│               SQS Queue                                             │
│           (transaction-queue)                                       │
│                   │                                                 │
│                   ▼                                                 │
│           ProcessTransaction                                        │
│              Lambda (SQS trigger)                                   │
│                   │                                                 │
│          ┌────────┴────────┐                                        │
│          ▼                 ▼                                        │
│      DynamoDB          DynamoDB                                     │
│   (transactions)  (transaction-audit)                               │
│                                                                     │
│           SQS DLQ (transaction-dlq) ◄── failed messages            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## AWS Resources Provisioned

| Resource | Name / ID | Purpose |
|---|---|---|
| **API Gateway** | `Api` (stage: `local`) | REST API entry point with API key enforcement, throttling, and CORS |
| **Lambda** | `HealthCheckFunction` | `GET /health` — public liveness probe |
| **Lambda** | `CreateTransactionFunction` | `POST /transactions` — validates input, persists to DynamoDB, enqueues SQS message |
| **Lambda** | `GetTransactionFunction` | `GET /transactions/{id}` — retrieves current transaction state |
| **Lambda** | `ProcessTransactionFunction` | SQS-triggered background processor, drives the transaction state machine |
| **DynamoDB** | `transactions` | Primary transaction store (hash key: `id`) |
| **DynamoDB** | `transaction-audit` | Immutable audit log (hash: `transactionId`, sort: `auditId`) |
| **SQS** | `transaction-queue` | Decouples creation from processing; 3× retry before DLQ |
| **SQS** | `transaction-dlq` | Dead-letter queue for unprocessable messages (14-day retention) |

### API Gateway configuration

- All routes require `x-api-key` header **except** `GET /health`
- Usage plan: **10 000 requests/day**, burst **200 RPS**, rate **100 RPS**
- CORS enabled for `GET`, `POST`, `OPTIONS`

---

## Transaction Lifecycle

```
POST /transactions
       │
       ▼
   [PENDING] ──► SQS message published
       │
       │  (ProcessTransaction Lambda consumes SQS message)
       ▼
  [PROCESSING]
       │
       ├─ 90% success ──► [COMPLETED]
       └─ 10% failure ──► [FAILED]  (failureReason recorded)
```

Each status transition is:
1. Written atomically to DynamoDB via a **conditional update** (`ConditionExpression: #s = :from`), preventing race conditions in concurrent Lambda invocations.
2. Recorded as an immutable entry in the **`transaction-audit`** table.

**Audit actions emitted:**

| Action | Trigger |
|---|---|
| `TRANSACTION_CREATED` | `POST /transactions` succeeds |
| `TRANSACTION_PROCESSING_STARTED` | PENDING → PROCESSING |
| `TRANSACTION_COMPLETED` | PROCESSING → COMPLETED |
| `TRANSACTION_FAILED` | PROCESSING → FAILED |

---

## Project Structure

```
.
├── template.yaml               # SAM / CloudFormation IaC definition
├── docker-compose.yml          # LocalStack + SAM build/deploy container
├── package.json                # Node.js dependencies (ESM, TypeScript)
├── tsconfig.json
├── jest.config.js
├── scripts/
│   ├── deploy.sh               # sam build + sam deploy (LocalStack)
│   └── destroy.sh              # Tears down the CloudFormation stack
├── src/
│   ├── healthCheck.ts          # GET /health handler
│   ├── createTransaction.ts    # POST /transactions handler
│   ├── getTransaction.ts       # GET /transactions/{id} handler
│   ├── processTransaction.ts   # SQS consumer — state machine driver
│   ├── shared.ts               # AWS clients, types, helpers (json, errorResponse, audit)
│   ├── errors.ts               # Typed AppError hierarchy (400/401/404/409/500)
│   └── logger.ts               # Structured JSON logger
├── tests/
│   ├── handlers.test.ts        # Jest unit tests
│   └── __stubs__/              # Manual mocks for AWS SDK + uuid
└── __mocks__/
    └── @aws-sdk/               # Module-level AWS SDK mock shims
```

---

## API Reference

> **Base URL (local):** printed by the deploy script as `$API_BASE`
> e.g. `http://localhost:4566/restapis/<api-id>/local/_user_request_`

All protected endpoints require:
```
x-api-key: Mf7SLwQH7fEhEfdPXb0FehIo
```

---

### `GET /health`

Public. Returns service liveness.

```bash
curl "$API_BASE/health"
```

**Response `200`**
```json
{ "status": "ok" }
```

---

### `POST /transactions`

Creates a new transaction and enqueues it for background processing.

```bash
curl -X POST "$API_BASE/transactions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: Mf7SLwQH7fEhEfdPXb0FehIo" \
  -d '{"amount": 100, "currency": "USD", "reference": "INV-001"}'
```

**Request body**

| Field | Type | Rules |
|---|---|---|
| `amount` | `number` | Required, positive |
| `currency` | `string` | Required, 3-letter ISO 4217 (e.g. `USD`) |
| `reference` | `string` | Required, non-empty |
| `metadata` | `object` | Optional, free-form key-value pairs |

**Response `201`**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "amount": 100,
  "currency": "USD",
  "reference": "INV-001",
  "status": "PENDING",
  "createdAt": "2026-03-13T10:00:00.000Z",
  "updatedAt": "2026-03-13T10:00:00.000Z"
}
```

---

### `GET /transactions/{id}`

Retrieves the current state of a transaction (reflects live DynamoDB status).

```bash
curl "$API_BASE/transactions/550e8400-e29b-41d4-a716-446655440000" \
  -H "x-api-key: Mf7SLwQH7fEhEfdPXb0FehIo"
```

**Response `200`**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "amount": 100,
  "currency": "USD",
  "reference": "INV-001",
  "status": "COMPLETED",
  "createdAt": "2026-03-13T10:00:00.000Z",
  "updatedAt": "2026-03-13T10:00:01.234Z"
}
```

A `FAILED` transaction additionally includes:
```json
{ "failureReason": "Payment processor declined the transaction." }
```

---

## Data Models

### Transaction (`transactions` table)

| Field | Type | Description |
|---|---|---|
| `id` | `string` (UUID) | Partition key |
| `amount` | `number` | Transaction amount |
| `currency` | `string` | 3-letter currency code |
| `reference` | `string` | External reference / invoice number |
| `status` | `PENDING \| PROCESSING \| COMPLETED \| FAILED` | Current lifecycle state |
| `createdAt` | ISO 8601 string | Creation timestamp |
| `updatedAt` | ISO 8601 string | Last state-change timestamp |
| `failureReason` | `string` (optional) | Set when status is `FAILED` |

### Audit Entry (`transaction-audit` table)

| Field | Type | Description |
|---|---|---|
| `transactionId` | `string` | Partition key — links to transaction |
| `auditId` | `string` | Sort key — ISO timestamp + random hex suffix |
| `action` | `AuditAction` | Event type (see lifecycle section) |
| `timestamp` | ISO 8601 string | When the event occurred |
| `snapshot` | `object` | Relevant field values at event time |
| `actor` | `string` | Source (`api:<requestId>` or `sqs:<messageId>`) |

---

## Error Handling

All errors are returned as structured JSON:

```json
{
  "code": "ValidationError",
  "message": "Request body failed validation.",
  "details": [
    { "field": "currency", "message": "currency must be a 3-letter ISO 4217 code (e.g. USD)" }
  ]
}
```

| HTTP Status | Error Code | When |
|---|---|---|
| `400` | `InvalidJSON` | Body is not parseable JSON |
| `400` | `ValidationError` | Zod schema violation |
| `401` | `Unauthorized` | Missing or invalid `x-api-key` |
| `404` | `NotFound` | Transaction ID does not exist |
| `409` | `Conflict` | DynamoDB condition check failed on create |
| `500` | `InternalError` | Unhandled exceptions |

---

## Prerequisites

- **Docker** and **Docker Compose** (v2+)
- No local Node.js, AWS CLI, or SAM CLI installation required — everything runs inside containers.

---

## Quick Start

```bash
# 1. Start LocalStack
docker compose up -d localstack

# 2. Build and deploy the SAM stack (prints $API_BASE on completion)
docker compose run --rm deploy
```

> The deploy script runs `sam build` (esbuild, Node.js 20) followed by `sam deploy --guided` targeting the LocalStack endpoint (`http://localstack:4566`).

### Verify deployment

```bash
# Health check (no API key required)
curl "$API_BASE/health"

# Create a transaction
curl -X POST "$API_BASE/transactions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: Mf7SLwQH7fEhEfdPXb0FehIo" \
  -d '{"amount": 250, "currency": "NGN", "reference": "YC-2026-001"}'

# Poll transaction status (replace <id> with the returned id)
curl "$API_BASE/transactions/<id>" \
  -H "x-api-key: Mf7SLwQH7fEhEfdPXb0FehIo"
```

---

## Running Unit Tests

Tests use **Jest** with ESM support. AWS SDK calls are fully mocked via manual stubs under `tests/__stubs__/`.

```bash
# Inside the deploy container (no local Node.js needed)
docker compose run --rm deploy npm test

# OR locally if Node.js 20+ is available
npm test
```

---

## Tear Down

```bash
docker compose run --rm deploy ./scripts/destroy.sh
```

This deletes the CloudFormation stack from LocalStack, removing all provisioned resources.

---

## LocalStack & SAM Notes

| Aspect | Detail |
|---|---|
| **LocalStack image** | `localstack/localstack:3` |
| **Services enabled** | `cloudformation`, `apigateway`, `lambda`, `dynamodb`, `s3`, `iam`, `logs`, `sts`, `sqs` |
| **LocalStack port** | `4566` (all services multiplexed) |
| **SAM build image** | `public.ecr.aws/sam/build-nodejs20.x` |
| **Lambda runtime** | `nodejs20.x` |
| **Bundler** | `esbuild` (target `es2022`, source maps enabled) |
| **AWS region** | `us-east-1` (dummy credentials: `test` / `test`) |
| **API stage** | `local` |
| **Endpoint URL** | `http://localhost:4566/restapis/<api-id>/local/_user_request_` |

AWS clients in `shared.ts` read `AWS_ENDPOINT_URL` from the environment. In Docker Compose this is set to `http://localstack:4566`; when running unit tests locally it is left unset and the mocks intercept all calls before any real network I/O occurs.

---

## Design Decisions

- **Async processing via SQS** — Decouples transaction creation from processing, enabling independent scaling and natural retry/DLQ behaviour without any custom retry logic.
- **Conditional DynamoDB updates** — `ConditionExpression: #s = :from` ensures status transitions are atomic and idempotent, protecting against duplicate SQS deliveries and concurrent Lambda invocations.
- **Immutable audit table** — A separate DynamoDB table (`transaction-audit`) stores every status change with a timestamp-based sort key, providing a tamper-evident audit trail without modifying the main record.
- **API key validation in Lambda** — The `x-api-key` is validated inside each handler (via `requireApiKey`) rather than relying solely on API Gateway, giving consistent 401 responses and making the behaviour testable in unit tests.
- **Zod schema validation** — All incoming request bodies are parsed and validated with Zod before any business logic runs, producing structured, field-level error messages.
- **Typed error hierarchy** — `AppError` subclasses (`ValidationError`, `NotFoundError`, `UnauthorizedError`, etc.) carry both an HTTP status code and a machine-readable `code` string, keeping error serialisation consistent across all handlers.
- **Lazy AWS client singletons** — Clients are instantiated on first use so that Jest mocks registered before any `import` side-effects are guaranteed to intercept all SDK calls.
