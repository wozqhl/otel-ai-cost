/** Optional budget-breach webhook (fire-and-forget; stdlib fetch).
 *
 * OSS: best-effort POST when report --budget / check-budget exceeds limits,
 * or when HTTP ingest denies a span because the tenant is already over budget
 * (once per denied request).
 * Optional simple HMAC-SHA256 (`--webhook-secret` / OTEL_AI_COST_WEBHOOK_SECRET)
 * → `X-Webhook-Signature: sha256=<hex>` of the raw JSON body.
 * Always sends `X-Webhook-Timestamp: <unix-seconds>` (HMAC still body-only).
 * OSS: one retry after ~50ms on 5xx or network/timeout (first-try success
 * = no retry; 4xx do not retry). Exponential backoff / queues = paid.
 * Key rotation / timestamp replay window enforcement = paid later.
 */

import crypto from "node:crypto";

export const ENV_WEBHOOK_URL = "OTEL_AI_COST_WEBHOOK_URL";
export const ENV_WEBHOOK_SECRET = "OTEL_AI_COST_WEBHOOK_SECRET";
export const DEFAULT_TIMEOUT_MS = 750;
/** OSS: one retry after this delay on 5xx / network / timeout. */
export const DEFAULT_RETRY_DELAY_MS = 50;
export const USER_AGENT = "otel-ai-cost-webhook/0.1.0";
/** Outbound HMAC header when --webhook-secret / env is set. */
export const SIGNATURE_HEADER = "X-Webhook-Signature";
/** Unix-seconds timestamp on every outbound POST (HMAC still signs body only). */
export const TIMESTAMP_HEADER = "X-Webhook-Timestamp";

/** Floor unix seconds. Optional nowMs for tests. */
export function webhookUnixSeconds(nowMs = Date.now()) {
  const n = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  return Math.floor(n / 1000);
}

function trimSecret(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s || null;
}

/** Trim; empty → null (disabled). */
export function parseWebhookUrl(raw) {
  if (raw == null) return null;
  const url = String(raw).trim();
  return url || null;
}

/**
 * CLI `--webhook-url` wins when provided (including empty → disable);
 * otherwise env OTEL_AI_COST_WEBHOOK_URL.
 */
export function resolveWebhookUrl(cliValue, env = process.env) {
  if (cliValue !== null && cliValue !== undefined) {
    return parseWebhookUrl(cliValue);
  }
  const environ = env && typeof env === "object" ? env : {};
  return parseWebhookUrl(environ[ENV_WEBHOOK_URL] || "");
}

/** Trim; empty → null (unsigned). */
export function parseWebhookSecret(raw) {
  return trimSecret(raw);
}

/**
 * CLI `--webhook-secret` wins when provided (including empty → unsigned);
 * otherwise env OTEL_AI_COST_WEBHOOK_SECRET.
 */
export function resolveWebhookSecret(cliValue, env = process.env) {
  if (cliValue !== null && cliValue !== undefined) {
    return parseWebhookSecret(cliValue);
  }
  const environ = env && typeof env === "object" ? env : {};
  return parseWebhookSecret(environ[ENV_WEBHOOK_SECRET] || "");
}

/** HMAC-SHA256 of the raw POST body → `sha256=<hex>`. */
export function signWebhookBody(secret, rawBody) {
  const key = String(secret);
  const raw = typeof rawBody === "string" ? rawBody : String(rawBody ?? "");
  const hex = crypto.createHmac("sha256", key).update(raw, "utf8").digest("hex");
  return `sha256=${hex}`;
}

/**
 * Timing-safe check of `X-Webhook-Signature: sha256=<hex>` vs raw body.
 * Hex compared case-insensitively. Missing/empty secret or header → false.
 */
