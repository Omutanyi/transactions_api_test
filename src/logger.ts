/**
 * Structured JSON logger.
 *
 * Every log line is a newline-delimited JSON object that CloudWatch Logs
 * Insights (and any log aggregator) can index and query directly.
 *
 * Usage:
 *   import { createLogger } from "./logger";
 *   const log = createLogger({ service: "createTransaction" });
 *   log.info("TransactionCreated", { transactionId: tx.id });
 *   log.error("DynamoDB write failed", { transactionId: tx.id }, err);
 */

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogContext {
  /** The Lambda / service name producing the log */
  service: string;
  /** Optional correlation/request ID propagated from API Gateway */
  requestId?: string;
  /** Any extra static fields you want on every line */
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>, err?: unknown): void;
  /** Returns a child logger with additional static context merged in */
  child(ctx: Record<string, unknown>): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

function resolveMinLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
  return (raw in LEVEL_ORDER ? (raw as LogLevel) : "INFO");
}

function serializeError(err: unknown): Record<string, unknown> | undefined {
  if (!err) return undefined;
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return { raw: String(err) };
}

function buildLogger(baseCtx: LogContext): Logger {
  const minLevel = resolveMinLevel();

  function write(
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
    err?: unknown,
  ): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...baseCtx,
      ...extra,
    };

    if (err !== undefined) {
      entry.error = serializeError(err);
    }

    // Use the appropriate console method so CloudWatch shows the right colour
    const line = JSON.stringify(entry);
    switch (level) {
      case "DEBUG": console.debug(line); break;
      case "INFO":  console.info(line);  break;
      case "WARN":  console.warn(line);  break;
      case "ERROR": console.error(line); break;
    }
  }

  return {
    debug: (msg, extra) => write("DEBUG", msg, extra),
    info:  (msg, extra) => write("INFO",  msg, extra),
    warn:  (msg, extra) => write("WARN",  msg, extra),
    error: (msg, extra, err) => write("ERROR", msg, extra, err),
    child: (ctx) => buildLogger({ ...baseCtx, ...ctx }),
  };
}

export function createLogger(ctx: LogContext): Logger {
  return buildLogger(ctx);
}
