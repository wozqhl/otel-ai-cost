/** Local OSS cost report HTTP server (Node stdlib http only). Hosted dashboard = paid later. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { report, formatHtml, toDailyJson, formatCsv, formatMd, formatGha, budgetsJson, modelsJson, spansJson, tenantsJson, formatTenantsCsv, DEFAULT_PRICES, applyBudgetDeny, spanTenant, ingestDenyWebhookCheck, resolveDenyOnWouldExceed, resolveBudgetPeriod, stampIngestTime, spansInBudgetPeriod, utcToday } from "./cost.js";
import { corsResponseHeaders, handlePreflight, normalizeCors } from "./cors.js";
import { resolveRequestId, REQUEST_ID_HEADER } from "./request-id.js";
import { attachAccessLog } from "./access-log.js";
import { renderCostMetrics } from "./metrics.js";
import {
  SlidingWindowRateLimiter,
  clientIpFromReq,
  resolveRateLimit,
  skipRateLimit,
} from "./rate-limit.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  extractIngestSpans,
  ingestAuthorized,
  isIngestPath,
  readJsonBody,
} from "./ingest.js";
import { notifyBudgetBreach } from "./webhook.js";
import { summarizeRuntimeConfig } from "./runtime-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OPENAPI_PATH = path.resolve(__dirname, "../openapi/cost.openapi.json");

export const DEFAULT_SERVE_PORT = 8792;
export const DEFAULT_SERVE_HOST = "127.0.0.1";
/** Poll interval for `serve --watch` (spans file mtime). */
export const WATCH_POLL_MS = 200;

/** SIGTERM/SIGINT HTTP drain window (k8s/Compose). Cap 30s. */
export const DEFAULT_SHUTDOWN_DRAIN_MS = 5000;
export const MAX_SHUTDOWN_DRAIN_MS = 30000;

/** In-memory span store default. Generous so demos never drop; 0 = unlimited (dangerous). */
export const DEFAULT_SPAN_MAX = 50000;
export const ENV_SPAN_MAX = "SPAN_MAX";

/** CLI `--span-max` wins when provided; else env SPAN_MAX; else 50000. `0` = unlimited. */
export function resolveSpanMax(raw, env = process.env) {
  const source = raw == null || raw === "" ? env?.[ENV_SPAN_MAX] : raw;
  if (source == null || source === "") return DEFAULT_SPAN_MAX;
  const n = Number(source);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SPAN_MAX;
  return Math.floor(n);
}

/**
 * Cap an in-memory span ring. When max > 0 and length exceeds it, drop oldest.
 * max 0 = unlimited. Mutates `spans` when it is an array.
 */
export function capSpans(spans, max = DEFAULT_SPAN_MAX) {
  const buf = Array.isArray(spans) ? spans : [];
  const cap =
    typeof max === "number" && Number.isFinite(max) ? Math.floor(max) : DEFAULT_SPAN_MAX;
  if (cap > 0 && buf.length > cap) {
    buf.splice(0, buf.length - cap);
  }
  return buf;
}

/** Resolve drain window: CLI/raw, else env SHUTDOWN_DRAIN_MS, else 5s. Cap 30s. */
export function resolveDrainMs(raw, env = process.env) {
  const source = raw == null || raw === "" ? env?.SHUTDOWN_DRAIN_MS : raw;
  const n = Number(source);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SHUTDOWN_DRAIN_MS;
  return Math.min(MAX_SHUTDOWN_DRAIN_MS, Math.floor(n));
}

export function reportJson(reportResult, { groupBy = "day" } = {}) {
  if (groupBy === "day") return toDailyJson(reportResult);
  return {
    totalUsd: reportResult.totalUsd,
    byModel: reportResult.byModel,
    byDay: reportResult.byDay,
    byTenant: reportResult.byTenant,
    budgetBreaches: Array.isArray(reportResult.budgetBreaches) ? reportResult.budgetBreaches : [],
    rows: reportResult.rows,
  };
}