export function verifyWebhookSignature(secret, rawBody, headerValue) {
  const key = trimSecret(secret);
  if (!key) return false;
  const got = String(headerValue || "").trim();
  if (!got) return false;
  const expected = signWebhookBody(key, rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got.toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Outbound body on breach only: {ok:false, breaches, totalUsd} (+ tenant when set).
 * Ingest deny also adds spend, budget, denied. Never tokens or prompt text.
 */
export function buildWebhookPayload(check) {
  const breaches = Array.isArray(check?.breaches) ? check.breaches : [];
  const totalUsd =
    typeof check?.totalUsd === "number" && Number.isFinite(check.totalUsd)
      ? check.totalUsd
      : Number(check?.totalUsd) || 0;
  const payload = {
    ok: false,
    breaches,
    totalUsd,
  };
  if (check?.tenant != null && String(check.tenant).trim() !== "") {
    payload.tenant = String(check.tenant);
  }
  if (check?.spend != null && Number.isFinite(Number(check.spend))) {
    payload.spend = Number(check.spend);
  }
  if (check?.budget != null && Number.isFinite(Number(check.budget))) {
    payload.budget = Number(check.budget);
  }
  if (check?.denied != null && Number.isFinite(Number(check.denied))) {
    payload.denied = Math.floor(Number(check.denied));
  }
  return payload;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OSS retry policy: 5xx or thrown network/timeout → retry once.
 * 2xx / 4xx → no retry. Exponential backoff / queues = paid.
 */
export function shouldRetryWebhook({ status, error } = {}) {
  if (error) return true;
  const n = Number(status);
  return Number.isFinite(n) && n >= 500 && n <= 599;
}

async function postJson(url, body, timeoutMs, secret, fetchFn) {
  const ctrl = new AbortController();
  const ms =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const headers = {
      "content-type": "application/json; charset=utf-8",
      accept: "application/json",
      "user-agent": USER_AGENT,
    };
    headers[TIMESTAMP_HEADER] = String(webhookUnixSeconds());
    const key = trimSecret(secret);
    if (key) headers[SIGNATURE_HEADER] = signWebhookBody(key, body);
    const doFetch = typeof fetchFn === "function" ? fetchFn : fetch;
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
    });
    const status = res && typeof res.status === "number" ? res.status : 0;
    return { status };
  } finally {
    clearTimeout(timer);
  }
}

async function postWithRetry(url, body, timeoutMs, secret, opts = {}) {
  const fetchFn = opts.fetchFn;
  const sleepFn = typeof opts.sleepFn === "function" ? opts.sleepFn : defaultSleep;
  const retryDelayMs =
    typeof opts.retryDelayMs === "number" && Number.isFinite(opts.retryDelayMs) && opts.retryDelayMs >= 0
      ? Math.floor(opts.retryDelayMs)
      : DEFAULT_RETRY_DELAY_MS;

  let firstErr = null;
  try {
    const first = await postJson(url, body, timeoutMs, secret, fetchFn);
    if (!shouldRetryWebhook({ status: first.status })) return first;
  } catch (err) {
    firstErr = err;
    if (!shouldRetryWebhook({ error: err })) throw err;
  }

  await sleepFn(retryDelayMs);
  try {
    return await postJson(url, body, timeoutMs, secret, fetchFn);
  } catch (err) {
    if (firstErr) throw firstErr;
    throw err;
  }
}

/**
 * POST JSON when check.ok === false. Await the short-timeout attempt so a
 * CLI process.exit does not kill the request; errors are swallowed.
 * Never throws. Returns true if a POST was attempted without throwing.
 * Always sends X-Webhook-Timestamp: <unix-seconds> (fresh on every attempt).
 * When `secret` is set, POST includes X-Webhook-Signature HMAC of the raw
 * body (body only). OSS retries once after ~50ms on 5xx or network/timeout
 * (success on first try = no retry; 4xx do not retry). Exponential backoff /
 * queues, key rotation, and timestamp replay window enforcement = paid later.
 */
export async function notifyBudgetBreach(
  url,
  check,
  { timeoutMs = DEFAULT_TIMEOUT_MS, secret = null, fetchFn, sleepFn, retryDelayMs } = {}
) {
  try {
    if (!url || !check || check.ok) return false;
    const payload = buildWebhookPayload(check);
    await postWithRetry(url, JSON.stringify(payload), timeoutMs, secret, {
      fetchFn,
      sleepFn,
      retryDelayMs,
    });
    return true;
  } catch {
    return false;
  }
}
