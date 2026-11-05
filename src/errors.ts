import type { Scope } from "./types.js";

export class PlyryApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requiredScope?: Scope;
  readonly body: Readonly<Record<string, unknown>> | null;

  constructor(
    status: number,
    code: string,
    message: string,
    body: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "PlyryApiError";
    this.status = status;
    this.code = code;
    const safeBody = body ? redactSecrets(body) : null;
    this.requiredScope = typeof safeBody?.required_scope === "string" && isScope(safeBody.required_scope)
      ? safeBody.required_scope
      : undefined;
    this.body = safeBody ? Object.freeze(safeBody) : null;
  }

  static fromResponse(status: number, statusText: string, value: unknown): PlyryApiError {
    const parsed = isRecord(value) ? value : null;
    const code = typeof parsed?.error === "string" ? parsed.error : "http_error";
    const message = typeof parsed?.message === "string"
      ? parsed.message
      : `${status} ${statusText || "Plyry API request failed"}`;
    return new PlyryApiError(status, code, message, parsed);
  }
}

export class PlyrySessionChangedError extends Error {
  constructor() {
    super("The Plyry session changed while this request was in progress.");
    this.name = "PlyrySessionChangedError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactSecrets(value: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|password|passphrase|client[_-]?secret|secret|payment[_-]?method[_-]?id)$/i.test(key)) continue;
    redacted[key] = sanitizeValue(item);
  }
  return redacted;
}

function isScope(value: string): value is Scope {
  return [
    "account:read",
    "generation:create",
    "generation:read",
    "wallet:read",
    "wallet:topup",
    "conversion:create",
    "conversion:read",
  ].includes(value);
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  return isRecord(value) ? redactSecrets(value) : value;
}