function send(res, status, body, contentType, extraHeaders) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    ...(extraHeaders || {}),
    "content-type": contentType,
    "content-length": payload.length,
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendJson(res, status, obj, extraHeaders) {
  send(res, status, JSON.stringify(obj, null, 2) + "\n", "application/json; charset=utf-8", extraHeaders);
}

function sendHtml(res, status, html, extraHeaders) {
  send(res, status, html, "text/html; charset=utf-8", extraHeaders);
}

function sendCsv(res, status, csv, extraHeaders) {
  send(res, status, csv, "text/csv; charset=utf-8", extraHeaders);
}

function sendMarkdown(res, status, md, extraHeaders) {
  send(res, status, md, "text/markdown; charset=utf-8", extraHeaders);
}

function sendGha(res, status, gha, extraHeaders) {
  send(res, status, gha, "text/plain; charset=utf-8", extraHeaders);
}

function costsFormat(url) {
  const raw = url.searchParams.get("format");
  if (raw == null || String(raw).trim() === "") return "json";
  const s = String(raw).trim().toLowerCase();
  if (s === "markdown") return "md";
  if (s === "annotations") return "gha";
  return s;
}

/** Read and JSON-validate the file-backed OpenAPI document. */
export function loadOpenApiRaw(openapiPath = DEFAULT_OPENAPI_PATH) {
  const raw = fs.readFileSync(openapiPath, "utf8");
  JSON.parse(raw);
  return raw;
}

/** Line-buffered-ish stdout for --watch (redirected logs must appear promptly). */
export function watchLog(line) {
  const s = String(line).endsWith("\n") ? String(line) : `${line}\n`;
  try {
    fs.writeSync(1, s);
  } catch {
    console.log(String(line).replace(/\n$/, ""));
  }
}

export function loadSpansFile(file) {
  const abs = path.resolve(file);
  const data = JSON.parse(fs.readFileSync(abs, "utf8"));
  if (Array.isArray(data)) return extractIngestSpans(data);
  if (data && typeof data === "object" && (Array.isArray(data.spans) || Array.isArray(data.resourceSpans))) {
    return extractIngestSpans(data);
  }
  throw new Error("spans JSON must be an array or {spans:[]} or OTLP resourceSpans");
}

function snapshotFromSpans(spans, { groupBy, prices, version, tenantBudgets, budget, denyTotal, denyByTenant, period, now }) {
  const r = report(spans || [], prices, { tenantBudgets });
  const html = formatHtml(r, { groupBy: groupBy === "day" ? "day" : groupBy || null });
  const json = reportJson(r, { groupBy });
  const csv = formatCsv(r);
  const md = formatMd(r);
  const gha = formatGha(r, { budget });
  const metricsReport =
    period === "day"
      ? { ...r, byTenant: report(spansInBudgetPeriod(spans, period, now), prices, { tenantBudgets }).byTenant }
      : r;
  const metricsText = renderCostMetrics(metricsReport, { tenantBudgets, denyTotal, denyByTenant });
  const health = {
    ok: true,
    service: "otel-ai-cost",
    version,
    groupBy: groupBy || null,
    spanCount: r.rows.length,
    totalUsd: r.totalUsd,
  };
  return { report: r, html, json, csv, md, gha, metricsText, health };
}

/**
 * Poll spans file mtime and reload the live snapshot.
 * Parse errors keep the previous snapshot; mtime advances only after a successful reload.
 * Returns the interval handle (clear with clearInterval).
 */
export function startSpansWatch(filePath, { reload, load = loadSpansFile, pollMs = WATCH_POLL_MS, log = watchLog } = {}) {
  const abs = path.resolve(filePath);
  let lastMtimeMs;
  try {
    lastMtimeMs = fs.statSync(abs).mtimeMs;
  } catch (err) {
    console.error(`watch: cannot stat ${abs}: ${err.message || err}`);
    process.exit(1);
  }
  log(`watching ${abs} (poll ${pollMs}ms)`);
  return setInterval(() => {
    try {
      const st = fs.statSync(abs);
      if (!(st.mtimeMs > lastMtimeMs)) return;
      const spans = load(abs);
      const snap = reload(spans);
      lastMtimeMs = st.mtimeMs;
      const spanCount = snap?.health?.spanCount ?? snap?.report?.rows?.length;
      const totalUsd = snap?.health?.totalUsd ?? snap?.report?.totalUsd;
      log(`regenerated ${JSON.stringify({ spanCount, totalUsd })}`);
    } catch (err) {
      console.error(`watch regenerate error: ${err.message || err}`);
    }
  }, pollMs);
}

