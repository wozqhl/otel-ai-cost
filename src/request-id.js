/** Resolve X-Request-Id: accept incoming or generate UUID. Echo on every response. */

import { randomUUID } from "node:crypto";

export const REQUEST_ID_HEADER = "x-request-id";
export const REQUEST_ID_MAX_LEN = 128;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function generateRequestId() {
  return randomUUID();
}

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Sanitize a client-supplied request id.
 * Strips CR/LF/NUL, trims, caps length. Empty → null (caller generates).
 */
export function sanitizeRequestId(raw) {
  if (raw == null || raw === "") return null;
  let s = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw);
  s = s.replace(/[\r\n\0]/g, "").trim();
  if (!s) return null;
  if (s.length > REQUEST_ID_MAX_LEN) s = s.slice(0, REQUEST_ID_MAX_LEN);
  return s;
}

/** Incoming X-Request-Id or a generated UUID. */
export function resolveRequestId(req) {
  const incoming = sanitizeRequestId(req?.headers?.[REQUEST_ID_HEADER]);
  return incoming || generateRequestId();
}

export function requestIdHeader(requestId) {
  return { [REQUEST_ID_HEADER]: requestId };
}
