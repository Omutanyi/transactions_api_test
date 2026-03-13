/**
 * Typed application error hierarchy.
 *
 * All errors that should produce a specific HTTP status code extend AppError.
 * Unhandled/unexpected errors should remain plain Error instances and map to 500.
 */

export type ErrorCode =
  | "InvalidJSON"
  | "ValidationError"
  | "Unauthorized"
  | "Forbidden"
  | "NotFound"
  | "Conflict"
  | "InternalError";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number,
    /** Optional structured details (e.g. Zod field errors) */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("ValidationError", message, 400, details);
    this.name = "ValidationError";
  }
}

export class InvalidJSONError extends AppError {
  constructor() {
    super("InvalidJSON", "Request body is not valid JSON.", 400);
    this.name = "InvalidJSONError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Missing or invalid API key.") {
    super("Unauthorized", message, 401);
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super("NotFound", `${resource} not found.`, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super("Conflict", message, 409);
    this.name = "ConflictError";
  }
}