/**
 * Build a stdlib http.Server that serves a snapshot cost report.
 * GET /health, GET /ready, GET / (HTML + SVG, daily when groupBy=day), GET /report.json,
 * GET /v1/costs.csv, GET /v1/costs.md, GET /v1/costs.gha.txt, GET /v1/costs?format=csv|json|md|gha, GET /v1/budgets, GET /v1/models, GET /v1/config, GET /v1/spans, GET /v1/tenants, GET /v1/tenants.csv, GET /openapi.json, GET /metrics
 * POST /v1/traces (alias POST /v1/otlp/v1/traces) OTLP JSON ingest into the in-memory store.
 * Over-budget / would-exceed ingest deny fires the existing webhook once per denied request (HMAC/timestamp if set).
 * Optional CORS: corsOrigins CSV list (`*` allowed); empty/omit = deny extra CORS.
 * `reload(spans)` replaces the in-memory store (watch) then caps; ingested spans are not kept.
 * Over `--span-max` / SPAN_MAX (default 50000; 0 = unlimited), drop oldest. Costs recompute from the window.
 * OpenAPI stays file-backed.
 */
export function createReportServer({
  spans,
  groupBy = "day",
  prices = DEFAULT_PRICES,
  version = "0.1.0",
  corsOrigins = [],
  openapiPath = DEFAULT_OPENAPI_PATH,
  logJson = false,
  rateLimit,
  tenantBudgets = {},
  budget = null,
  pack = null,
  defaultModel = null,
  ingestToken = null,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  spanMax,
  webhookUrl = null,
  webhookSecret = null,
  denyOnWouldExceed,
  budgetPeriod,
} = {}) {
  const snapOpts = { groupBy, prices, version, tenantBudgets, budget };
  const budgets = budgetsJson({ budget, tenantBudgets });
  const models = modelsJson({ prices, pack, defaultModel });
  const resolvedSpanMax = resolveSpanMax(spanMax);
  const resolvedWebhookUrl = webhookUrl == null || webhookUrl === "" ? null : String(webhookUrl);
  const resolvedWebhookSecret = webhookSecret == null || webhookSecret === "" ? null : String(webhookSecret);
  const resolvedDenyOnWouldExceed = resolveDenyOnWouldExceed(
    denyOnWouldExceed === undefined ? null : denyOnWouldExceed
  );
  const resolvedBudgetPeriod =
    budgetPeriod === undefined
      ? resolveBudgetPeriod(null)
      : resolveBudgetPeriod(budgetPeriod == null || budgetPeriod === "" ? "off" : budgetPeriod);
  let store = Array.isArray(spans) ? spans.slice() : [];
  const bootNow = Date.now();
  for (const s of store) stampIngestTime(s, bootNow);
  capSpans(store, resolvedSpanMax);
  const denyEvents = [];
  function denyByTenantAt(now = Date.now()) {
    const m = new Map();
    const today = utcToday(now);
    for (const e of denyEvents) {
      if (resolvedBudgetPeriod === "day" && utcToday(e.ts) !== today) continue;
      const tenant = e.tenant || "_";
      m.set(tenant, (m.get(tenant) || 0) + 1);
    }
    return m;
  }
  function denyTotalAt(now = Date.now()) {
    let n = 0;
    for (const c of denyByTenantAt(now).values()) n += c;
    return n;
  }
  function allSpans() {
    return store;
  }
  function snapOptsWithDeny(now = Date.now()) {
    return {
      ...snapOpts,
      denyTotal: denyTotalAt(now),
      denyByTenant: denyByTenantAt(now),
      period: resolvedBudgetPeriod,
      now,
    };
  }
  let snap = snapshotFromSpans(allSpans(), snapOptsWithDeny());
  const cors = normalizeCors(corsOrigins);
  const specPath = openapiPath || DEFAULT_OPENAPI_PATH;
  let shuttingDown = false;
  const resolvedLimit = rateLimit === undefined ? resolveRateLimit() : rateLimit;
  const limiter = new SlidingWindowRateLimiter();
  const resolvedToken = ingestToken == null || ingestToken === "" ? null : String(ingestToken);
  const bodyLimit =
    typeof maxBodyBytes === "number" && Number.isFinite(maxBodyBytes) && maxBodyBytes > 0
      ? Math.floor(maxBodyBytes)
      : DEFAULT_MAX_BODY_BYTES;
  const corsOriginList = cors && cors.allowAny ? ["*"] : (cors && Array.isArray(cors.origins) ? cors.origins.slice() : []);
  const runtimeConfig = summarizeRuntimeConfig({
    spanMax: resolvedSpanMax,
    rateLimit: resolvedLimit,
    corsOrigins: corsOriginList,
    pack,
    budget,
    tenantBudgets,
    webhookUrl: resolvedWebhookUrl,
    webhookSecret: resolvedWebhookSecret,
  });

  function beginShutdown() {
    shuttingDown = true;
  }

  function rebuild() {
    snap = snapshotFromSpans(allSpans(), snapOptsWithDeny());
    return snap;
  }

  function reload(nextSpans) {
    const now = Date.now();
    store = Array.isArray(nextSpans) ? nextSpans.slice() : [];
    for (const s of store) stampIngestTime(s, now);
    capSpans(store, resolvedSpanMax);
    return rebuild();
  }

  function budgetReportAt(now = Date.now()) {
    if (resolvedBudgetPeriod === "day") {
      return report(spansInBudgetPeriod(store, resolvedBudgetPeriod, now), prices, { tenantBudgets });
    }
    return snap.report;
  }

  function ingest(incoming) {
    const now = Date.now();
    const list = Array.isArray(incoming) ? incoming : [];
    for (const s of list) stampIngestTime(s, now);
    const reportAtDeny = budgetReportAt(now);
    const gated = applyBudgetDeny(list, reportAtDeny, tenantBudgets, {
      denyOnWouldExceed: resolvedDenyOnWouldExceed,
      prices,
      period: resolvedBudgetPeriod,
      now,
      store,
    });
    const denyCheck = gated.denied
      ? ingestDenyWebhookCheck(gated, reportAtDeny, tenantBudgets)
      : null;
    if (gated.denied) {
      for (const span of gated.deniedSpans) {
        denyEvents.push({ tenant: spanTenant(span), ts: now });
      }
    }
    if (gated.kept.length) store.push(...gated.kept);
    capSpans(store, resolvedSpanMax);
    rebuild();
    return { ok: true, accepted: list.length, denied: gated.denied, stored: gated.kept.length, denyCheck };
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const method = (req.method || "GET").toUpperCase();
    const pathName = url.pathname;
    const requestId = resolveRequestId(req);
    // Always set so implicit writeHead still echoes X-Request-Id.
    res.setHeader(REQUEST_ID_HEADER, requestId);
    attachAccessLog(req, res, {
      enabled: Boolean(logJson),
      service: "otel-ai-cost",
      requestId,
      pathName,
    });

    // Inject ACAO (and expose headers) when Origin matches.
    // Disallowed / disabled CORS → no extra headers. Explicit writeHead ACAO (preflight) wins.
    // X-Request-Id is always last so the resolved id is echoed on every response.
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = (statusCode, a, b) => {
      let reason;
      let headers;
      if (typeof a === "string") {
        reason = a;
        headers = b;
      } else {
        headers = a;
      }
      const corsH = corsResponseHeaders(req, cors);
      const rid = { [REQUEST_ID_HEADER]: requestId };
      let merged;
      if (headers && typeof headers === "object" && !Array.isArray(headers)) {
        merged = { ...corsH, ...headers, ...rid };
      } else {
        merged = { ...corsH, ...rid };
      }
      if (reason !== undefined) return origWriteHead(statusCode, reason, merged);
      return origWriteHead(statusCode, merged);
    };

    const extra = corsResponseHeaders(req, cors);

    function rateLimitOrReject() {
      if (skipRateLimit(pathName)) return false;
      const { allowed, retryAfter } = limiter.check(clientIpFromReq(req), resolvedLimit);
      if (allowed) return false;
      sendJson(res, 429, { ok: false, reason: "rate_limited" }, { "Retry-After": String(retryAfter) });
      return true;
    }

    if (method === "OPTIONS") {
      const pf = handlePreflight(req, cors);
      if (!pf) {
        // CORS disabled: no extra CORS; same 404 as unknown paths.
        sendJson(res, 404, { error: "not_found", path: pathName });
        return;
      }
      if (pf.status === 204) {
        res.writeHead(204, pf.headers);
        res.end();
        return;
      }
      sendJson(res, pf.status, pf.body || { error: "forbidden" }, pf.headers);
      return;
    }

    if (rateLimitOrReject()) return;

    if (method === "POST" && isIngestPath(pathName)) {
      handleIngestPost(req, res, extra).catch((err) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: "ingest_failed", detail: String(err?.message || err) }, extra);
        }
      });
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { error: "method_not_allowed" }, extra);
      return;
    }

    if (pathName === "/health") {
      const body = shuttingDown ? { ...snap.health, shuttingDown: true } : snap.health;
      sendJson(res, 200, body, extra);
      return;
    }
    if (pathName === "/ready") {
      // Shutdown 503 wins over healthy 200. Snapshot service has no circuit/queue.
      if (shuttingDown) {
        sendJson(res, 503, { ok: false, reason: "shutting_down" }, extra);
        return;
      }
      sendJson(res, 200, snap.health, extra);
      return;
    }
    if (pathName === "/report.json") {
      sendJson(res, 200, snap.json, extra);
      return;
    }
    if (pathName === "/v1/costs.csv") {
      sendCsv(res, 200, snap.csv, extra);
      return;
    }
    if (pathName === "/v1/costs.md") {
      sendMarkdown(res, 200, snap.md, extra);
      return;
    }
    if (pathName === "/v1/costs.gha.txt" || pathName === "/v1/costs.gha") {
      sendGha(res, 200, snap.gha, extra);
      return;
    }
    if (pathName === "/v1/costs") {
      const fmt = costsFormat(url);
      if (fmt === "csv") {
        sendCsv(res, 200, snap.csv, extra);
        return;
      }
      if (fmt === "md" || fmt === "markdown") {
        sendMarkdown(res, 200, snap.md, extra);
        return;
      }
      if (fmt === "gha" || fmt === "annotations") {
        sendGha(res, 200, snap.gha, extra);
        return;
      }
      if (fmt === "json") {
        sendJson(res, 200, snap.json, extra);
        return;
      }
      sendJson(res, 400, { error: "bad_format", allowed: ["csv", "json", "md", "gha"] }, extra);
      return;
    }
    if (pathName === "/v1/budgets") {
      sendJson(res, 200, budgets, extra);
      return;
    }
    if (pathName === "/v1/models") {
      sendJson(res, 200, models, extra);
      return;
    }
    if (pathName === "/v1/config") {
      // Public redacted runtime config (knobs, not spend). Allowlist only.
      // Never webhook URL/secret, ingest token, or price table dump.
      sendJson(res, 200, runtimeConfig, extra);
      return;
    }
    if (pathName === "/v1/spans") {
      // Allowlist summaries only — never prompt/completion/input/output text, API keys, Authorization.
      sendJson(res, 200, spansJson(allSpans(), { prices }), extra);
      return;
    }
    if (pathName === "/v1/tenants.csv") {
      // Chargeback-lite CSV from in-memory totals — same tenants as GET /v1/tenants JSON.
      const rawTenantCsv = url.searchParams.get("tenant");
      const tenantCsv =
        rawTenantCsv == null || String(rawTenantCsv).trim() === "" ? null : String(rawTenantCsv).trim();
      sendCsv(
        res,
        200,
        formatTenantsCsv(allSpans(), {
          prices,
          budgets: tenantBudgets,
          tenant: tenantCsv,
          denyByTenant: denyByTenantAt(),
          period: resolvedBudgetPeriod,
        }),
        extra
      );
      return;
    }
    if (pathName === "/v1/tenants") {
      // Per-tenant spend rollup — never prompts, completions, API keys, Authorization, or the price catalog.
      const rawTenant = url.searchParams.get("tenant");
      const tenant =
        rawTenant == null || String(rawTenant).trim() === "" ? null : String(rawTenant).trim();
      const fmt = (url.searchParams.get("format") || "json").trim().toLowerCase();
      const tenantOpts = {
        prices,
        budgets: tenantBudgets,
        tenant,
        denyByTenant: denyByTenantAt(),
        period: resolvedBudgetPeriod,
      };
      if (fmt === "csv") {
        sendCsv(res, 200, formatTenantsCsv(allSpans(), tenantOpts), extra);
        return;
      }
      sendJson(res, 200, tenantsJson(allSpans(), tenantOpts), extra);
      return;
    }
    if (pathName === "/metrics") {
      send(res, 200, snap.metricsText, "text/plain; version=0.0.4; charset=utf-8", extra);
      return;
    }
    if (pathName === "/openapi.json") {
      try {
        const raw = loadOpenApiRaw(specPath);
        send(res, 200, raw, "application/json; charset=utf-8", extra);
      } catch (err) {
        sendJson(
          res,
          500,
          { error: "openapi_unavailable", detail: String(err?.message || err) },
          extra
        );
      }
      return;
    }
    if (pathName === "/" || pathName === "/index.html") {
      sendHtml(res, 200, snap.html, extra);
      return;
    }
    sendJson(res, 404, { error: "not_found", path: pathName }, extra);
  });

  async function handleIngestPost(req, res, extra) {
    if (!ingestAuthorized(req, resolvedToken)) {
      req.resume();
      sendJson(res, 401, { error: "unauthorized" }, extra);
      return;
    }
    let body;
    try {
      body = await readJsonBody(req, bodyLimit);
    } catch (err) {
      const code = err && err.code;
      if (code === "payload_too_large") {
        sendJson(res, 413, { error: "payload_too_large" }, extra);
        return;
      }
      sendJson(res, 400, { error: "bad_json" }, extra);
      return;
    }
    const incoming = extractIngestSpans(body);
    const result = ingest(incoming);
    // Once per denied request. No URL → skip. Errors never change the 200.
    if (result.denyCheck && resolvedWebhookUrl) {
      await notifyBudgetBreach(resolvedWebhookUrl, result.denyCheck, {
        secret: resolvedWebhookSecret,
      });
    }
    sendJson(res, 200, { ok: true, accepted: result.accepted, denied: result.denied || 0 }, extra);
  }

  return {
    server,
    get report() {
      return snap.report;
    },
    get health() {
      return snap.health;
    },
    get html() {
      return snap.html;
    },
    get json() {
      return snap.json;
    },
    get csv() {
      return snap.csv;
    },
    get md() {
      return snap.md;
    },
    get gha() {
      return snap.gha;
    },
    get metricsText() {
      return snap.metricsText;
    },
    get budgets() {
      return budgets;
    },
    get models() {
      return models;
    },
    get config() {
      return runtimeConfig;
    },
    reload,
    ingest,
    beginShutdown,
    isShuttingDown() {
      return Boolean(shuttingDown);
    },
    cors,
    openapiPath: specPath,
    rateLimit: resolvedLimit,
    limiter,
    ingestToken: resolvedToken,
    maxBodyBytes: bodyLimit,
    spanMax: resolvedSpanMax,
    budgetPeriod: resolvedBudgetPeriod,
    get spans() {
      return store;
    },
  };
}

export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server.address());
    });
  });
}

export function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
