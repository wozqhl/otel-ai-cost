/** Redacted public runtime config for GET /v1/config.
 *
 * Mirrors B GET /admin/config and C/F GET /v1/config allowlist — E serve is
 * public like /v1/budgets / /v1/models, so the payload must be strictly
 * non-secret. Knobs only (not spend). Never copy env/CLI/webhook/prices wholesale.
 */

import { parseWebhookSecret, parseWebhookUrl } from "./webhook.js";
import { DEFAULT_RATE_LIMIT_PER_MINUTE } from "./rate-limit.js";

/** Same default as serve.js DEFAULT_SPAN_MAX (do not import serve — circular). */
export const DEFAULT_SPAN_CAP = 50000;

/** JSON *keys* that must never appear (case-insensitive exact). hasSecret /
 * hasUrl are different keys and are allowed.
 */
export const FORBIDDEN_RUNTIME_CONFIG_KEYS = [
  "webhookUrl",
  "webhook_url",
  "webhookSecret",
  "webhook_secret",
  "OTEL_AI_COST_WEBHOOK_URL",
  "OTEL_AI_COST_WEBHOOK_SECRET",
  "secret",
  "token",
  "Authorization",
  "authorization",
  "apiKey",
  "adminToken",
  "Bearer",
  "ingestToken",
  "INGEST_TOKEN",
  "prices",
  "models",
];

const FORBIDDEN_KEY_SET = new Set(FORBIDDEN_RUNTIME_CONFIG_KEYS.map((k) => k.toLowerCase()));

/** Fixture / shape needles that must be absent from the JSON dump (smoke).
 * Do not use short substrings that match allowlisted keys (e.g. "Secret" vs hasSecret).
 */
export const RUNTIME_CONFIG_SECRET_NEEDLES = [
  "whsec_must_not_leak",
  "planted_url_token",
  "http_url_token_must_not_leak",
  "http_whsec_must_not_leak",
  "sk-",
  "Bearer ",
  "webhookUrl",
  "webhookSecret",
  "webhook_url",
  "webhook_secret",
  "Authorization",
  "INGEST_TOKEN",
  "ingestToken",
];

function corsOrigins(cors, corsOriginsList) {
  if (Array.isArray(corsOriginsList)) {
    return corsOriginsList.map((o) => String(o).trim()).filter(Boolean);
  }
  if (!cors || typeof cors !== "object") return [];
  if (cors.allowAny || cors.allow_any) return ["*"];
  const raw = cors.origins;
  if (Array.isArray(raw)) return raw.map((o) => String(o).trim()).filter(Boolean);
  return [];
}


function resolveSpanCap(raw) {
  if (raw == null || raw === "") return DEFAULT_SPAN_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SPAN_CAP;
  return Math.floor(n);
}

function packName(pack) {
  if (pack == null || pack === "") return null;
  if (typeof pack === "object" && !Array.isArray(pack)) {
    const n = pack.name != null ? String(pack.name).trim() : "";
    return n || null;
  }
  const s = String(pack).trim();
  return s || null;
}

function hasGlobal(budget) {
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) return false;
  if (budget.maxTotalUsd == null || budget.maxTotalUsd === "") return false;
  return Number.isFinite(Number(budget.maxTotalUsd));
}

function tenantCount(tenantBudgets) {
  if (!tenantBudgets || typeof tenantBudgets !== "object" || Array.isArray(tenantBudgets)) return 0;
  return Object.keys(tenantBudgets).filter((k) => String(k).trim()).length;
}

function rateLimitPerMinute(rateLimit) {
  if (rateLimit === undefined) return DEFAULT_RATE_LIMIT_PER_MINUTE;
  if (rateLimit == null || rateLimit === "") return null;
  const n = Number(rateLimit);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/** Walk JSON keys; return paths whose names are forbidden. */
export function collectForbiddenRuntimeConfigKeys(value, path = "$") {
  const hits = [];
  function walk(v, p) {
    if (v == null) return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${p}[${i}]`));
      return;
    }
    if (typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        if (FORBIDDEN_KEY_SET.has(String(k).toLowerCase())) hits.push(`${p}.${k}`);
        walk(child, `${p}.${k}`);
      }
    }
  }
  walk(value, path);
  return hits;
}

export function runtimeConfigLeakNeedles(payload) {
  const dump = JSON.stringify(payload);
  return RUNTIME_CONFIG_SECRET_NEEDLES.filter((n) => dump.includes(n));
}

/** True when payload has no forbidden keys and no secret needles. */
export function assertRuntimeConfigSafe(payload) {
  const keys = collectForbiddenRuntimeConfigKeys(payload);
  const leaks = runtimeConfigLeakNeedles(payload);
  return { ok: keys.length === 0 && leaks.length === 0, keys, leaks };
}

/**
 * Allowlist-only public snapshot. Never spreads env, CORS, webhook, or prices.
 *
 * Returns camelCase keys: spanCap/spansMax, rateLimit.perMinute, cors.origins,
 * pack, hasGlobalBudget, tenantBudgetCount, webhooks.hasUrl/hasSecret.
 * Dollar amounts stay on GET /v1/budgets. Price table stays on GET /v1/models.
 * Webhook URL is never included (query tokens). Secrets are never included.
 */
export function summarizeRuntimeConfig({
  spanMax,
  rateLimit,
  cors,
  corsOrigins: corsOriginsList,
  pack = null,
  budget = null,
  tenantBudgets = null,
  webhookUrl = null,
  webhookSecret = null,
} = {}) {
  const cap = resolveSpanCap(spanMax);
  const url = parseWebhookUrl(webhookUrl);
  const secret = parseWebhookSecret(webhookSecret);
  return {
    ok: true,
    spanCap: cap,
    spansMax: cap,
    rateLimit: { perMinute: rateLimitPerMinute(rateLimit) },
    cors: { origins: corsOrigins(cors, corsOriginsList) },
    pack: packName(pack),
    hasGlobalBudget: hasGlobal(budget),
    tenantBudgetCount: tenantCount(tenantBudgets),
    webhooks: {
      hasUrl: Boolean(url),
      hasSecret: Boolean(secret),
    },
  };
}

