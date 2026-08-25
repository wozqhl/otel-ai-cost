#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  report,
  DEFAULT_PRICES,
  spanCost,
  spanCostUsdAttr,
  COST_USD_ATTR,
  formatTable,
  formatHtml,
  formatCsv,
  formatMd,
  formatGha,
  toDailyJson,
  filterSpans,
  loadPolicy,
  loadBudget,
  checkBudget,
  formatBudgetResult,
  parseTenantBudgets,
  resolveTenantBudgets,
  tenantBudgetWebhookCheck,
  ingestDenyWebhookCheck,
  applyBudgetDeny,
  resolveDenyOnWouldExceed,
  ENV_DENY_ON_WOULD_EXCEED,
  resolveBudgetPeriod,
  ENV_BUDGET_PERIOD,
  ENV_BUDGET_PERIOD_ALIAS,
  BUDGET_PERIOD_DAY,
  utcToday,
  wouldExceedBudget,
  tenantBudgetRemaining,
  budgetsJson,
  modelsJson,
  spansJson,
  tenantsJson,
  formatTenantsCsv,
  TENANT_CSV_COLUMNS,
  SPAN_LIST_CAP,
  TENANT_LIST_CAP,
  ENV_TENANT_BUDGETS,
  ENV_TENANT_BUDGETS_ALIAS,
} from "./cost.js";
import {
  createReportServer,
  listen,
  closeServer,
  loadSpansFile,
  DEFAULT_SERVE_PORT,
  DEFAULT_SERVE_HOST,
  WATCH_POLL_MS,
  startSpansWatch,
  resolveDrainMs,
  DEFAULT_SHUTDOWN_DRAIN_MS,
  MAX_SHUTDOWN_DRAIN_MS,
  resolveSpanMax,
  capSpans,
  DEFAULT_SPAN_MAX,
  ENV_SPAN_MAX,
} from "./serve.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  ENV_INGEST_TOKEN,
  attrsToMap,
  extractIngestSpans,
  ingestAuthorized,
  isIngestPath,
  resolveIngestToken,
} from "./ingest.js";
import { renderCostMetrics } from "./metrics.js";
import {
  DEFAULT_CORS_EXPOSE_HEADERS,
  DEFAULT_CORS_HEADERS,
  DEFAULT_CORS_METHODS,
  ENV_CORS_ORIGINS,
  acaoValue,
  corsResponseHeaders,
  handlePreflight,
  normalizeCors,
  originAllowed,
  parseCorsOrigins,
  resolveCorsOrigins,
} from "./cors.js";
import {
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  ENV_RATE_LIMIT_PER_MINUTE,
  ENV_RATE_LIMIT_RPM,
  SlidingWindowRateLimiter,
  clientIpFromReq,
  resolveRateLimit,
  skipRateLimit,
} from "./rate-limit.js";
import { resolveRequestId, sanitizeRequestId, isUuid } from "./request-id.js";
import { resolveLogJson, formatAccessLog, shouldSkipAccessLog } from "./access-log.js";
import {
  FORBIDDEN_RUNTIME_CONFIG_KEYS,
  assertRuntimeConfigSafe,
  summarizeRuntimeConfig,
} from "./runtime-config.js";
import {
  ENV_WEBHOOK_SECRET,
  ENV_WEBHOOK_URL,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  SIGNATURE_HEADER,
  buildWebhookPayload,
  notifyBudgetBreach,
  parseWebhookUrl,
  resolveWebhookSecret,
  resolveWebhookUrl,
  shouldRetryWebhook,
  signWebhookBody,
  TIMESTAMP_HEADER,
  verifyWebhookSignature,
  webhookUnixSeconds,
} from "./webhook.js";

const VERSION = "0.1.0";

const demoSpans = [
  {
    timestamp: "2024-08-11T12:00:00.000Z",
    attributes: {
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 1000,
      "gen_ai.usage.output_tokens": 500,
      tenant: "acme",
    },
  },
  {
    timestamp: "2024-08-12T12:00:00.000Z",
    attributes: {
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.usage.input_tokens": 2000,
      "gen_ai.usage.output_tokens": 800,
    },
  },
];

function printHelp() {
  console.log(`otel-ai-cost v${VERSION}
Usage:
  otel-ai-cost --version
  otel-ai-cost smoke
  otel-ai-cost demo
  otel-ai-cost report --in spans.json [--html out/report.html] [--budget policies/budget.json]
                     [--tenant-budget acme=10,other=5] [--webhook-url URL] [--webhook-secret SECRET]
                     [--group-by day] [--out out/daily.json] [--format csv|json|html|md|gha]
  otel-ai-cost check-budget --in spans.json --budget policies/budget.json [--tenant-budget acme=10]
                     [--webhook-url URL] [--webhook-secret SECRET]
  otel-ai-cost filter --in spans.json --out out/filtered.json [--sample 0.5] [--redact] [--policy policies/redact-basic.json]
  otel-ai-cost route --in spans.json [--policy policies/redact-basic.json] [--sample 0.5] [--redact]
                     [--stdout] [--file out/kept.json] [--drop-file out/dropped.json]
  otel-ai-cost models
  otel-ai-cost serve --in spans.json [--port 8792] [--host 127.0.0.1] [--group-by day]
                     [--tenant-budget acme=10,other=5] [--cors-origins CSV] [--rate-limit N]
                     [--ingest-token TOKEN] [--span-max 50000] [--webhook-url URL] [--webhook-secret SECRET]
                     [--no-deny-on-would-exceed] [--budget-period day] [--watch] [--drain-ms 5000] [--log-json]
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") out.in = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--html") out.html = argv[++i];
    else if (a === "--format") out.format = argv[++i];
    else if (a === "--sample") out.sample = Number(argv[++i]);
    else if (a === "--redact") out.redact = true;
    else if (a === "--seed") out.seed = Number(argv[++i]);
    else if (a === "--policy") out.policy = argv[++i];
    else if (a === "--budget") out.budget = argv[++i];
    else if (a === "--file") out.file = argv[++i];
    else if (a === "--drop-file") out.dropFile = argv[++i];
    else if (a === "--stdout") out.stdout = true;
    else if (a === "--group-by") out.groupBy = argv[++i];
    else if (a === "--port" || a === "-p") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--cors-origins") out.corsOrigins = argv[++i] ?? "";
    else if (a === "--rate-limit") out.rateLimit = argv[++i];
    else if (a === "--watch") out.watch = true;
    else if (a === "--drain-ms") out.drainMs = argv[++i];
    else if (a === "--log-json") out.logJson = true;
    else if (a === "--no-log-json") out.logJson = false;
    else if (a === "--webhook-url") out.webhookUrl = argv[++i] ?? "";
    else if (a === "--webhook-secret") out.webhookSecret = argv[++i] ?? "";
    else if (a === "--tenant-budget") out.tenantBudget = argv[++i] ?? "";
    else if (a === "--ingest-token") out.ingestToken = argv[++i] ?? "";
    else if (a === "--span-max") out.spanMax = argv[++i];
    else if (a === "--deny-on-would-exceed") out.denyOnWouldExceed = true;
    else if (a === "--no-deny-on-would-exceed") out.denyOnWouldExceed = false;
    else if (a === "--budget-period") out.budgetPeriod = argv[++i] ?? "";
    else out._.push(a);
  }
  return out;
}

function loadSpans(file) {
  return loadSpansFile(file);
}

function resolvePolicy(args) {
  if (!args.policy) return null;
  return loadPolicy(path.resolve(args.policy));
}

function resolveBudget(args) {
  if (!args.budget) return null;
  return loadBudget(path.resolve(args.budget));
}

function writeJson(file, data) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + "\n");
  return abs;
}

function writeText(file, text) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const s = String(text);
  const body = s === "" || s.endsWith("\n") ? s : s + "\n";
  fs.writeFileSync(abs, body);
  return abs;
}

function webhookUrlFromArgs(args) {
  return resolveWebhookUrl(
    Object.prototype.hasOwnProperty.call(args, "webhookUrl") ? args.webhookUrl : null
  );
}

function webhookSecretFromArgs(args) {
  return resolveWebhookSecret(
    Object.prototype.hasOwnProperty.call(args, "webhookSecret") ? args.webhookSecret : null
  );
}

async function runBudgetGate(reportResult, budget, { asJson = true, quiet = false, webhookUrl = null, webhookSecret = null } = {}) {
  const check = checkBudget(reportResult, budget);
  if (!quiet) {
    console.log(formatBudgetResult(check));
    if (asJson) {
      console.log(
        JSON.stringify({
          budgetOk: check.ok,
          breaches: check.breaches,
          totalUsd: check.totalUsd,
          byModel: check.byModel,
          budget: check.budget,
        })
      );
    }
  }
  if (!check.ok) {
    // Await short-timeout POST so process.exit does not kill it; errors ignored.
    await notifyBudgetBreach(webhookUrl, check, { secret: webhookSecret });
    process.exit(1);
  }
  return check;
}

const cmd = process.argv[2] || "help";
if (cmd === "--version" || cmd === "-V") {
  console.log(VERSION);
} else if (cmd === "smoke") {
  const r = report(demoSpans);
  if (r.rows.length !== 2 || r.totalUsd <= 0) {
    console.error("smoke failed", r);
    process.exit(1);
  }
  if (!Array.isArray(r.byDay) || r.byDay.length < 2) {
    console.error("smoke byDay failed", r.byDay);
    process.exit(1);
  }
  const acme = (r.byTenant || []).find((t) => t.tenant === "acme");
  if (!Array.isArray(r.byTenant) || !acme || !Number.isFinite(Number(acme.usd))) {
    console.error("smoke byTenant failed", r.byTenant);
    process.exit(1);
  }
  const html = formatHtml(r, { groupBy: "day" });
  if (!html.includes("<table") || !html.includes("TOTAL") || !html.includes("<svg") || !html.includes("gpt-4o")) {
    console.error("smoke html failed");
    process.exit(1);
  }
  if (!html.includes("by day (UTC)") || !html.includes("2024-08-11")) {
    console.error("smoke html day section failed");
    process.exit(1);
  }
  if (html.includes('id="budget-remaining"')) {
    console.error("smoke html remaining must be absent without tenant budgets");
    process.exit(1);
  }
  const daily = toDailyJson(r);
  if (daily.groupBy !== "day" || !daily.days?.length) {
    console.error("smoke daily json failed", daily);
    process.exit(1);
  }
  if (!Array.isArray(daily.byTenant) || !daily.byTenant.some((t) => t.tenant === "acme" && Number.isFinite(Number(t.usd)))) {
    console.error("smoke daily json byTenant failed", daily.byTenant);
    process.exit(1);
  }
  const csv = formatCsv(r);
  const csvLines = csv.trimEnd().split(/\n/);
  const csvHeader = csvLines[0] || "";
  const csvData = csvLines.filter((ln) => ln && !ln.startsWith("#") && ln !== csvHeader && !ln.startsWith("TOTAL"));
  let csvUsdOk = false;
  for (const ln of csvData) {
    const cols = ln.split(",");
    const usd = Number(cols[3]);
    if (cols[0] && cols[1] && Number.isFinite(Number(cols[2])) && Number.isFinite(usd)) {
      csvUsdOk = true;
      break;
    }
  }
  if (
    !csvHeader.startsWith("date,model,spanCount,usd") ||
    !csvHeader.split(",").includes("tenant") ||
    csvData.length < 1 ||
    !csvUsdOk ||
    !csv.includes("acme")
  ) {
    console.error("smoke csv failed", csv);
    process.exit(1);
  }
  const emptyCsv = formatCsv(report([]));
  const emptyLines = emptyCsv.trimEnd().split(/\n/);
  if (
    emptyLines.length !== 1 ||
    !emptyLines[0].startsWith("date,model,spanCount,usd") ||
    !emptyLines[0].split(",").includes("tenant")
  ) {
    console.error("smoke empty csv failed", emptyCsv);
    process.exit(1);
  }
  const md = formatMd(r);
  if (
    !md.includes("# ") ||
    !md.includes("totalUsd") ||
    !md.includes("|") ||
    !md.includes("| model | usd | spans |") ||
    !md.includes("| tenant | usd | spans |") ||
    !md.includes("acme")
  ) {
    console.error("smoke md failed", md);
    process.exit(1);
  }
  const emptyMd = formatMd(report([]));
  if (
    !emptyMd.includes("# ") ||
    !emptyMd.includes("totalUsd") ||
    !emptyMd.includes("**spans:** 0") ||
    !emptyMd.includes("| model | usd | spans |") ||
    !emptyMd.includes("| tenant | usd | spans |")
  ) {
    console.error("smoke empty md failed", emptyMd);
    process.exit(1);
  }
  const pipeR = report([
    {
      timestamp: "2024-08-11T12:00:00.000Z",
      attributes: {
        "gen_ai.request.model": "gpt|4o",
        "gen_ai.usage.input_tokens": 1,
        "gen_ai.usage.output_tokens": 1,
        tenant: "ac|me",
      },
    },
  ]);
  const pipeMd = formatMd(pipeR);
  if (!pipeMd.includes("gpt\\|4o") || !pipeMd.includes("ac\\|me") || pipeMd.includes("| gpt|4o |")) {
    console.error("smoke md pipe escape failed", pipeMd);
    process.exit(1);
  }
  const routed = filterSpans(demoSpans, { sample: 1, redact: true, seed: 1 });
  if (routed.after !== 2 || routed.droppedCount !== 0) {
    console.error("smoke filter failed", routed);
    process.exit(1);
  }
  // budget thresholds: demo total should pass a loose limit and fail a tiny one
  const pass = checkBudget(r, { maxTotalUsd: 1, maxPerModelUsd: { "gpt-4o": 1 } });
  const fail = checkBudget(r, { maxTotalUsd: 0.000001, maxPerModelUsd: { "gpt-4o": 0.000001 } });
  if (!pass.ok || fail.ok || fail.breaches.length < 1) {
    console.error("smoke budget failed", { pass, fail });
    process.exit(1);
  }

  const parsedTb = parseTenantBudgets("acme=10,other=5");
  const parsedColon = parseTenantBudgets("acme:10,other:5");
  const tbResolveOk =
    parsedTb.acme === 10 &&
    parsedTb.other === 5 &&
    parsedColon.acme === 10 &&
    Object.keys(parseTenantBudgets("")).length === 0 &&
    Object.keys(parseTenantBudgets(null)).length === 0 &&
    Object.keys(resolveTenantBudgets(null, {})).length === 0 &&
    resolveTenantBudgets(null, { [ENV_TENANT_BUDGETS]: "acme=1" }).acme === 1 &&
    resolveTenantBudgets(null, { [ENV_TENANT_BUDGETS_ALIAS]: "acme:2" }).acme === 2 &&
    resolveTenantBudgets("acme=3", { [ENV_TENANT_BUDGETS]: "acme=1" }).acme === 3 &&
    Object.keys(resolveTenantBudgets("", { [ENV_TENANT_BUDGETS]: "acme=1" })).length === 0 &&
    parseTenantBudgets({ acme: 0.01 }).acme === 0.01;
  if (!tbResolveOk) {
    console.error("smoke failed tenant-budget parse/resolve", { parsedTb, parsedColon });
    process.exit(1);
  }
  const b10 = budgetsJson({ tenantBudgets: parseTenantBudgets("acme=10") });
  const bNone = budgetsJson();
  const bGlobal = budgetsJson({ budget: { maxTotalUsd: 5, name: "tight" }, tenantBudgets: { acme: 10 } });
  const bZero = budgetsJson({ budget: { maxTotalUsd: 0 } });
  const bSecret = budgetsJson({
    budget: { maxTotalUsd: 1, webhookSecret: "sk-secret", token: "whsec_x" },
    tenantBudgets: { acme: 10 },
  });
  const bSecretJson = JSON.stringify(bSecret);
  const budgetsHelperOk =
    b10.ok === true &&
    b10.globalUsd === null &&
    b10.tenants.acme === 10 &&
    Object.keys(b10.tenants).length === 1 &&
    bNone.ok === true &&
    bNone.globalUsd === null &&
    bNone.tenants &&
    typeof bNone.tenants === "object" &&
    Object.keys(bNone.tenants).length === 0 &&
    bGlobal.ok === true &&
    bGlobal.globalUsd === 5 &&
    bGlobal.tenants.acme === 10 &&
    !("name" in bGlobal) &&
    !("maxTotalUsd" in bGlobal) &&
    bZero.globalUsd === 0 &&
    !("webhookSecret" in bSecret) &&
    !("token" in bSecret) &&
    !("secret" in bSecret) &&
    bSecretJson.indexOf("sk-") === -1 &&
    bSecretJson.indexOf("whsec") === -1 &&
    bSecret.tenants.acme === 10 &&
    bSecret.globalUsd === 1;
  if (!budgetsHelperOk) {
    console.error("smoke failed budgetsJson helper", { b10, bNone, bGlobal, bZero, bSecret });
    process.exit(1);
  }
  const mDef = modelsJson();
  const gpt4o = (mDef.models || []).find((m) => m.id === "gpt-4o");
  const mini = (mDef.models || []).find((m) => m.id === "gpt-4o-mini");
  const mEmpty = modelsJson({ prices: {} });
  const mUsd = modelsJson({ prices: { "only-1k": { usdPer1k: 1.25 } } });
  const mSecret = modelsJson({
    prices: { "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10, apiKey: "sk-secret", token: "whsec_x" } },
  });
  const mSecretJson = JSON.stringify(mSecret);
  const modelsHelperOk =
    mDef.ok === true &&
    Array.isArray(mDef.models) &&
    mDef.models.length >= 1 &&
    Boolean(gpt4o) &&
    Number(gpt4o.inputPerMTok) === Number(DEFAULT_PRICES["gpt-4o"].inputPerMTok) &&
    Number(gpt4o.outputPerMTok) === Number(DEFAULT_PRICES["gpt-4o"].outputPerMTok) &&
    Boolean(mini) &&
    mDef.defaultModel === null &&
    mDef.pack === null &&
    mEmpty.ok === true &&
    Array.isArray(mEmpty.models) &&
    mEmpty.models.length === 0 &&
    mUsd.ok === true &&
    mUsd.models.length === 1 &&
    mUsd.models[0].id === "only-1k" &&
    Number(mUsd.models[0].usdPer1k) === 1.25 &&
    !("apiKey" in (mSecret.models[0] || {})) &&
    !("token" in (mSecret.models[0] || {})) &&
    mSecretJson.indexOf("sk-") === -1 &&
    mSecretJson.indexOf("whsec") === -1 &&
    Number(mSecret.models[0].inputPerMTok) === 2.5;
  if (!modelsHelperOk) {
    console.error("smoke failed modelsJson helper", { mDef, mEmpty, mUsd, mSecret });
    process.exit(1);
  }
  const emptySpanList = spansJson([]);
  const plantedSpan = {
    spanId: "span-planted-1",
    timestamp: "2024-08-15T00:00:00.000Z",
    attributes: {
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
      tenant: "acme",
      "gen_ai.prompt": "SECRET_PROMPT",
      "gen_ai.completion": "SECRET_PROMPT",
      Authorization: "Bearer sk-secret",
      apiKey: "sk-secret",
    },
  };
  const plantedList = spansJson([plantedSpan]);
  const plantedBlob = JSON.stringify(plantedList);
  const plantedRow = (plantedList.spans || [])[0];
  const manySpans = Array.from({ length: 101 }, (_, i) => ({
    spanId: `cap-${i}`,
    timestamp: "2024-08-15T00:00:00.000Z",
    attributes: { "gen_ai.request.model": "gpt-4o-mini", "gen_ai.usage.input_tokens": 1 },
  }));
  const truncatedList = spansJson(manySpans);
  const spansHelperOk =
    SPAN_LIST_CAP === 100 &&
    emptySpanList.ok === true &&
    emptySpanList.count === 0 &&
    Array.isArray(emptySpanList.spans) &&
    emptySpanList.spans.length === 0 &&
    emptySpanList.truncated !== true &&
    plantedList.ok === true &&
    plantedList.count === 1 &&
    plantedList.spans.length === 1 &&
    plantedRow &&
    plantedRow.id === "span-planted-1" &&
    plantedRow.model === "gpt-4o" &&
    plantedRow.tenant === "acme" &&
    Number(plantedRow.inputTokens) === 100 &&
    Number(plantedRow.outputTokens) === 20 &&
    typeof plantedRow.usd === "number" &&
    plantedRow.ts === "2024-08-15T00:00:00.000Z" &&
    !plantedBlob.includes("SECRET_PROMPT") &&
    !plantedBlob.includes("sk-secret") &&
    !plantedBlob.includes("Authorization") &&
    !plantedBlob.includes("gen_ai.prompt") &&
    !plantedBlob.includes("gen_ai.completion") &&
    !("attributes" in plantedRow) &&
    !("prompt" in plantedRow) &&
    truncatedList.ok === true &&
    truncatedList.count === 101 &&
    truncatedList.spans.length === 100 &&
    truncatedList.truncated === true &&
    truncatedList.spans[0].id === "cap-100" &&
    truncatedList.spans[99].id === "cap-1";
  if (!spansHelperOk) {
    console.error("smoke failed spansJson helper", { emptySpanList, plantedList, truncatedList });
    process.exit(1);
  }
  const emptyTenantList = tenantsJson([]);
  const plantedTenantList = tenantsJson([plantedSpan]);
  const plantedTenantBlob = JSON.stringify(plantedTenantList);
  const plantedTenantRow = (plantedTenantList.tenants || [])[0];
  const missingTenantList = tenantsJson([
    { attributes: { "gen_ai.request.model": "gpt-4o", "gen_ai.usage.input_tokens": 10 } },
  ]);
  const budgetedTenantList = tenantsJson([plantedSpan], { budgets: { acme: 10 } });
  const unknownFilter = tenantsJson([plantedSpan], { tenant: "no-such-tenant" });
  const acmeFilter = tenantsJson([plantedSpan], { tenant: "acme" });
  const manyTenants = Array.from({ length: 101 }, (_, i) => ({
    attributes: {
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 100,
      tenant: `t${String(i).padStart(3, "0")}`,
    },
  }));
  const truncatedTenants = tenantsJson(manyTenants);
  const tenantsHelperOk =
    TENANT_LIST_CAP === 100 &&
    emptyTenantList.ok === true &&
    emptyTenantList.count === 0 &&
    Array.isArray(emptyTenantList.tenants) &&
    emptyTenantList.tenants.length === 0 &&
    emptyTenantList.truncated !== true &&
    plantedTenantList.ok === true &&
    plantedTenantList.count === 1 &&
    plantedTenantList.tenants.length === 1 &&
    plantedTenantRow &&
    plantedTenantRow.id === "acme" &&
    plantedTenantRow.spanCount === 1 &&
    typeof plantedTenantRow.usd === "number" &&
    !("budgetUsd" in plantedTenantRow) &&
    !plantedTenantBlob.includes("SECRET_PROMPT") &&
    !plantedTenantBlob.includes("sk-secret") &&
    !plantedTenantBlob.includes("Authorization") &&
    !plantedTenantBlob.includes("gen_ai.prompt") &&
    !plantedTenantBlob.includes("apiKey") &&
    !("attributes" in plantedTenantRow) &&
    !("prompt" in plantedTenantRow) &&
    missingTenantList.count === 1 &&
    missingTenantList.tenants[0].id === "_" &&
    budgetedTenantList.tenants[0].budgetUsd === 10 &&
    unknownFilter.ok === true &&
    unknownFilter.count === 0 &&
    unknownFilter.tenants.length === 0 &&
    acmeFilter.count === 1 &&
    acmeFilter.tenants[0].id === "acme" &&
    truncatedTenants.ok === true &&
    truncatedTenants.count === 101 &&
    truncatedTenants.tenants.length === 100 &&
    truncatedTenants.truncated === true &&
    truncatedTenants.tenants[0].id === "t000" &&
    truncatedTenants.tenants[99].id === "t099";
  if (!tenantsHelperOk) {
    console.error("smoke failed tenantsJson helper", {
      emptyTenantList,
      plantedTenantList,
      missingTenantList,
      budgetedTenantList,
      unknownFilter,
      truncatedTenants,
    });
    process.exit(1);
  }
  const emptyTenantCsv = formatTenantsCsv([]);
  const twoTenantCsv = formatTenantsCsv(
    [
      {
        attributes: {
          "gen_ai.request.model": "gpt-4o-mini",
          tenant: "acme",
          "gen_ai.cost.usd": 1,
        },
      },
      {
        attributes: {
          "gen_ai.request.model": "gpt-4o-mini",
          tenant: "other",
          "gen_ai.cost.usd": 2,
        },
      },
    ],
    { budgets: { acme: 10, other: 5 }, denyByTenant: { acme: 1 } }
  );
  const twoCsvLines = twoTenantCsv.trim().split("\n");
  const tenantCsvHelperOk =
    TENANT_CSV_COLUMNS.join(",") === "tenant,spend_usd,budget_usd,remaining_usd,denied_count" &&
    emptyTenantCsv === "tenant,spend_usd,budget_usd,remaining_usd,denied_count\n" &&
    twoCsvLines[0] === "tenant,spend_usd,budget_usd,remaining_usd,denied_count" &&
    twoCsvLines.length === 3 &&
    twoCsvLines.some((l) => l.startsWith("other,2.000000,5.000000,3.000000,0")) &&
    twoCsvLines.some((l) => l.startsWith("acme,1.000000,10.000000,9.000000,1"));
  if (!tenantCsvHelperOk) {
    console.error("smoke failed formatTenantsCsv helper", { emptyTenantCsv, twoTenantCsv });
    process.exit(1);
  }
  const cfgPayload = summarizeRuntimeConfig({
    spanMax: 50000,
    rateLimit: 120,
    corsOrigins: ["http://localhost:3000"],
    pack: "redact-basic",
    budget: { maxTotalUsd: 7, webhookSecret: "sk-secret" },
    tenantBudgets: { acme: 10 },
    webhookUrl: "http://127.0.0.1:9/hook?token=planted_url_token",
    webhookSecret: "whsec_must_not_leak",
  });
  const cfgBlob = JSON.stringify(cfgPayload);
  const cfgSafe = assertRuntimeConfigSafe(cfgPayload);
  const cfgOk =
    cfgPayload.ok === true &&
    cfgPayload.spanCap === 50000 &&
    cfgPayload.spansMax === 50000 &&
    (cfgPayload.rateLimit || {}).perMinute === 120 &&
    JSON.stringify((cfgPayload.cors || {}).origins) === JSON.stringify(["http://localhost:3000"]) &&
    cfgPayload.pack === "redact-basic" &&
    cfgPayload.hasGlobalBudget === true &&
    cfgPayload.tenantBudgetCount === 1 &&
    (cfgPayload.webhooks || {}).hasUrl === true &&
    (cfgPayload.webhooks || {}).hasSecret === true &&
    cfgSafe.ok === true &&
    !cfgBlob.includes("planted_url_token") &&
    !cfgBlob.includes("whsec_must_not_leak") &&
    !cfgBlob.includes("sk-") &&
    !cfgBlob.includes("Authorization") &&
    !cfgBlob.includes("webhookUrl") &&
    !cfgBlob.includes("webhookSecret") &&
    !("models" in cfgPayload) &&
    !("globalUsd" in cfgPayload) &&
    !("tenants" in cfgPayload) &&
    FORBIDDEN_RUNTIME_CONFIG_KEYS.includes("secret") &&
    FORBIDDEN_RUNTIME_CONFIG_KEYS.includes("Authorization") &&
    FORBIDDEN_RUNTIME_CONFIG_KEYS.includes("ingestToken");
  const emptyCfg = summarizeRuntimeConfig({
    spanMax: 0,
    rateLimit: 0,
    corsOrigins: [],
    webhookUrl: null,
    webhookSecret: null,
  });
  const emptyCfgOk =
    emptyCfg.ok === true &&
    emptyCfg.spanCap === 0 &&
    emptyCfg.spansMax === 0 &&
    (emptyCfg.rateLimit || {}).perMinute == null &&
    JSON.stringify((emptyCfg.cors || {}).origins) === "[]" &&
    emptyCfg.pack === null &&
    emptyCfg.hasGlobalBudget === false &&
    emptyCfg.tenantBudgetCount === 0 &&
    (emptyCfg.webhooks || {}).hasUrl === false &&
    (emptyCfg.webhooks || {}).hasSecret === false &&
    assertRuntimeConfigSafe(emptyCfg).ok === true;
  if (!cfgOk || !cfgSafe.ok || !emptyCfgOk) {
    console.error("smoke failed summarizeRuntimeConfig", { cfgPayload, cfgSafe, emptyCfg });
    process.exit(1);
  }
  if (!Array.isArray(r.budgetBreaches) || r.budgetBreaches.length !== 0) {
    console.error("smoke default report should have empty budgetBreaches", r.budgetBreaches);
    process.exit(1);
  }
  const acmeHighSpans = [
    {
      timestamp: "2024-08-11T12:00:00.000Z",
      attributes: {
        "gen_ai.request.model": "gpt-4o",
        "gen_ai.usage.input_tokens": 5000,
        "gen_ai.usage.output_tokens": 1000,
        tenant: "acme",
      },
    },
    {
      timestamp: "2024-08-11T13:00:00.000Z",
      attributes: {
        "gen_ai.request.model": "gpt-4o-mini",
        "gen_ai.usage.input_tokens": 2000,
        "gen_ai.usage.output_tokens": 500,
      },
    },
  ];
  const tbHigh = report(acmeHighSpans, DEFAULT_PRICES, {
    tenantBudgets: parseTenantBudgets("acme=0.01"),
  });
  const acmeHigh = (tbHigh.byTenant || []).find((t) => t.tenant === "acme");
  const acmeBreach = (tbHigh.budgetBreaches || []).find((b) => b.tenant === "acme");
  if (
    !acmeHigh ||
    !(Number(acmeHigh.usd) > 0.01) ||
    !acmeBreach ||
    acmeBreach.tenant !== "acme" ||
    !(Number(acmeBreach.usd) > Number(acmeBreach.budget)) ||
    Number(acmeBreach.budget) !== 0.01 ||
    (tbHigh.budgetBreaches || []).some((b) => b.tenant === "_")
  ) {
    console.error("smoke tenant-budget acme=0.01 failed", {
      acmeHigh,
      budgetBreaches: tbHigh.budgetBreaches,
    });
    process.exit(1);
  }
  const tbUnderscoreSkip = report(acmeHighSpans, DEFAULT_PRICES, {
    tenantBudgets: { acme: 999 },
  });
  if ((tbUnderscoreSkip.budgetBreaches || []).length !== 0) {
    console.error("smoke _ catch-all must not gate without explicit budget", tbUnderscoreSkip.budgetBreaches);
    process.exit(1);
  }
  const tbUnderscoreGate = report(acmeHighSpans, DEFAULT_PRICES, { tenantBudgets: { _: 0 } });
  if (!(tbUnderscoreGate.budgetBreaches || []).some((b) => b.tenant === "_")) {
    console.error("smoke explicit _ budget should gate", tbUnderscoreGate.budgetBreaches);
    process.exit(1);
  }
  const tbMissing = report(acmeHighSpans, DEFAULT_PRICES, { tenantBudgets: {} });
  if (!Array.isArray(tbMissing.budgetBreaches) || tbMissing.budgetBreaches.length !== 0) {
    console.error("smoke missing tenant budgets must not extra-breach", tbMissing.budgetBreaches);
    process.exit(1);
  }
  const globalStill = checkBudget(tbHigh, { maxTotalUsd: 0.000001 });
  if (globalStill.ok || globalStill.breaches.length < 1) {
    console.error("smoke global --budget still independent", globalStill);
    process.exit(1);
  }
  const ghaNone = formatGha(r);
  const ghaTenant = formatGha(tbHigh);
  const ghaGlobal = formatGha(r, { budget: { maxTotalUsd: 0.000001 } });
  const ghaBoth = formatGha(tbHigh, { budget: { maxTotalUsd: 0.000001 } });
  const ghaEmpty = formatGha(report([]));
  const ghaPct = formatGha({
    totalUsd: 1,
    budgetBreaches: [{ tenant: "foo:bar,baz%\n", usd: 1, budget: 0.1 }],
  });
  const ghaOk =
    ghaNone === "" &&
    !ghaNone.includes("::error") &&
    ghaEmpty === "" &&
    !ghaEmpty.includes("::error") &&
    ghaTenant.includes("::error") &&
    ghaTenant.includes("title=tenant/acme::") &&
    ghaTenant.includes("usd ") &&
    ghaTenant.includes(" > budget ") &&
    !ghaTenant.includes("title=budget::") &&
    ghaGlobal.includes("::error title=budget::") &&
    ghaGlobal.includes("totalUsd ") &&
    ghaGlobal.includes(" > budget ") &&
    ghaBoth.includes("::error title=budget::") &&
    ghaBoth.includes("title=tenant/acme::") &&
    ghaPct.includes("%25") &&
    ghaPct.includes("%0A") &&
    ghaPct.includes("%3A") &&
    ghaPct.includes("%2C") &&
    ghaPct.includes("::error title=tenant/foo%3Abar%2Cbaz%25%0A::");
  if (!ghaOk) {
    console.error("smoke gha annotations failed", { ghaNone, ghaTenant, ghaGlobal, ghaBoth, ghaPct, ghaEmpty });
    process.exit(1);
  }
  const tenantHookCheck = tenantBudgetWebhookCheck(tbHigh);
  const tenantHookPayload = buildWebhookPayload(tenantHookCheck);
  const tenantHookOk =
    tenantHookCheck.ok === false &&
    tenantHookPayload.ok === false &&
    tenantHookPayload.tenant === "acme" &&
    Array.isArray(tenantHookPayload.breaches) &&
    tenantHookPayload.breaches.some((b) => b.tenant === "acme") &&
    typeof tenantHookPayload.totalUsd === "number" &&
    !("token" in tenantHookPayload) &&
    !("secret" in tenantHookPayload) &&
    JSON.stringify(tenantHookPayload).indexOf("sk-") === -1;
  if (!tenantHookOk) {
    console.error("smoke tenant webhook payload failed", tenantHookPayload);
    process.exit(1);
  }
  {
    const calls = [];
    const fetchFn = async (_url, init) => {
      calls.push(init);
      return { status: 200 };
    };
    await notifyBudgetBreach("http://127.0.0.1:9/hook", tenantHookCheck, {
      fetchFn,
      sleepFn: async () => {},
      retryDelayMs: 0,
    });
    if (calls.length !== 1) {
      console.error("smoke tenant webhook call count", calls.length);
      process.exit(1);
    }
    let body;
    try {
      body = JSON.parse(calls[0].body);
    } catch {
      body = null;
    }
    if (!body || body.tenant !== "acme" || body.ok !== false || !Array.isArray(body.breaches)) {
      console.error("smoke tenant webhook body missing tenant acme", calls[0] && calls[0].body);
      process.exit(1);
    }
    const hmacBodyTb = calls[0].body;
    const sig = signWebhookBody("whsec_tenant", hmacBodyTb);
    if (!verifyWebhookSignature("whsec_tenant", hmacBodyTb, sig)) {
      console.error("smoke tenant webhook HMAC of raw body failed");
      process.exit(1);
    }
  }
  {
    const calls = [];
    await notifyBudgetBreach("http://127.0.0.1:9/hook", tenantBudgetWebhookCheck(tbMissing), {
      fetchFn: async (_url, init) => {
        calls.push(init);
        return { status: 200 };
      },
    });
    if (calls.length !== 0) {
      console.error("smoke missing tenant budgets must not extra webhook", calls.length);
      process.exit(1);
    }
  }

  const metricsSnap = renderCostMetrics(r);
  if (
    !metricsSnap.includes("otel_ai_cost_total_usd") ||
    !metricsSnap.includes("otel_ai_cost_by_model_usd") ||
    !metricsSnap.includes("otel_ai_cost_span_count") ||
    !metricsSnap.includes("otel_ai_cost_by_tenant_usd") ||
    !metricsSnap.includes("otel_ai_cost_budget_remaining_usd") ||
    !metricsSnap.includes("otel_ai_cost_budget_deny_total") ||
    !metricsSnap.includes("otel_ai_cost_input_tokens") ||
    !metricsSnap.includes("otel_ai_cost_output_tokens") ||
    !metricsSnap.includes('# TYPE otel_ai_cost_total_usd gauge') ||
    !metricsSnap.includes('# TYPE otel_ai_cost_span_count counter') ||
    !metricsSnap.includes('# TYPE otel_ai_cost_budget_deny_total counter')
  ) {
    console.error("smoke metrics render failed", metricsSnap);
    process.exit(1);
  }
  const tbMetrics = renderCostMetrics(tbHigh, { tenantBudgets: { acme: 0.01 } });
  if (
    !tbMetrics.includes('otel_ai_cost_by_tenant_usd{tenant="acme"}') ||
    !tbMetrics.includes("otel_ai_cost_budget_remaining_usd{tenant=\"acme\"}") ||
    !tbMetrics.includes("otel_ai_cost_budget_deny_total{tenant=\"acme\"}")
  ) {
    console.error("smoke tenant/budget metrics failed", tbMetrics);
    process.exit(1);
  }
  const remain = tenantBudgetRemaining(tbHigh.byTenant, { acme: 0.01 });
  const acmeRemain = remain.find((x) => x.tenant === "acme");
  if (!acmeRemain || !(Number(acmeRemain.remaining) < 0)) {
    console.error("smoke tenantBudgetRemaining expected negative acme", remain);
    process.exit(1);
  }
  const remainHtml = formatHtml(tbHigh, { tenantBudgets: { acme: 0.01 } });
  if (
    !remainHtml.includes('id="budget-remaining"') ||
    !remainHtml.includes("remaining") ||
    !remainHtml.includes("acme") ||
    !remainHtml.includes(Number(acmeRemain.remaining).toFixed(6)) ||
    !remainHtml.includes("period: cumulative")
  ) {
    console.error("smoke formatHtml remaining table failed");
    process.exit(1);
  }
  const remainDayHtml = formatHtml(tbHigh, { tenantBudgets: { acme: 0.01 }, period: "day", remaining: remain });
  if (!remainDayHtml.includes("period: UTC day") || !remainDayHtml.includes('id="budget-remaining"')) {
    console.error("smoke formatHtml remaining period label failed");
    process.exit(1);
  }
  const denyPass = applyBudgetDeny(demoSpans, r, {});
  const denyHit = applyBudgetDeny(demoSpans, tbHigh, { acme: 0.01 });
  if (denyPass.denied !== 0 || denyPass.kept.length !== demoSpans.length) {
    console.error("smoke applyBudgetDeny no-budget should keep all", denyPass);
    process.exit(1);
  }
  if (denyHit.denied < 1 || !denyHit.deniedSpans.some((s) => (s.attributes || {}).tenant === "acme")) {
    console.error("smoke applyBudgetDeny should deny acme when breached", denyHit);
    process.exit(1);
  }
  if (denyHit.kept.length + denyHit.denied !== demoSpans.length) {
    console.error("smoke applyBudgetDeny kept+denied must cover input", denyHit);
    process.exit(1);
  }
  const denyCheck = ingestDenyWebhookCheck(denyHit, tbHigh, { acme: 0.01 });
  const denyPayload = buildWebhookPayload(denyCheck);
  const denyPayloadBlob = JSON.stringify(denyPayload);
  if (
    denyCheck.ok !== false ||
    denyCheck.tenant !== "acme" ||
    !(Number(denyCheck.denied) >= 1) ||
    !(Number(denyCheck.spend) > 0.01) ||
    Number(denyCheck.budget) !== 0.01 ||
    denyPayload.tenant !== "acme" ||
    Number(denyPayload.denied) !== Number(denyCheck.denied) ||
    Number(denyPayload.spend) !== Number(denyCheck.spend) ||
    Number(denyPayload.budget) !== 0.01 ||
    denyPayloadBlob.includes("SECRET") ||
    denyPayloadBlob.includes("gen_ai.prompt")
  ) {
    console.error("smoke ingestDenyWebhookCheck failed", denyCheck, denyPayload);
    process.exit(1);
  }
  const denySkip = ingestDenyWebhookCheck(denyPass, r, {});
  if (denySkip.ok !== true || Number(denySkip.denied) !== 0) {
    console.error("smoke ingestDenyWebhookCheck no-deny should be ok", denySkip);
    process.exit(1);
  }
  const underSpan = {
    timestamp: "2024-08-18T00:00:00.000Z",
    attributes: {
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 1000,
      "gen_ai.usage.output_tokens": 0,
      tenant: "acme",
    },
  };
  const incomingCross = {
    timestamp: "2024-08-18T01:00:00.000Z",
    attributes: {
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 1000,
      "gen_ai.usage.output_tokens": 0,
      tenant: "acme",
      "gen_ai.prompt": "SECRET_PROMPT_WOULD_EXCEED",
    },
  };
  const underReport = report([underSpan], DEFAULT_PRICES, { tenantBudgets: { acme: 0.0002 } });
  const underUsd = Number((underReport.byTenant || []).find((t) => t.tenant === "acme")?.usd);
  if (!(underUsd > 0) || !(underUsd < 0.0002)) {
    console.error("smoke would-exceed fixture must be just under budget", underReport.byTenant);
    process.exit(1);
  }
  if (!wouldExceedBudget(underUsd, 0.00015, 0.0002) || wouldExceedBudget(underUsd, 0.00015, 0.0003)) {
    console.error("smoke wouldExceedBudget exact/over failed", { underUsd });
    process.exit(1);
  }
  const wouldHit = applyBudgetDeny([incomingCross], underReport, { acme: 0.0002 });
  if (wouldHit.denied !== 1 || wouldHit.kept.length !== 0) {
    console.error("smoke applyBudgetDeny would-exceed should deny", wouldHit, underReport);
    process.exit(1);
  }
  const exactHit = applyBudgetDeny([incomingCross], underReport, { acme: 0.0003 });
  if (exactHit.denied !== 0 || exactHit.kept.length !== 1) {
    console.error("smoke applyBudgetDeny exact-on-budget should allow", exactHit, underReport);
    process.exit(1);
  }
  const oldWould = applyBudgetDeny([incomingCross], underReport, { acme: 0.0002 }, { denyOnWouldExceed: false });
  if (oldWould.denied !== 0 || oldWould.kept.length !== 1) {
    console.error("smoke applyBudgetDeny DENY_ON_WOULD_EXCEED=false should allow until already over", oldWould);
    process.exit(1);
  }
  const wouldFlagOk =
    ENV_DENY_ON_WOULD_EXCEED === "DENY_ON_WOULD_EXCEED" &&
    resolveDenyOnWouldExceed(null, {}) === true &&
    resolveDenyOnWouldExceed(null, { [ENV_DENY_ON_WOULD_EXCEED]: "false" }) === false &&
    resolveDenyOnWouldExceed(null, { [ENV_DENY_ON_WOULD_EXCEED]: "0" }) === false &&
    resolveDenyOnWouldExceed(false, { [ENV_DENY_ON_WOULD_EXCEED]: "true" }) === false &&
    resolveDenyOnWouldExceed(true, { [ENV_DENY_ON_WOULD_EXCEED]: "false" }) === true;
  if (!wouldFlagOk) {
    console.error("smoke resolveDenyOnWouldExceed failed");
    process.exit(1);
  }
  const wouldCheck = ingestDenyWebhookCheck(wouldHit, underReport, { acme: 0.0002 });
  const wouldPayload = buildWebhookPayload(wouldCheck);
  const wouldBlob = JSON.stringify(wouldPayload);
  if (
    wouldCheck.ok !== false ||
    wouldCheck.tenant !== "acme" ||
    Number(wouldCheck.denied) !== 1 ||
    Number(wouldCheck.spend) !== underUsd ||
    Number(wouldCheck.budget) !== 0.0002 ||
    Number(wouldPayload.denied) !== 1 ||
    wouldBlob.includes("SECRET_PROMPT_WOULD_EXCEED") ||
    wouldBlob.includes("gen_ai.prompt")
  ) {
    console.error("smoke would-exceed webhook check leaked or mismatched", wouldCheck, wouldPayload);
    process.exit(1);
  }

  const tokenMathUsd = spanCost({
    attributes: {
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 1000,
      "gen_ai.usage.output_tokens": 0,
    },
  }).usd;
  const attrSpan = {
    timestamp: "2024-08-18T00:00:00.000Z",
    attributes: {
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 1000,
      "gen_ai.usage.output_tokens": 0,
      [COST_USD_ATTR]: 1.23,
      tenant: "acme",
    },
  };
  const attrCost = spanCost(attrSpan);
  if (
    COST_USD_ATTR !== "gen_ai.cost.usd" ||
    spanCostUsdAttr(attrSpan) !== 1.23 ||
    attrCost.usd !== 1.23 ||
    attrCost.usd === tokenMathUsd ||
    Number(tokenMathUsd) !== 0.00015
  ) {
    console.error("smoke gen_ai.cost.usd must win over token×price", { attrCost, tokenMathUsd });
    process.exit(1);
  }
  const attrReport = report([attrSpan], DEFAULT_PRICES);
  if (Number(attrReport.totalUsd) !== 1.23) {
    console.error("smoke report spend must match gen_ai.cost.usd", attrReport);
    process.exit(1);
  }
  const fallbackCases = [undefined, null, "", "nope", -1, Infinity, NaN, true, { doubleValue: 1.23 }];
  for (const bad of fallbackCases) {
    const span = {
      attributes: {
        "gen_ai.request.model": "gpt-4o-mini",
        "gen_ai.usage.input_tokens": 1000,
        "gen_ai.usage.output_tokens": 0,
      },
    };
    if (bad !== undefined) span.attributes[COST_USD_ATTR] = bad;
    const got = spanCost(span).usd;
    if (got !== tokenMathUsd) {
      console.error("smoke invalid gen_ai.cost.usd must fall back to token×price", { bad, got, tokenMathUsd });
      process.exit(1);
    }
  }
  const zeroCost = spanCost({
    attributes: {
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 1000,
      "gen_ai.usage.output_tokens": 0,
      [COST_USD_ATTR]: 0,
    },
  });
  if (zeroCost.usd !== 0) {
    console.error("smoke gen_ai.cost.usd=0 must be used", zeroCost);
    process.exit(1);
  }
  const otlpExtracted = extractIngestSpans({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                timestamp: "2024-08-18T00:00:00.000Z",
                attributes: [
                  { key: "gen_ai.request.model", value: { stringValue: "gpt-4o-mini" } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: 1000 } },
                  { key: "gen_ai.usage.output_tokens", value: { intValue: 0 } },
                  { key: COST_USD_ATTR, value: { doubleValue: 1.23 } },
                  { key: "tenant", value: { stringValue: "acme" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  if (!otlpExtracted.length || spanCost(otlpExtracted[0]).usd !== 1.23) {
    console.error("smoke OTLP doubleValue gen_ai.cost.usd failed", otlpExtracted);
    process.exit(1);
  }
  const seedAttr = {
    timestamp: "2024-08-18T00:00:00.000Z",
    attributes: {
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 1,
      "gen_ai.usage.output_tokens": 0,
      [COST_USD_ATTR]: 0.4,
      tenant: "acme",
    },
  };
  const incomingAttr = {
    timestamp: "2024-08-18T01:00:00.000Z",
    attributes: {
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 1,
      "gen_ai.usage.output_tokens": 0,
      [COST_USD_ATTR]: 0.2,
      tenant: "acme",
      "gen_ai.prompt": "SECRET_PROMPT_COST_ATTR",
    },
  };
  const seedAttrReport = report([seedAttr], DEFAULT_PRICES, { tenantBudgets: { acme: 0.5 } });
  const seedAttrUsd = Number((seedAttrReport.byTenant || []).find((t) => t.tenant === "acme")?.usd);
  if (seedAttrUsd !== 0.4) {
    console.error("smoke attr seed spend must be 0.4 not token math", seedAttrReport);
    process.exit(1);
  }
  const attrWould = applyBudgetDeny([incomingAttr], seedAttrReport, { acme: 0.5 });
  if (attrWould.denied !== 1 || attrWould.kept.length !== 0) {
    console.error("smoke would-exceed must use gen_ai.cost.usd incoming", attrWould, seedAttrReport);
    process.exit(1);
  }
  const incomingTokOnly = {
    timestamp: "2024-08-18T01:00:00.000Z",
    attributes: {
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 1,
      "gen_ai.usage.output_tokens": 0,
      tenant: "acme",
    },
  };
  const tokWould = applyBudgetDeny([incomingTokOnly], seedAttrReport, { acme: 0.5 });
  if (tokWould.denied !== 0 || tokWould.kept.length !== 1) {
    console.error("smoke token-only incoming should stay under 0.5", tokWould);
    process.exit(1);
  }
  const attrDenyCheck = ingestDenyWebhookCheck(attrWould, seedAttrReport, { acme: 0.5 });
  const attrDenyPayload = buildWebhookPayload(attrDenyCheck);
  const attrDenyBlob = JSON.stringify(attrDenyPayload);
  if (
    attrDenyCheck.ok !== false ||
    attrDenyCheck.tenant !== "acme" ||
    Number(attrDenyCheck.spend) !== 0.4 ||
    Number(attrDenyCheck.budget) !== 0.5 ||
    Number(attrDenyCheck.denied) !== 1 ||
    Number(attrDenyPayload.spend) !== 0.4 ||
    attrDenyBlob.includes("SECRET_PROMPT_COST_ATTR") ||
    attrDenyBlob.includes("gen_ai.prompt")
  ) {
    console.error("smoke webhook spend must use gen_ai.cost.usd", attrDenyCheck, attrDenyPayload);
    process.exit(1);
  }

  const hookOk =
    resolveWebhookUrl(null, {}) == null &&
    resolveWebhookUrl(null, { [ENV_WEBHOOK_URL]: "http://127.0.0.1:9/hook" }) ===
      "http://127.0.0.1:9/hook" &&
    resolveWebhookUrl("", { [ENV_WEBHOOK_URL]: "http://x" }) == null &&
    resolveWebhookUrl("http://cli/hook", { [ENV_WEBHOOK_URL]: "http://env/hook" }) ===
      "http://cli/hook" &&
    parseWebhookUrl("  ") == null &&
    parseWebhookUrl(null) == null &&
    resolveWebhookSecret(null, {}) == null &&
    resolveWebhookSecret(null, { [ENV_WEBHOOK_SECRET]: "whsec_env" }) === "whsec_env" &&
    resolveWebhookSecret("", { [ENV_WEBHOOK_SECRET]: "whsec_env" }) == null &&
    resolveWebhookSecret("whsec_cli", { [ENV_WEBHOOK_SECRET]: "whsec_env" }) ===
      "whsec_cli" &&
    DEFAULT_TIMEOUT_MS > 0 &&
    DEFAULT_TIMEOUT_MS <= 2000;
  if (!hookOk) {
    console.error("smoke failed webhook resolve");
    process.exit(1);
  }
  const hookPayload = buildWebhookPayload(fail);
  const hookPayloadOk =
    hookPayload.ok === false &&
    Array.isArray(hookPayload.breaches) &&
    hookPayload.breaches.length >= 1 &&
    typeof hookPayload.totalUsd === "number" &&
    Object.keys(hookPayload).length === 3 &&
    "ok" in hookPayload &&
    "breaches" in hookPayload &&
    "totalUsd" in hookPayload;
  if (!hookPayloadOk) {
    console.error("smoke failed webhook payload", hookPayload);
    process.exit(1);
  }
  const hmacBody = '{"ok":false,"totalUsd":1}';
  const hmacSig = signWebhookBody("whsec_smoke", hmacBody);
  const hmacOk =
    hmacSig.startsWith("sha256=") &&
    hmacSig.length === "sha256=".length + 64 &&
    verifyWebhookSignature("whsec_smoke", hmacBody, hmacSig) &&
    verifyWebhookSignature("whsec_smoke", hmacBody, hmacSig.toUpperCase()) &&
    !verifyWebhookSignature("whsec_other", hmacBody, hmacSig) &&
    !verifyWebhookSignature("whsec_smoke", hmacBody, null) &&
    !verifyWebhookSignature(null, hmacBody, hmacSig) &&
    !verifyWebhookSignature("whsec_smoke", "tampered", hmacSig);
  if (!hmacOk) {
    console.error("smoke failed webhook HMAC sign/verify", hmacSig);
    process.exit(1);
  }
  const tsNow = webhookUnixSeconds();
  const wall = Math.floor(Date.now() / 1000);
  const tsOk =
    TIMESTAMP_HEADER === "X-Webhook-Timestamp" &&
    Math.abs(wall - tsNow) <= 2 &&
    webhookUnixSeconds(1700000000900) === 1700000000;
  if (!tsOk) {
    console.error("smoke failed webhook timestamp", { tsNow, wall, TIMESTAMP_HEADER });
    process.exit(1);
  }

  const retryPolicyOk =
    DEFAULT_RETRY_DELAY_MS === 50 &&
    shouldRetryWebhook({ status: 500 }) &&
    shouldRetryWebhook({ status: 503 }) &&
    shouldRetryWebhook({ status: 599 }) &&
    shouldRetryWebhook({ error: new Error("network") }) &&
    !shouldRetryWebhook({ status: 200 }) &&
    !shouldRetryWebhook({ status: 204 }) &&
    !shouldRetryWebhook({ status: 400 }) &&
    !shouldRetryWebhook({ status: 404 }) &&
    !shouldRetryWebhook({ status: 429 }) &&
    !shouldRetryWebhook({});
  if (!retryPolicyOk) {
    console.error("smoke failed webhook shouldRetryWebhook policy");
    process.exit(1);
  }

  async function runNotify(fetchFn, extra = {}) {
    const sleepCalls = [];
    await notifyBudgetBreach("http://127.0.0.1:9/hook", fail, {
      fetchFn,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
      retryDelayMs: extra.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      secret: extra.secret,
    });
    return { sleepCalls };
  }

  {
    const calls = [];
    const fetchFn = async (_url, init) => {
      calls.push(init);
      return { status: 200 };
    };
    const { sleepCalls } = await runNotify(fetchFn);
    if (calls.length !== 1 || sleepCalls.length !== 0) {
      console.error("smoke failed webhook no-retry on 200", { calls: calls.length, sleepCalls });
      process.exit(1);
    }
  }
  {
    const calls = [];
    const fetchFn = async (_url, init) => {
      calls.push(init);
      return { status: 400 };
    };
    const { sleepCalls } = await runNotify(fetchFn);
    if (calls.length !== 1 || sleepCalls.length !== 0) {
      console.error("smoke failed webhook no-retry on 4xx", { calls: calls.length, sleepCalls });
      process.exit(1);
    }
  }
  {
    const calls = [];
    const fetchFn = async (_url, init) => {
      calls.push(init);
      if (calls.length === 1) return { status: 500 };
      return { status: 200 };
    };
    const { sleepCalls } = await runNotify(fetchFn);
    if (
      calls.length !== 2 ||
      sleepCalls.length !== 1 ||
      sleepCalls[0] !== DEFAULT_RETRY_DELAY_MS ||
      calls[0].body !== calls[1].body
    ) {
      console.error("smoke failed webhook retry on 5xx", { calls: calls.length, sleepCalls });
      process.exit(1);
    }
  }
  {
    const calls = [];
    const fetchFn = async (_url, init) => {
      calls.push(init);
      if (calls.length === 1) throw new Error("ECONNRESET");
      return { status: 200 };
    };
    const { sleepCalls } = await runNotify(fetchFn);
    if (calls.length !== 2 || sleepCalls.length !== 1) {
      console.error("smoke failed webhook retry on network error", { calls: calls.length, sleepCalls });
      process.exit(1);
    }
  }
  {
    const calls = [];
    const fetchFn = async (_url, init) => {
      calls.push(init);
      if (calls.length === 1) return { status: 503 };
      return { status: 200 };
    };
    await notifyBudgetBreach("http://127.0.0.1:9/hook", fail, {
      fetchFn,
      sleepFn: async () => {},
      retryDelayMs: 0,
      secret: "whsec_retry",
    });
    if (calls.length !== 2) {
      console.error("smoke failed webhook HMAC retry call count", calls.length);
      process.exit(1);
    }
    const sig0 = calls[0].headers?.[SIGNATURE_HEADER] || calls[0].headers?.["X-Webhook-Signature"];
    const sig1 = calls[1].headers?.[SIGNATURE_HEADER] || calls[1].headers?.["X-Webhook-Signature"];
    const expected = signWebhookBody("whsec_retry", calls[0].body);
    if (sig0 !== expected || sig1 !== expected) {
      console.error("smoke failed webhook HMAC retry signatures", { sig0, sig1, expected });
      process.exit(1);
    }
    const ts0 = calls[0].headers?.[TIMESTAMP_HEADER];
    const ts1 = calls[1].headers?.[TIMESTAMP_HEADER];
    if (!ts0 || !ts1) {
      console.error("smoke failed webhook timestamp on retry", { ts0, ts1 });
      process.exit(1);
    }
  }

  try {
    await notifyBudgetBreach(null, fail);
    await notifyBudgetBreach("http://127.0.0.1:1/nope", { ok: true, breaches: [], totalUsd: 0 });
    await notifyBudgetBreach("http://127.0.0.1:1/nope", fail, { timeoutMs: 50, retryDelayMs: 0 });
    await notifyBudgetBreach("http://127.0.0.1:1/nope", fail, {
      timeoutMs: 50,
      secret: "whsec_smoke",
      retryDelayMs: 0,
    });
  } catch (e) {
    console.error("smoke failed webhook notify swallow", e);
    process.exit(1);
  }
  const rl = new SlidingWindowRateLimiter(60);
  if (!rl.check("127.0.0.1", 2).allowed) {
    console.error("smoke failed rate_limit first hit");
    process.exit(1);
  }
  if (!rl.check("127.0.0.1", 2).allowed) {
    console.error("smoke failed rate_limit second hit");
    process.exit(1);
  }
  const denied = rl.check("127.0.0.1", 2);
  if (denied.allowed || denied.retryAfter < 1) {
    console.error("smoke failed rate_limit sliding window", denied);
    process.exit(1);
  }
  if (!rl.check("10.0.0.1", 2).allowed) {
    console.error("smoke failed rate_limit ip isolation");
    process.exit(1);
  }
  if (
    !skipRateLimit("/health") ||
    !skipRateLimit("/ready") ||
    !skipRateLimit("/metrics") ||
    skipRateLimit("/report.json") ||
    skipRateLimit("/v1/costs.csv") ||
    skipRateLimit("/v1/costs.md") ||
    skipRateLimit("/v1/costs.gha.txt") ||
    skipRateLimit("/v1/budgets") ||
    skipRateLimit("/v1/models") ||
    skipRateLimit("/v1/config") ||
    skipRateLimit("/v1/spans") ||
    skipRateLimit("/v1/tenants") ||
    skipRateLimit("/v1/tenants.csv") ||
    skipRateLimit("/") ||
    skipRateLimit("/v1/traces") ||
    skipRateLimit("/v1/otlp/v1/traces")
  ) {
    console.error("smoke failed rate_limit skip paths");
    process.exit(1);
  }
  if (clientIpFromReq({ headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }) !== "1.2.3.4") {
    console.error("smoke failed rate_limit xff first hop");
    process.exit(1);
  }
  if (clientIpFromReq({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }) !== "127.0.0.1") {
    console.error("smoke failed rate_limit socket fallback");
    process.exit(1);
  }
  if (
    resolveRateLimit(undefined, {}) !== DEFAULT_RATE_LIMIT_PER_MINUTE ||
    resolveRateLimit("2", { [ENV_RATE_LIMIT_PER_MINUTE]: "9" }) !== 2 ||
    resolveRateLimit(undefined, { [ENV_RATE_LIMIT_PER_MINUTE]: "3" }) !== 3 ||
    resolveRateLimit(undefined, { [ENV_RATE_LIMIT_RPM]: "4" }) !== 4 ||
    resolveRateLimit("0", {}) !== null
  ) {
    console.error("smoke failed rate_limit resolve");
    process.exit(1);
  }

  const cors = normalizeCors(["http://localhost:3000"]);
  const star = normalizeCors(["*"]);
  const pfOk = handlePreflight({ headers: { origin: "http://localhost:3000" } }, cors) || {};
  const pfEvil = handlePreflight({ headers: { origin: "http://evil.example" } }, cors) || {};
  const corsOk =
    cors != null &&
    originAllowed("http://localhost:3000", cors) &&
    !originAllowed("http://evil.example", cors) &&
    acaoValue("http://localhost:3000", cors) === "http://localhost:3000" &&
    acaoValue("http://evil.example", cors) == null &&
    pfOk.status === 204 &&
    pfEvil.status === 403 &&
    handlePreflight({ headers: { origin: "http://localhost:3000" } }, null) == null &&
    normalizeCors([]) == null &&
    normalizeCors(null) == null &&
    star != null &&
    originAllowed("http://evil.example", star) &&
    acaoValue("http://evil.example", star) === "*" &&
    corsResponseHeaders({ headers: { origin: "http://localhost:3000" } }, cors)[
      "access-control-allow-origin"
    ] === "http://localhost:3000" &&
    !("access-control-allow-origin" in
      corsResponseHeaders({ headers: { origin: "http://evil.example" } }, cors)) &&
    JSON.stringify(parseCorsOrigins("")) === "[]" &&
    JSON.stringify(parseCorsOrigins("http://localhost:3000, *")) ===
      JSON.stringify(["http://localhost:3000", "*"]) &&
    JSON.stringify(resolveCorsOrigins(null, {})) === "[]" &&
    JSON.stringify(resolveCorsOrigins(null, { [ENV_CORS_ORIGINS]: "http://localhost:3000" })) ===
      JSON.stringify(["http://localhost:3000"]) &&
    JSON.stringify(resolveCorsOrigins("", { [ENV_CORS_ORIGINS]: "*" })) === "[]" &&
    JSON.stringify(resolveCorsOrigins("*", {})) === JSON.stringify(["*"]) &&
    DEFAULT_CORS_METHODS.includes("GET") &&
    DEFAULT_CORS_METHODS.includes("POST") &&
    DEFAULT_CORS_METHODS.includes("OPTIONS") &&
    DEFAULT_CORS_HEADERS.includes("Content-Type") &&
    DEFAULT_CORS_HEADERS.includes("Authorization") &&
    DEFAULT_CORS_HEADERS.includes("X-Request-Id") &&
    DEFAULT_CORS_EXPOSE_HEADERS.includes("X-Request-Id") &&
    DEFAULT_CORS_EXPOSE_HEADERS.some((h) => /^retry-after$/i.test(h)) &&
    (cors.headers || []).includes("X-Request-Id") &&
    (cors.expose || []).includes("X-Request-Id") &&
    (cors.expose || []).some((h) => /^retry-after$/i.test(h)) &&
    String((pfOk.headers || {})["access-control-allow-headers"] || "").includes("Content-Type") &&
    String((pfOk.headers || {})["access-control-allow-headers"] || "").includes("X-Request-Id") &&
    String(
      corsResponseHeaders({ headers: { origin: "http://localhost:3000" } }, cors)[
        "access-control-expose-headers"
      ] || ""
    ).includes("X-Request-Id") &&
    /retry-after/i.test(
      String(
        corsResponseHeaders({ headers: { origin: "http://localhost:3000" } }, cors)[
          "access-control-expose-headers"
        ] || ""
      )
    ) &&
    /retry-after/i.test(String((pfOk.headers || {})["access-control-expose-headers"] || ""));
  if (!corsOk) {
    console.error("smoke cors failed");
    process.exit(1);
  }

  const customRid = "mvp-req-id-a1b2c3d4";
  const ridOk =
    resolveRequestId({ headers: { "x-request-id": customRid } }) === customRid &&
    isUuid(resolveRequestId({ headers: {} })) &&
    isUuid(resolveRequestId({ headers: { "x-request-id": "  " } })) &&
    sanitizeRequestId("foo\r\nX-Injected: 1") === "fooX-Injected: 1" &&
    sanitizeRequestId("x".repeat(200)).length === 128 &&
    sanitizeRequestId("") === null;
  if (!ridOk) {
    console.error("smoke failed X-Request-Id resolve/sanitize");
    process.exit(1);
  }

  const accessLine = formatAccessLog({
    service: "otel-ai-cost",
    method: "GET",
    path: "/report.json",
    status: 200,
    durationMs: 12,
    requestId: "test-log-1",
  });
  let accessObj;
  try {
    accessObj = JSON.parse(accessLine);
  } catch {
    accessObj = null;
  }
  const accessOk =
    accessObj &&
    accessObj.level === "info" &&
    accessObj.msg === "http" &&
    accessObj.service === "otel-ai-cost" &&
    accessObj.method === "GET" &&
    accessObj.path === "/report.json" &&
    accessObj.status === 200 &&
    accessObj.requestId === "test-log-1" &&
    typeof accessObj.durationMs === "number" &&
    accessObj.durationMs === 12 &&
    accessLine.includes('"msg":"http"') &&
    shouldSkipAccessLog("GET", "/metrics") &&
    shouldSkipAccessLog("GET", "/health") &&
    shouldSkipAccessLog("GET", "/ready") &&
    shouldSkipAccessLog("OPTIONS", "/report.json") &&
    !shouldSkipAccessLog("GET", "/report.json") &&
    !shouldSkipAccessLog("GET", "/v1/costs.csv") &&
    !shouldSkipAccessLog("GET", "/v1/costs.md") &&
    !shouldSkipAccessLog("GET", "/v1/costs.gha.txt") &&
    !shouldSkipAccessLog("GET", "/v1/costs") &&
    !shouldSkipAccessLog("GET", "/v1/budgets") &&
    !shouldSkipAccessLog("GET", "/v1/models") &&
    !shouldSkipAccessLog("GET", "/v1/config") &&
    !shouldSkipAccessLog("GET", "/v1/spans") &&
    !shouldSkipAccessLog("GET", "/v1/tenants") &&
    !shouldSkipAccessLog("GET", "/v1/tenants.csv") &&
    !shouldSkipAccessLog("POST", "/v1/traces") &&
    resolveLogJson(undefined, {}) === false &&
    resolveLogJson(undefined, { LOG_FORMAT: "json" }) === true &&
    resolveLogJson(true, {}) === true &&
    resolveLogJson(false, { LOG_FORMAT: "json" }) === false;
  if (!accessOk) {
    console.error("smoke failed JSON access log format/resolve", accessLine);
    process.exit(1);
  }

  const specPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../openapi/cost.openapi.json");
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  } catch (e) {
    console.error("smoke failed openapi load", e);
    process.exit(1);
  }
  const specPaths = spec.paths || {};
  const specNeed = ["/health", "/ready", "/", "/report.json", "/v1/costs.csv", "/v1/costs.md", "/v1/costs.gha.txt", "/v1/costs", "/v1/budgets", "/v1/models", "/v1/config", "/v1/spans", "/v1/tenants", "/v1/tenants.csv", "/metrics", "/openapi.json"];
  const specMissing = specNeed.filter((p) => !specPaths[p] || !specPaths[p].get);
  const specDesc = String((spec.info || {}).description || "");
  const specParams = (spec.components || {}).parameters || {};
  const specHeaders = (spec.components || {}).headers || {};
  const specResponses = (spec.components || {}).responses || {};
  const openapiOk =
    !specMissing.length &&
    String(spec.openapi || "").startsWith("3.") &&
    specResponses.CorsDenied &&
    (specDesc.includes("403") || specDesc.includes("cors_denied")) &&
    (specDesc.includes("X-Request-Id") || specDesc.includes("requestId")) &&
    specParams.XRequestId &&
    specHeaders.XRequestId &&
    ((specPaths["/health"] || {}).get || {}).operationId === "getHealth" &&
    ((specPaths["/ready"] || {}).get || {}).operationId === "getReady" &&
    Boolean((((specPaths["/ready"] || {}).get || {}).responses || {})["503"]) &&
    JSON.stringify((spec.components || {}).schemas || {}).includes("shutting_down") &&
    ((specPaths["/report.json"] || {}).get || {}).operationId === "getReport" &&
    ((specPaths["/v1/costs.csv"] || {}).get || {}).operationId === "getCostsCsv" &&
    ((specPaths["/v1/costs.md"] || {}).get || {}).operationId === "getCostsMd" &&
    ((specPaths["/v1/costs.gha.txt"] || {}).get || {}).operationId === "getCostsGha" &&
    ((specPaths["/v1/costs"] || {}).get || {}).operationId === "getCosts" &&
    ((specPaths["/v1/budgets"] || {}).get || {}).operationId === "getBudgets" &&
    Boolean((((specPaths["/v1/budgets"] || {}).get || {}).responses || {})["200"]) &&
    JSON.stringify((spec.components || {}).schemas?.Budgets || {}).includes("globalUsd") &&
    JSON.stringify((spec.components || {}).schemas?.Budgets || {}).includes("tenants") &&
    (specDesc.includes("/v1/budgets") || specDesc.includes("globalUsd")) &&
    ((specPaths["/v1/models"] || {}).get || {}).operationId === "getModels" &&
    Boolean((((specPaths["/v1/models"] || {}).get || {}).responses || {})["200"]) &&
    JSON.stringify((spec.components || {}).schemas?.Models || {}).includes("models") &&
    JSON.stringify((spec.components || {}).schemas?.ModelRate || {}).includes("inputPerMTok") &&
    (specDesc.includes("/v1/models") || specDesc.includes("pricing catalog")) &&
    ((specPaths["/v1/config"] || {}).get || {}).operationId === "getConfig" &&
    Boolean((((specPaths["/v1/config"] || {}).get || {}).responses || {})["200"]) &&
    JSON.stringify((spec.components || {}).schemas?.RuntimeConfig || {}).includes("spanCap") &&
    JSON.stringify((spec.components || {}).schemas?.RuntimeConfig || {}).includes("hasGlobalBudget") &&
    (specDesc.includes("/v1/config") || specDesc.includes("getConfig") || specDesc.includes("runtime config")) &&
    ((specPaths["/v1/spans"] || {}).get || {}).operationId === "listSpans" &&
    Boolean((((specPaths["/v1/spans"] || {}).get || {}).responses || {})["200"]) &&
    Boolean((((specPaths["/v1/spans"] || {}).get || {}).responses || {})["403"]) &&
    Boolean((((specPaths["/v1/spans"] || {}).get || {}).responses || {})["429"]) &&
    JSON.stringify((spec.components || {}).schemas?.SpanList || {}).includes("truncated") &&
    JSON.stringify((spec.components || {}).schemas?.SpanSummary || {}).includes("inputTokens") &&
    JSON.stringify((spec.components || {}).schemas?.SpanSummary || {}).includes("outputTokens") &&
    (specDesc.includes("/v1/spans") || specDesc.includes("listSpans") || specDesc.includes("span summaries")) &&
    ((specPaths["/v1/tenants"] || {}).get || {}).operationId === "listTenants" &&
    Boolean((((specPaths["/v1/tenants"] || {}).get || {}).responses || {})["200"]) &&
    Boolean((((specPaths["/v1/tenants"] || {}).get || {}).responses || {})["403"]) &&
    Boolean((((specPaths["/v1/tenants"] || {}).get || {}).responses || {})["429"]) &&
    ((specPaths["/v1/tenants.csv"] || {}).get || {}).operationId === "getTenantsCsv" &&
    Boolean((((specPaths["/v1/tenants.csv"] || {}).get || {}).responses || {})["200"]) &&
    Boolean((((specPaths["/v1/tenants.csv"] || {}).get || {}).responses || {})["403"]) &&
    Boolean((((specPaths["/v1/tenants.csv"] || {}).get || {}).responses || {})["429"]) &&
    JSON.stringify((spec.components || {}).schemas?.TenantList || {}).includes("truncated") &&
    JSON.stringify((spec.components || {}).schemas?.TenantSpend || {}).includes("spanCount") &&
    JSON.stringify((spec.components || {}).schemas?.TenantSpend || {}).includes("budgetUsd") &&
    (specDesc.includes("/v1/tenants") || specDesc.includes("listTenants") || specDesc.includes("tenant inventory")) &&
    (specDesc.includes("/v1/tenants.csv") || specDesc.includes("getTenantsCsv") || specDesc.includes("spend_usd")) &&
    (specDesc.includes("/v1/costs.md") || specDesc.includes("text/markdown") || specDesc.includes("format=md")) &&
    (specDesc.includes("/v1/costs.gha.txt") || specDesc.includes("format=gha") || specDesc.includes("::error")) &&
    ((specPaths["/metrics"] || {}).get || {}).operationId === "getMetrics" &&
    specResponses.RateLimited &&
    Boolean((((specPaths["/report.json"] || {}).get || {}).responses || {})["429"]) &&
    (specDesc.includes("rate_limited") || specDesc.includes("429")) &&
    specDesc.includes("Retry-After") &&
    /retry-after/i.test(JSON.stringify((spec.components || {}).schemas?.CorsConfig || {})) &&
    JSON.stringify((spec.components || {}).schemas?.DailyReport || {}).includes("budgetBreaches") &&
    JSON.stringify((spec.components || {}).schemas?.BudgetBreach || {}).includes("tenant") &&
    ((specPaths["/v1/traces"] || {}).post || {}).operationId === "postTraces" &&
    Boolean((((specPaths["/v1/traces"] || {}).post || {}).responses || {})["200"]) &&
    Boolean((((specPaths["/v1/traces"] || {}).post || {}).responses || {})["400"]) &&
    Boolean((((specPaths["/v1/traces"] || {}).post || {}).responses || {})["401"]) &&
    JSON.stringify((spec.components || {}).schemas?.IngestAccepted || {}).includes("denied") &&
    (specDesc.includes("ingest deny") || specDesc.includes("denied request") || specDesc.includes("once per denied")) &&
    (specDesc.includes("/v1/traces") || specDesc.includes("OTLP"));
  if (!openapiOk) {
    console.error("smoke failed openapi", { specMissing, traces: specPaths["/v1/traces"] });
    process.exit(1);
  }

  const served = createReportServer({ spans: demoSpans, groupBy: "day", version: VERSION });
  const addr = await listen(served.server, 0, "127.0.0.1");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const healthRes = await fetch(`${base}/health`);
    const health = await healthRes.json();
    if (!healthRes.ok || health.ok !== true || typeof health.totalUsd !== "number") {
      console.error("smoke serve /health failed", health);
      process.exit(1);
    }
    const readyRes = await fetch(`${base}/ready`);
    const ready = await readyRes.json();
    if (
      readyRes.status !== 200 ||
      ready.ok !== true ||
      ready.service !== "otel-ai-cost" ||
      typeof ready.totalUsd !== "number"
    ) {
      console.error("smoke serve /ready failed", readyRes.status, ready);
      process.exit(1);
    }
    const drainOk =
      resolveDrainMs(200) === 200 &&
      resolveDrainMs(-1) === DEFAULT_SHUTDOWN_DRAIN_MS &&
      resolveDrainMs(99999) === MAX_SHUTDOWN_DRAIN_MS &&
      resolveDrainMs(undefined, { SHUTDOWN_DRAIN_MS: "250" }) === 250;
    if (!drainOk) {
      console.error("smoke failed resolveDrainMs");
      process.exit(1);
    }
    const readyRid = readyRes.headers.get("x-request-id");
    if (!readyRid || !isUuid(readyRid)) {
      console.error("smoke serve /ready missing generated X-Request-Id", readyRid);
      process.exit(1);
    }
    const genRid = healthRes.headers.get("x-request-id");
    if (!genRid || !isUuid(genRid)) {
      console.error("smoke serve /health missing generated X-Request-Id", genRid);
      process.exit(1);
    }
    const customHealthRid = "mvp-health-rid-e1";
    const healthCustom = await fetch(`${base}/health`, { headers: { "X-Request-Id": customHealthRid } });
    if (!healthCustom.ok || healthCustom.headers.get("x-request-id") !== customHealthRid) {
      console.error("smoke serve /health custom X-Request-Id failed", healthCustom.headers.get("x-request-id"));
      process.exit(1);
    }
    const oaRid = "mvp-oa-rid-e1";
    const oaRes = await fetch(`${base}/openapi.json`, { headers: { "X-Request-Id": oaRid } });
    if (!oaRes.ok || oaRes.headers.get("x-request-id") !== oaRid) {
      console.error("smoke serve /openapi.json custom X-Request-Id failed", oaRes.headers.get("x-request-id"));
      process.exit(1);
    }
    const html = await (await fetch(`${base}/`)).text();
    if (!html.includes("<svg") || !html.includes("TOTAL") || !html.includes("by day (UTC)")) {
      console.error("smoke serve / html failed");
      process.exit(1);
    }
    const payload = await (await fetch(`${base}/report.json`)).json();
    if (
      typeof payload.totalUsd !== "number" ||
      payload.groupBy !== "day" ||
      !Array.isArray(payload.byTenant) ||
      !payload.byTenant.some((t) => t.tenant === "acme" && Number.isFinite(Number(t.usd))) ||
      !Array.isArray(payload.budgetBreaches)
    ) {
      console.error("smoke serve /report.json failed", payload);
      process.exit(1);
    }
    const csvRes = await fetch(`${base}/v1/costs.csv`);
    const csvText = await csvRes.text();
    const csvCt = String(csvRes.headers.get("content-type") || "");
    const csvQ = await fetch(`${base}/v1/costs?format=csv`);
    const csvQText = await csvQ.text();
    const csvQCt = String(csvQ.headers.get("content-type") || "");
    const csvJson = await (await fetch(`${base}/v1/costs`)).json();
    const csvBad = await fetch(`${base}/v1/costs?format=nope`);
    const csvBadBody = await csvBad.json();
    if (
      !csvRes.ok ||
      csvRes.status !== 200 ||
      !csvCt.includes("text/csv") ||
      !csvText.startsWith("date,model,spanCount,usd") ||
      csvText.trimEnd().split(/\n/).length < 2 ||
      !Number.isFinite(Number((csvText.trimEnd().split(/\n/).find((ln) => ln && !ln.startsWith("date") && !ln.startsWith("TOTAL") && !ln.startsWith("#")) || "").split(",")[3])) ||
      csvQ.status !== 200 ||
      !csvQCt.includes("text/csv") ||
      csvQText !== csvText ||
      typeof csvJson.totalUsd !== "number" ||
      !Array.isArray(csvJson.byTenant) ||
      !csvJson.byTenant.some((t) => t.tenant === "acme" && Number.isFinite(Number(t.usd))) ||
      !csvText.includes("acme") ||
      !csvText.split(/\n/)[0].split(",").includes("tenant") ||
      csvBad.status !== 400 ||
      csvBadBody.error !== "bad_format"
    ) {
      console.error("smoke serve /v1/costs.csv failed", csvRes.status, csvCt, csvText.slice(0, 200), csvBad.status, csvBadBody);
      process.exit(1);
    }
    const csvRid = "mvp-csv-rid-e1";
    const csvCustom = await fetch(`${base}/v1/costs.csv`, { headers: { "X-Request-Id": csvRid } });
    if (!csvCustom.ok || csvCustom.headers.get("x-request-id") !== csvRid) {
      console.error("smoke serve /v1/costs.csv custom X-Request-Id failed", csvCustom.headers.get("x-request-id"));
      process.exit(1);
    }
    const mdRes = await fetch(`${base}/v1/costs.md`);
    const mdText = await mdRes.text();
    const mdCt = String(mdRes.headers.get("content-type") || "");
    const mdQ = await fetch(`${base}/v1/costs?format=md`);
    const mdQText = await mdQ.text();
    const mdQCt = String(mdQ.headers.get("content-type") || "");
    if (
      mdRes.status !== 200 ||
      !mdCt.includes("text/markdown") ||
      !mdText.includes("# ") ||
      !mdText.includes("totalUsd") ||
      !mdText.includes("|") ||
      !mdText.includes("| model | usd | spans |") ||
      !mdText.includes("| tenant | usd | spans |") ||
      !mdText.includes("acme") ||
      mdQ.status !== 200 ||
      !mdQCt.includes("text/markdown") ||
      mdQText !== mdText
    ) {
      console.error("smoke serve /v1/costs.md failed", mdRes.status, mdCt, mdText.slice(0, 240), mdQ.status);
      process.exit(1);
    }
    const mdRid = "mvp-md-rid-e1";
    const mdCustom = await fetch(`${base}/v1/costs.md`, { headers: { "X-Request-Id": mdRid } });
    if (!mdCustom.ok || mdCustom.headers.get("x-request-id") !== mdRid) {
      console.error("smoke serve /v1/costs.md custom X-Request-Id failed", mdCustom.headers.get("x-request-id"));
      process.exit(1);
    }
    const ghaRes = await fetch(`${base}/v1/costs.gha.txt`);
    const ghaText = await ghaRes.text();
    const ghaCt = String(ghaRes.headers.get("content-type") || "");
    const ghaQ = await fetch(`${base}/v1/costs?format=gha`);
    const ghaQText = await ghaQ.text();
    const ghaQCt = String(ghaQ.headers.get("content-type") || "");
    const ghaAnn = await fetch(`${base}/v1/costs?format=annotations`);
    const ghaAnnText = await ghaAnn.text();
    if (
      ghaRes.status !== 200 ||
      !ghaCt.includes("text/plain") ||
      ghaText.includes("::error") ||
      ghaQ.status !== 200 ||
      !ghaQCt.includes("text/plain") ||
      ghaQText !== ghaText ||
      ghaAnn.status !== 200 ||
      ghaAnnText !== ghaText
    ) {
      console.error("smoke serve /v1/costs.gha.txt no-budget failed", ghaRes.status, ghaCt, ghaText.slice(0, 240), ghaQ.status);
      process.exit(1);
    }
    const ghaRid = "mvp-gha-rid-e1";
    const ghaCustom = await fetch(`${base}/v1/costs.gha.txt`, { headers: { "X-Request-Id": ghaRid } });
    if (!ghaCustom.ok || ghaCustom.headers.get("x-request-id") !== ghaRid) {
      console.error("smoke serve /v1/costs.gha.txt custom X-Request-Id failed", ghaCustom.headers.get("x-request-id"));
      process.exit(1);
    }
    const budgetsRes = await fetch(`${base}/v1/budgets`);
    const budgetsBody = await budgetsRes.json();
    const budgetsCt = String(budgetsRes.headers.get("content-type") || "");
    if (
      budgetsRes.status !== 200 ||
      !budgetsCt.includes("application/json") ||
      budgetsBody.ok !== true ||
      budgetsBody.globalUsd !== null ||
      !budgetsBody.tenants ||
      typeof budgetsBody.tenants !== "object" ||
      Array.isArray(budgetsBody.tenants) ||
      Object.keys(budgetsBody.tenants).length !== 0 ||
      "token" in budgetsBody ||
      "secret" in budgetsBody ||
      JSON.stringify(budgetsBody).indexOf("sk-") !== -1
    ) {
      console.error("smoke serve /v1/budgets default none failed", budgetsRes.status, budgetsBody);
      process.exit(1);
    }
    const budgetsRid = "mvp-budgets-rid-e1";
    const budgetsCustom = await fetch(`${base}/v1/budgets`, { headers: { "X-Request-Id": budgetsRid } });
    if (!budgetsCustom.ok || budgetsCustom.headers.get("x-request-id") !== budgetsRid) {
      console.error("smoke serve /v1/budgets custom X-Request-Id failed", budgetsCustom.headers.get("x-request-id"));
      process.exit(1);
    }
    const modelsRes = await fetch(`${base}/v1/models`);
    const modelsBody = await modelsRes.json();
    const modelsCt = String(modelsRes.headers.get("content-type") || "");
    const defaultIds = Object.keys(DEFAULT_PRICES);
    const modelIds = (modelsBody.models || []).map((m) => m.id);
    const gptHttp = (modelsBody.models || []).find((m) => m.id === "gpt-4o");
    if (
      modelsRes.status !== 200 ||
      !modelsCt.includes("application/json") ||
      modelsBody.ok !== true ||
      !Array.isArray(modelsBody.models) ||
      modelsBody.models.length < 1 ||
      !defaultIds.some((id) => modelIds.includes(id)) ||
      !gptHttp ||
      Number(gptHttp.inputPerMTok) !== Number(DEFAULT_PRICES["gpt-4o"].inputPerMTok) ||
      Number(gptHttp.outputPerMTok) !== Number(DEFAULT_PRICES["gpt-4o"].outputPerMTok) ||
      modelsBody.defaultModel !== null ||
      modelsBody.pack !== null ||
      "token" in modelsBody ||
      "secret" in modelsBody ||
      JSON.stringify(modelsBody).indexOf("sk-") !== -1
    ) {
      console.error("smoke serve /v1/models default pack failed", modelsRes.status, modelsBody);
      process.exit(1);
    }
    const modelsRid = "mvp-models-rid-e1";
    const modelsCustom = await fetch(`${base}/v1/models`, { headers: { "X-Request-Id": modelsRid } });
    if (!modelsCustom.ok || modelsCustom.headers.get("x-request-id") !== modelsRid) {
      console.error("smoke serve /v1/models custom X-Request-Id failed", modelsCustom.headers.get("x-request-id"));
      process.exit(1);
    }
    const configRes = await fetch(`${base}/v1/config`);
    const configBody = await configRes.json();
    const configCt = String(configRes.headers.get("content-type") || "");
    const configBlob = JSON.stringify(configBody);
    const configSafe = assertRuntimeConfigSafe(configBody);
    if (
      configRes.status !== 200 ||
      !configCt.includes("application/json") ||
      configBody.ok !== true ||
      (configBody.spanCap == null && !((configBody.cors || {}).origins)) ||
      (configBody.webhooks || {}).hasUrl !== false ||
      (configBody.webhooks || {}).hasSecret !== false ||
      configBody.hasGlobalBudget !== false ||
      configBody.tenantBudgetCount !== 0 ||
      !configSafe.ok ||
      "token" in configBody ||
      "secret" in configBody ||
      configBlob.includes("sk-") ||
      configBlob.includes("webhookUrl") ||
      configBlob.includes("webhookSecret")
    ) {
      console.error("smoke serve /v1/config default failed", configRes.status, configBody, configSafe);
      process.exit(1);
    }
    const configRid = "mvp-config-rid-e1";
    const configCustom = await fetch(`${base}/v1/config`, { headers: { "X-Request-Id": configRid } });
    if (!configCustom.ok || configCustom.headers.get("x-request-id") !== configRid) {
      console.error("smoke serve /v1/config custom X-Request-Id failed", configCustom.headers.get("x-request-id"));
      process.exit(1);
    }
    const spansRes = await fetch(`${base}/v1/spans`);
    const spansBody = await spansRes.json();
    const spansCt = String(spansRes.headers.get("content-type") || "");
    const spansBlob = JSON.stringify(spansBody);
    const firstSpan = (spansBody.spans || [])[0];
    if (
      spansRes.status !== 200 ||
      !spansCt.includes("application/json") ||
      spansBody.ok !== true ||
      !Array.isArray(spansBody.spans) ||
      Number(spansBody.count) < 1 ||
      spansBody.spans.length < 1 ||
      !firstSpan ||
      !firstSpan.model ||
      !("id" in firstSpan) ||
      !("tenant" in firstSpan) ||
      !("inputTokens" in firstSpan) ||
      !("outputTokens" in firstSpan) ||
      !("usd" in firstSpan) ||
      !("ts" in firstSpan) ||
      spansBlob.includes("SECRET_PROMPT") ||
      spansBlob.includes("gen_ai.prompt") ||
      spansBlob.includes("gen_ai.completion") ||
      "attributes" in firstSpan
    ) {
      console.error("smoke serve /v1/spans loaded failed", spansRes.status, spansBody);
      process.exit(1);
    }
    const spansRid = "mvp-spans-rid-e1";
    const spansCustom = await fetch(`${base}/v1/spans`, { headers: { "X-Request-Id": spansRid } });
    if (!spansCustom.ok || spansCustom.headers.get("x-request-id") !== spansRid) {
      console.error("smoke serve /v1/spans custom X-Request-Id failed", spansCustom.headers.get("x-request-id"));
      process.exit(1);
    }
    const tenantsRes = await fetch(`${base}/v1/tenants`);
    const tenantsBody = await tenantsRes.json();
    const tenantsCt = String(tenantsRes.headers.get("content-type") || "");
    const tenantsBlob = JSON.stringify(tenantsBody);
    const firstTenant = (tenantsBody.tenants || [])[0];
    const tenantIds = (tenantsBody.tenants || []).map((t) => t.id);
    if (
      tenantsRes.status !== 200 ||
      !tenantsCt.includes("application/json") ||
      tenantsBody.ok !== true ||
      !Array.isArray(tenantsBody.tenants) ||
      Number(tenantsBody.count) < 1 ||
      tenantsBody.tenants.length < 1 ||
      !firstTenant ||
      !(tenantIds.includes("acme") || tenantIds.includes("_")) ||
      typeof firstTenant.usd !== "number" ||
      !Number.isInteger(firstTenant.spanCount) ||
      "budgetUsd" in firstTenant ||
      tenantsBlob.includes("SECRET_PROMPT") ||
      tenantsBlob.includes("sk-secret") ||
      tenantsBlob.includes("Authorization") ||
      tenantsBlob.includes("gen_ai.prompt") ||
      "attributes" in firstTenant
    ) {
      console.error("smoke serve /v1/tenants loaded failed", tenantsRes.status, tenantsBody);
      process.exit(1);
    }
    const tenantsRid = "mvp-tenants-rid-e1";
    const tenantsCustom = await fetch(`${base}/v1/tenants`, { headers: { "X-Request-Id": tenantsRid } });
    if (!tenantsCustom.ok || tenantsCustom.headers.get("x-request-id") !== tenantsRid) {
      console.error("smoke serve /v1/tenants custom X-Request-Id failed", tenantsCustom.headers.get("x-request-id"));
      process.exit(1);
    }
    const tenantsUnknown = await (await fetch(`${base}/v1/tenants?tenant=no-such-tenant`)).json();
    if (tenantsUnknown.ok !== true || tenantsUnknown.count !== 0 || (tenantsUnknown.tenants || []).length !== 0) {
      console.error("smoke serve /v1/tenants unknown filter failed", tenantsUnknown);
      process.exit(1);
    }
    const tenantsAcme = await (await fetch(`${base}/v1/tenants?tenant=acme`)).json();
    if (
      tenantsAcme.ok !== true ||
      tenantsAcme.count !== 1 ||
      (tenantsAcme.tenants || [])[0]?.id !== "acme" ||
      typeof (tenantsAcme.tenants || [])[0]?.usd !== "number"
    ) {
      console.error("smoke serve /v1/tenants acme filter failed", tenantsAcme);
      process.exit(1);
    }
    const metricsRes = await fetch(`${base}/metrics`);
    const metricsText = await metricsRes.text();
    const metricsCt = String(metricsRes.headers.get("content-type") || "");
    if (
      !metricsRes.ok ||
      !metricsCt.includes("text/plain") ||
      !metricsText.includes("otel_ai_cost_total_usd") ||
      !metricsText.includes("otel_ai_cost_by_model_usd") ||
      !metricsText.includes("otel_ai_cost_span_count") ||
      !metricsText.includes("otel_ai_cost_by_tenant_usd") ||
      !metricsText.includes("otel_ai_cost_budget_deny_total") ||
      !metricsText.includes("otel_ai_cost_input_tokens")
    ) {
      console.error("smoke serve /metrics failed", metricsRes.status, metricsCt, metricsText.slice(0, 200));
      process.exit(1);
    }
    if (WATCH_POLL_MS !== 200) {
      console.error("smoke WATCH_POLL_MS expected 200", WATCH_POLL_MS);
      process.exit(1);
    }
    const extraSpans = [...demoSpans, demoSpans[0]];
    const reloaded = served.reload(extraSpans);
    if (!reloaded || reloaded.health.spanCount !== demoSpans.length + 1) {
      console.error("smoke serve reload snapshot failed", reloaded && reloaded.health);
      process.exit(1);
    }
    const healthAfter = await (await fetch(`${base}/health`)).json();
    const readyAfter = await (await fetch(`${base}/ready`)).json();
    const payloadAfter = await (await fetch(`${base}/report.json`)).json();
    const htmlAfter = await (await fetch(`${base}/`)).text();
    const metricsAfter = await (await fetch(`${base}/metrics`)).text();
    const oaAfter = await (await fetch(`${base}/openapi.json`)).json();
    const csvAfter = await (await fetch(`${base}/v1/costs.csv`)).text();
    const mdAfter = await (await fetch(`${base}/v1/costs.md`)).text();
    if (
      healthAfter.spanCount !== demoSpans.length + 1 ||
      !(healthAfter.totalUsd > health.totalUsd) ||
      readyAfter.spanCount !== healthAfter.spanCount ||
      !(payloadAfter.totalUsd > payload.totalUsd) ||
      !htmlAfter.includes("TOTAL") ||
      !metricsAfter.includes("otel_ai_cost_total_usd") ||
      !metricsAfter.includes(`otel_ai_cost_span_count ${demoSpans.length + 1}`) ||
      !String((oaAfter.info || {}).title || "").length ||
      !csvAfter.startsWith("date,model,spanCount,usd") ||
      !csvAfter.includes("TOTAL") ||
      !mdAfter.includes("# ") ||
      !mdAfter.includes("totalUsd") ||
      !mdAfter.includes(`**spans:** ${demoSpans.length + 1}`)
    ) {
      console.error("smoke serve reload HTTP failed", {
        healthAfter,
        readyAfter,
        totalUsd: payloadAfter.totalUsd,
      });
      process.exit(1);
    }
    // default deny: OPTIONS 404, GET with Origin has no ACAO
    const optDeny = await fetch(`${base}/health`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
        "X-Request-Id": "mvp-opt-rid-404",
      },
    });
    if (optDeny.status !== 404 || optDeny.headers.get("access-control-allow-origin")) {
      console.error("smoke default OPTIONS CORS failed", optDeny.status);
      process.exit(1);
    }
    if (optDeny.headers.get("x-request-id") !== "mvp-opt-rid-404") {
      console.error("smoke default OPTIONS missing X-Request-Id", optDeny.headers.get("x-request-id"));
      process.exit(1);
    }
    const getDeny = await fetch(`${base}/health`, { headers: { Origin: "http://localhost:3000" } });
    if (!getDeny.ok || getDeny.headers.get("access-control-allow-origin")) {
      console.error("smoke default GET CORS failed");
      process.exit(1);
    }
    served.beginShutdown();
    const readySd = await fetch(`${base}/ready`);
    const readySdBody = await readySd.json();
    if (
      readySd.status !== 503 ||
      readySdBody.ok !== false ||
      readySdBody.reason !== "shutting_down"
    ) {
      console.error("smoke serve /ready shutting_down failed", readySd.status, readySdBody);
      process.exit(1);
    }
    const healthSd = await fetch(`${base}/health`);
    const healthSdBody = await healthSd.json();
    if (
      healthSd.status !== 200 ||
      healthSdBody.ok !== true ||
      healthSdBody.shuttingDown !== true
    ) {
      console.error("smoke serve /health shuttingDown failed", healthSd.status, healthSdBody);
      process.exit(1);
    }
  } finally {
    await closeServer(served.server);
  }

  const tbServed = createReportServer({
    spans: acmeHighSpans,
    groupBy: "day",
    version: VERSION,
    tenantBudgets: parseTenantBudgets("acme=0.01"),
  });
  const tbAddr = await listen(tbServed.server, 0, "127.0.0.1");
  try {
    const tbJson = await (await fetch(`http://127.0.0.1:${tbAddr.port}/report.json`)).json();
    const tbCosts = await (await fetch(`http://127.0.0.1:${tbAddr.port}/v1/costs`)).json();
    const tbHtml = await (await fetch(`http://127.0.0.1:${tbAddr.port}/`)).text();
    const tbCsv = await (await fetch(`http://127.0.0.1:${tbAddr.port}/v1/costs.csv`)).text();
    const tbGhaRes = await fetch(`http://127.0.0.1:${tbAddr.port}/v1/costs.gha.txt`);
    const tbGha = await tbGhaRes.text();
    const tbGhaCt = String(tbGhaRes.headers.get("content-type") || "");
    const tbGhaQ = await (await fetch(`http://127.0.0.1:${tbAddr.port}/v1/costs?format=gha`)).text();
    const tbBudgetsRes = await fetch(`http://127.0.0.1:${tbAddr.port}/v1/budgets`);
    const tbBudgets = await tbBudgetsRes.json();
    if (
      !Array.isArray(tbJson.budgetBreaches) ||
      !tbJson.budgetBreaches.some((b) => b.tenant === "acme" && Number(b.usd) > Number(b.budget)) ||
      !Array.isArray(tbCosts.budgetBreaches) ||
      !tbCosts.budgetBreaches.some((b) => b.tenant === "acme") ||
      !tbHtml.includes("tenant budget breaches") ||
      !tbCsv.startsWith("date,model,spanCount,usd") ||
      !tbCsv.split(",")[0].includes("date") ||
      !tbCsv.includes("acme") ||
      tbGhaRes.status !== 200 ||
      !tbGhaCt.includes("text/plain") ||
      !tbGha.includes("::error") ||
      !tbGha.includes("title=tenant/acme::") ||
      tbGhaQ !== tbGha ||
      tbBudgetsRes.status !== 200 ||
      tbBudgets.ok !== true ||
      tbBudgets.globalUsd !== null ||
      Number(tbBudgets.tenants?.acme) !== 0.01 ||
      "token" in tbBudgets ||
      JSON.stringify(tbBudgets).indexOf("sk-") !== -1
    ) {
      console.error("smoke serve tenant-budget JSON/gha/budgets failed", tbJson.budgetBreaches, tbGha, tbBudgets);
      process.exit(1);
    }
  } finally {
    await closeServer(tbServed.server);
  }

  const ghaBudgetServed = createReportServer({
    spans: demoSpans,
    groupBy: "day",
    version: VERSION,
    budget: { maxTotalUsd: 0.000001 },
  });
  const ghaBudgetAddr = await listen(ghaBudgetServed.server, 0, "127.0.0.1");
  try {
    const gbRes = await fetch(`http://127.0.0.1:${ghaBudgetAddr.port}/v1/costs.gha.txt`);
    const gbText = await gbRes.text();
    const gbCt = String(gbRes.headers.get("content-type") || "");
    if (
      gbRes.status !== 200 ||
      !gbCt.includes("text/plain") ||
      !gbText.includes("::error title=budget::") ||
      !gbText.includes("totalUsd ") ||
      !gbText.includes(" > budget ")
    ) {
      console.error("smoke serve global budget gha failed", gbRes.status, gbCt, gbText);
      process.exit(1);
    }
  } finally {
    await closeServer(ghaBudgetServed.server);
  }

  const budgetsTenServed = createReportServer({
    spans: demoSpans,
    groupBy: "day",
    version: VERSION,
    tenantBudgets: parseTenantBudgets("acme=10"),
    budget: { maxTotalUsd: 7 },
  });
  const budgetsTenAddr = await listen(budgetsTenServed.server, 0, "127.0.0.1");
  try {
    const b10http = await (await fetch(`http://127.0.0.1:${budgetsTenAddr.port}/v1/budgets`)).json();
    if (
      b10http.ok !== true ||
      Number(b10http.globalUsd) !== 7 ||
      Number(b10http.tenants?.acme) !== 10 ||
      Object.keys(b10http.tenants || {}).length !== 1
    ) {
      console.error("smoke serve /v1/budgets acme=10 failed", b10http);
      process.exit(1);
    }
    const t10http = await (await fetch(`http://127.0.0.1:${budgetsTenAddr.port}/v1/tenants`)).json();
    const acmeSpend = (t10http.tenants || []).find((t) => t.id === "acme");
    const otherSpend = (t10http.tenants || []).find((t) => t.id !== "acme");
    if (
      t10http.ok !== true ||
      !acmeSpend ||
      Number(acmeSpend.budgetUsd) !== 10 ||
      (otherSpend && "budgetUsd" in otherSpend)
    ) {
      console.error("smoke serve /v1/tenants budgetUsd acme=10 failed", t10http);
      process.exit(1);
    }
  } finally {
    await closeServer(budgetsTenServed.server);
  }

  const cfgHttpServed = createReportServer({
    spans: demoSpans,
    groupBy: "day",
    version: VERSION,
    corsOrigins: ["http://localhost:3000"],
    rateLimit: 0,
    tenantBudgets: parseTenantBudgets("acme=10"),
    budget: { maxTotalUsd: 7 },
    pack: "redact-basic",
    spanMax: 100,
    webhookUrl: "http://127.0.0.1:9/hook?token=http_url_token_must_not_leak",
    webhookSecret: "http_whsec_must_not_leak",
  });
  const cfgHttpAddr = await listen(cfgHttpServed.server, 0, "127.0.0.1");
  try {
    const cfgHttpRes = await fetch(`http://127.0.0.1:${cfgHttpAddr.port}/v1/config`, {
      headers: { "X-Request-Id": "smoke-config-rid", Origin: "http://localhost:3000" },
    });
    const cfgHttpBody = await cfgHttpRes.json();
    const cfgHttpBlob = JSON.stringify(cfgHttpBody);
    const cfgHttpSafe = assertRuntimeConfigSafe(cfgHttpBody);
    if (
      cfgHttpRes.status !== 200 ||
      cfgHttpBody.ok !== true ||
      (cfgHttpBody.spanCap == null && !((cfgHttpBody.cors || {}).origins)) ||
      cfgHttpBody.spanCap !== 100 ||
      cfgHttpBody.spansMax !== 100 ||
      (cfgHttpBody.cors || {}).origins?.[0] !== "http://localhost:3000" ||
      (cfgHttpBody.webhooks || {}).hasUrl !== true ||
      (cfgHttpBody.webhooks || {}).hasSecret !== true ||
      cfgHttpBody.hasGlobalBudget !== true ||
      cfgHttpBody.tenantBudgetCount !== 1 ||
      cfgHttpBody.pack !== "redact-basic" ||
      cfgHttpRes.headers.get("x-request-id") !== "smoke-config-rid" ||
      cfgHttpRes.headers.get("access-control-allow-origin") !== "http://localhost:3000" ||
      !cfgHttpSafe.ok ||
      [
        "http_url_token_must_not_leak",
        "http_whsec_must_not_leak",
        "whsec_must_not_leak",
        "planted_url_token",
        "Authorization",
        "webhookUrl",
        "webhookSecret",
      ].some((n) => cfgHttpBlob.includes(n))
    ) {
      console.error("smoke failed GET /v1/config HTTP", cfgHttpRes.status, cfgHttpBody, cfgHttpSafe);
      process.exit(1);
    }
  } finally {
    await closeServer(cfgHttpServed.server);
  }

  const emptyServed = createReportServer({ spans: [], groupBy: "day", version: VERSION });
  const emptyAddr = await listen(emptyServed.server, 0, "127.0.0.1");
  try {
    const emptyCsvRes = await fetch(`http://127.0.0.1:${emptyAddr.port}/v1/costs.csv`);
    const emptyCsvBody = await emptyCsvRes.text();
    const emptyCt = String(emptyCsvRes.headers.get("content-type") || "");
    if (
      emptyCsvRes.status !== 200 ||
      !emptyCt.includes("text/csv") ||
      !emptyCsvBody.trimEnd().startsWith("date,model,spanCount,usd") ||
      !emptyCsvBody.trimEnd().split(",").includes("tenant")
    ) {
      console.error("smoke empty /v1/costs.csv failed", emptyCsvRes.status, emptyCt, emptyCsvBody);
      process.exit(1);
    }
    const emptyMdRes = await fetch(`http://127.0.0.1:${emptyAddr.port}/v1/costs.md`);
    const emptyMdBody = await emptyMdRes.text();
    const emptyMdCt = String(emptyMdRes.headers.get("content-type") || "");
    if (
      emptyMdRes.status !== 200 ||
      !emptyMdCt.includes("text/markdown") ||
      !emptyMdBody.includes("# ") ||
      !emptyMdBody.includes("totalUsd") ||
      !emptyMdBody.includes("**spans:** 0")
    ) {
      console.error("smoke empty /v1/costs.md failed", emptyMdRes.status, emptyMdCt, emptyMdBody);
      process.exit(1);
    }
    const emptyGhaRes = await fetch(`http://127.0.0.1:${emptyAddr.port}/v1/costs.gha.txt`);
    const emptyGhaBody = await emptyGhaRes.text();
    const emptyGhaCt = String(emptyGhaRes.headers.get("content-type") || "");
    if (
      emptyGhaRes.status !== 200 ||
      !emptyGhaCt.includes("text/plain") ||
      emptyGhaBody.includes("::error")
    ) {
      console.error("smoke empty /v1/costs.gha.txt failed", emptyGhaRes.status, emptyGhaCt, emptyGhaBody);
      process.exit(1);
    }
    const emptyBudgetsRes = await fetch(`http://127.0.0.1:${emptyAddr.port}/v1/budgets`);
    const emptyBudgets = await emptyBudgetsRes.json();
    if (
      emptyBudgetsRes.status !== 200 ||
      emptyBudgets.ok !== true ||
      emptyBudgets.globalUsd !== null ||
      Object.keys(emptyBudgets.tenants || {}).length !== 0
    ) {
      console.error("smoke empty /v1/budgets failed", emptyBudgetsRes.status, emptyBudgets);
      process.exit(1);
    }
    const emptyModelsRes = await fetch(`http://127.0.0.1:${emptyAddr.port}/v1/models`);
    const emptyModels = await emptyModelsRes.json();
    const emptyModelIds = (emptyModels.models || []).map((m) => m.id);
    if (
      emptyModelsRes.status !== 200 ||
      emptyModels.ok !== true ||
      !Array.isArray(emptyModels.models) ||
      emptyModels.models.length < 1 ||
      !Object.keys(DEFAULT_PRICES).some((id) => emptyModelIds.includes(id))
    ) {
      console.error("smoke empty /v1/models failed", emptyModelsRes.status, emptyModels);
      process.exit(1);
    }
    const emptyCfgRes = await fetch(`http://127.0.0.1:${emptyAddr.port}/v1/config`);
    const emptyCfgHttp = await emptyCfgRes.json();
    if (
      emptyCfgRes.status !== 200 ||
      emptyCfgHttp.ok !== true ||
      (emptyCfgHttp.spanCap == null && !((emptyCfgHttp.cors || {}).origins)) ||
      emptyCfgHttp.hasGlobalBudget !== false ||
      emptyCfgHttp.tenantBudgetCount !== 0 ||
      (emptyCfgHttp.webhooks || {}).hasUrl !== false ||
      (emptyCfgHttp.webhooks || {}).hasSecret !== false
    ) {
      console.error("smoke empty /v1/config failed", emptyCfgRes.status, emptyCfgHttp);
      process.exit(1);
    }
    const emptySpansRes = await fetch(`http://127.0.0.1:${emptyAddr.port}/v1/spans`);
    const emptySpans = await emptySpansRes.json();
    if (
      emptySpansRes.status !== 200 ||
      emptySpans.ok !== true ||
      emptySpans.count !== 0 ||
      !Array.isArray(emptySpans.spans) ||
      emptySpans.spans.length !== 0 ||
      emptySpans.truncated === true ||
      !emptySpansRes.headers.get("x-request-id")
    ) {
      console.error("smoke empty /v1/spans failed", emptySpansRes.status, emptySpans);
      process.exit(1);
    }
    const emptyTenantsRes = await fetch(`http://127.0.0.1:${emptyAddr.port}/v1/tenants`);
    const emptyTenants = await emptyTenantsRes.json();
    if (
      emptyTenantsRes.status !== 200 ||
      emptyTenants.ok !== true ||
      emptyTenants.count !== 0 ||
      !Array.isArray(emptyTenants.tenants) ||
      emptyTenants.tenants.length !== 0 ||
      emptyTenants.truncated === true ||
      !emptyTenantsRes.headers.get("x-request-id")
    ) {
      console.error("smoke empty /v1/tenants failed", emptyTenantsRes.status, emptyTenants);
      process.exit(1);
    }
    const emptyTenantsCsvRes = await fetch(`http://127.0.0.1:${emptyAddr.port}/v1/tenants.csv`);
    const emptyTenantsCsv = await emptyTenantsCsvRes.text();
    if (
      emptyTenantsCsvRes.status !== 200 ||
      !String(emptyTenantsCsvRes.headers.get("content-type") || "").includes("text/csv") ||
      emptyTenantsCsv !== "tenant,spend_usd,budget_usd,remaining_usd,denied_count\n"
    ) {
      console.error("smoke empty /v1/tenants.csv failed", emptyTenantsCsvRes.status, emptyTenantsCsv);
      process.exit(1);
    }
  } finally {
    await closeServer(emptyServed.server);
  }

  const servedCors = createReportServer({
    spans: demoSpans,
    groupBy: "day",
    version: VERSION,
    corsOrigins: ["http://localhost:3000"],
  });
  const addrCors = await listen(servedCors.server, 0, "127.0.0.1");
  const baseCors = `http://127.0.0.1:${addrCors.port}`;
  try {
    const pfAllow = await fetch(`${baseCors}/health`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET" },
    });
    if (pfAllow.status !== 204 || pfAllow.headers.get("access-control-allow-origin") !== "http://localhost:3000") {
      console.error("smoke CORS preflight allow failed", pfAllow.status);
      process.exit(1);
    }
    const allowH = String(pfAllow.headers.get("access-control-allow-headers") || "").toLowerCase();
    if (!allowH.includes("x-request-id")) {
      console.error("smoke CORS preflight missing X-Request-Id allow header", allowH);
      process.exit(1);
    }
    const pfExpose = String(pfAllow.headers.get("access-control-expose-headers") || "").toLowerCase();
    if (!pfExpose.includes("retry-after")) {
      console.error("smoke CORS preflight missing Retry-After expose header", pfExpose);
      process.exit(1);
    }
    const pfMiss = await fetch(`${baseCors}/health`, {
      method: "OPTIONS",
      headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "GET" },
    });
    const missBody = await pfMiss.json();
    if (pfMiss.status !== 403 || missBody.reason !== "cors_denied" || pfMiss.headers.get("access-control-allow-origin")) {
      console.error("smoke CORS preflight deny failed", pfMiss.status, missBody);
      process.exit(1);
    }
    const getAllow = await fetch(`${baseCors}/health`, { headers: { Origin: "http://localhost:3000" } });
    const getHealth = await getAllow.json();
    if (!getAllow.ok || getHealth.ok !== true || getAllow.headers.get("access-control-allow-origin") !== "http://localhost:3000") {
      console.error("smoke CORS GET /health failed");
      process.exit(1);
    }
    const exposeH = String(getAllow.headers.get("access-control-expose-headers") || "").toLowerCase();
    if (!exposeH.includes("x-request-id") || !getAllow.headers.get("x-request-id")) {
      console.error("smoke CORS GET /health missing expose/echo X-Request-Id");
      process.exit(1);
    }
    if (!exposeH.includes("retry-after")) {
      console.error("smoke CORS GET /health missing expose Retry-After", exposeH);
      process.exit(1);
    }
    const htmlAllow = await fetch(`${baseCors}/`, { headers: { Origin: "http://localhost:3000" } });
    const htmlText = await htmlAllow.text();
    if (
      !htmlText.includes("<svg") ||
      !htmlText.includes("TOTAL") ||
      htmlAllow.headers.get("access-control-allow-origin") !== "http://localhost:3000"
    ) {
      console.error("smoke CORS GET / html failed");
      process.exit(1);
    }
    const jsonAllow = await fetch(`${baseCors}/report.json`, { headers: { Origin: "http://localhost:3000" } });
    const jsonBody = await jsonAllow.json();
    if (
      typeof jsonBody.totalUsd !== "number" ||
      jsonAllow.headers.get("access-control-allow-origin") !== "http://localhost:3000"
    ) {
      console.error("smoke CORS GET /report.json failed", jsonBody);
      process.exit(1);
    }
    const csvAllow = await fetch(`${baseCors}/v1/costs.csv`, { headers: { Origin: "http://localhost:3000" } });
    const csvAllowText = await csvAllow.text();
    if (
      csvAllow.status !== 200 ||
      !String(csvAllow.headers.get("content-type") || "").includes("text/csv") ||
      !csvAllowText.startsWith("date,model,spanCount,usd") ||
      csvAllow.headers.get("access-control-allow-origin") !== "http://localhost:3000" ||
      !csvAllow.headers.get("x-request-id")
    ) {
      console.error("smoke CORS GET /v1/costs.csv failed", csvAllow.status, csvAllowText.slice(0, 120));
      process.exit(1);
    }
    const mdAllow = await fetch(`${baseCors}/v1/costs.md`, { headers: { Origin: "http://localhost:3000" } });
    const mdAllowText = await mdAllow.text();
    if (
      mdAllow.status !== 200 ||
      !String(mdAllow.headers.get("content-type") || "").includes("text/markdown") ||
      !mdAllowText.includes("# ") ||
      !mdAllowText.includes("totalUsd") ||
      mdAllow.headers.get("access-control-allow-origin") !== "http://localhost:3000" ||
      !mdAllow.headers.get("x-request-id")
    ) {
      console.error("smoke CORS GET /v1/costs.md failed", mdAllow.status, mdAllowText.slice(0, 120));
      process.exit(1);
    }
    const ghaAllow = await fetch(`${baseCors}/v1/costs.gha.txt`, { headers: { Origin: "http://localhost:3000" } });
    const ghaAllowText = await ghaAllow.text();
    if (
      ghaAllow.status !== 200 ||
      !String(ghaAllow.headers.get("content-type") || "").includes("text/plain") ||
      ghaAllowText.includes("::error") ||
      ghaAllow.headers.get("access-control-allow-origin") !== "http://localhost:3000" ||
      !ghaAllow.headers.get("x-request-id")
    ) {
      console.error("smoke CORS GET /v1/costs.gha.txt failed", ghaAllow.status, ghaAllowText.slice(0, 120));
      process.exit(1);
    }
    const budgetsAllow = await fetch(`${baseCors}/v1/budgets`, { headers: { Origin: "http://localhost:3000" } });
    const budgetsAllowBody = await budgetsAllow.json();
    if (
      budgetsAllow.status !== 200 ||
      budgetsAllowBody.ok !== true ||
      budgetsAllowBody.globalUsd !== null ||
      Object.keys(budgetsAllowBody.tenants || {}).length !== 0 ||
      budgetsAllow.headers.get("access-control-allow-origin") !== "http://localhost:3000" ||
      !budgetsAllow.headers.get("x-request-id")
    ) {
      console.error("smoke CORS GET /v1/budgets failed", budgetsAllow.status, budgetsAllowBody);
      process.exit(1);
    }
    const modelsAllow = await fetch(`${baseCors}/v1/models`, { headers: { Origin: "http://localhost:3000" } });
    const modelsAllowBody = await modelsAllow.json();
    if (
      modelsAllow.status !== 200 ||
      modelsAllowBody.ok !== true ||
      !Array.isArray(modelsAllowBody.models) ||
      modelsAllowBody.models.length < 1 ||
      !(modelsAllowBody.models || []).some((m) => m.id === "gpt-4o") ||
      modelsAllow.headers.get("access-control-allow-origin") !== "http://localhost:3000" ||
      !modelsAllow.headers.get("x-request-id")
    ) {
      console.error("smoke CORS GET /v1/models failed", modelsAllow.status, modelsAllowBody);
      process.exit(1);
    }
    const configAllow = await fetch(`${baseCors}/v1/config`, { headers: { Origin: "http://localhost:3000" } });
    const configAllowBody = await configAllow.json();
    if (
      configAllow.status !== 200 ||
      configAllowBody.ok !== true ||
      (configAllowBody.spanCap == null && !((configAllowBody.cors || {}).origins)) ||
      configAllow.headers.get("access-control-allow-origin") !== "http://localhost:3000" ||
      !configAllow.headers.get("x-request-id")
    ) {
      console.error("smoke CORS GET /v1/config failed", configAllow.status, configAllowBody);
      process.exit(1);
    }
    const spansAllow = await fetch(`${baseCors}/v1/spans`, { headers: { Origin: "http://localhost:3000" } });
    const spansAllowBody = await spansAllow.json();
    if (
      spansAllow.status !== 200 ||
      spansAllowBody.ok !== true ||
      !Array.isArray(spansAllowBody.spans) ||
      Number(spansAllowBody.count) < 1 ||
      !(spansAllowBody.spans || [])[0]?.model ||
      JSON.stringify(spansAllowBody).includes("SECRET_PROMPT") ||
      spansAllow.headers.get("access-control-allow-origin") !== "http://localhost:3000" ||
      !spansAllow.headers.get("x-request-id")
    ) {
      console.error("smoke CORS GET /v1/spans failed", spansAllow.status, spansAllowBody);
      process.exit(1);
    }
    const tenantsAllow = await fetch(`${baseCors}/v1/tenants`, { headers: { Origin: "http://localhost:3000" } });
    const tenantsAllowBody = await tenantsAllow.json();
    if (
      tenantsAllow.status !== 200 ||
      tenantsAllowBody.ok !== true ||
      !Array.isArray(tenantsAllowBody.tenants) ||
      Number(tenantsAllowBody.count) < 1 ||
      !((tenantsAllowBody.tenants || []).some((t) => t.id === "acme" || t.id === "_")) ||
      JSON.stringify(tenantsAllowBody).includes("SECRET_PROMPT") ||
      tenantsAllow.headers.get("access-control-allow-origin") !== "http://localhost:3000" ||
      !tenantsAllow.headers.get("x-request-id")
    ) {
      console.error("smoke CORS GET /v1/tenants failed", tenantsAllow.status, tenantsAllowBody);
      process.exit(1);
    }
    const metricsAllow = await fetch(`${baseCors}/metrics`, { headers: { Origin: "http://localhost:3000" } });
    const metricsAllowText = await metricsAllow.text();
    if (
      !metricsAllow.ok ||
      !metricsAllowText.includes("otel_ai_cost_total_usd") ||
      !metricsAllowText.includes("otel_ai_cost_by_model_usd") ||
      !metricsAllowText.includes("otel_ai_cost_span_count") ||
      metricsAllow.headers.get("access-control-allow-origin") !== "http://localhost:3000"
    ) {
      console.error("smoke CORS GET /metrics failed", metricsAllow.status, metricsAllowText.slice(0, 200));
      process.exit(1);
    }
    const getEvil = await fetch(`${baseCors}/health`, { headers: { Origin: "http://evil.example" } });
    if (!getEvil.ok || getEvil.headers.get("access-control-allow-origin")) {
      console.error("smoke CORS GET evil origin leaked ACAO");
      process.exit(1);
    }
  } finally {
    await closeServer(servedCors.server);
  }
  const otlpBody = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                name: "chat.completions",
                timestamp: "2024-08-15T00:00:00.000Z",
                attributes: [
                  { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: "2000" } },
                  { key: "gen_ai.usage.output_tokens", value: { intValue: "800" } },
                  { key: "tenant", value: { stringValue: "acme" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const extracted = extractIngestSpans(otlpBody);
  const extractedOk =
    extracted.length === 1 &&
    extracted[0].attributes?.["gen_ai.request.model"] === "gpt-4o" &&
    extracted[0].attributes?.tenant === "acme" &&
    Number(extracted[0].attributes?.["gen_ai.usage.input_tokens"]) === 2000 &&
    extractIngestSpans({ spans: [] }).length === 0 &&
    extractIngestSpans([]).length === 0 &&
    extractIngestSpans({}).length === 0 &&
    extractIngestSpans(demoSpans).length === demoSpans.length &&
    isIngestPath("/v1/traces") &&
    isIngestPath("/v1/otlp/v1/traces") &&
    !isIngestPath("/v1/costs") &&
    resolveIngestToken(null, {}) == null &&
    resolveIngestToken(null, { [ENV_INGEST_TOKEN]: "sec" }) === "sec" &&
    resolveIngestToken("", { [ENV_INGEST_TOKEN]: "sec" }) == null &&
    resolveIngestToken("cli", { [ENV_INGEST_TOKEN]: "sec" }) === "cli" &&
    ingestAuthorized({ headers: {} }, null) &&
    ingestAuthorized({ headers: {} }, "") &&
    !ingestAuthorized({ headers: {} }, "sec") &&
    !ingestAuthorized({ headers: { authorization: "Bearer nope" } }, "sec") &&
    ingestAuthorized({ headers: { authorization: "Bearer sec" } }, "sec") &&
    DEFAULT_MAX_BODY_BYTES === 1_048_576 &&
    attrsToMap([{ key: "tenant", value: { stringValue: "acme" } }]).tenant === "acme";
  if (!extractedOk) {
    console.error("smoke failed OTLP extract/auth helpers", extracted);
    process.exit(1);
  }

  const ingestServed = createReportServer({ spans: [], groupBy: "day", version: VERSION });
  const ingestAddr = await listen(ingestServed.server, 0, "127.0.0.1");
  const ingestBase = `http://127.0.0.1:${ingestAddr.port}`;
  try {
    const emptyPost = await fetch(`${ingestBase}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [] }),
    });
    const emptyBody = await emptyPost.json();
    if (emptyPost.status !== 200 || emptyBody.ok !== true || emptyBody.accepted !== 0) {
      console.error("smoke ingest empty failed", emptyPost.status, emptyBody);
      process.exit(1);
    }
    const badPost = await fetch(`${ingestBase}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const badBody = await badPost.json();
    if (badPost.status !== 400 || badBody.error !== "bad_json") {
      console.error("smoke ingest bad json failed", badPost.status, badBody);
      process.exit(1);
    }
    const otlpPost = await fetch(`${ingestBase}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Request-Id": "mvp-ingest-rid-e1" },
      body: JSON.stringify(otlpBody),
    });
    const otlpRes = await otlpPost.json();
    if (
      otlpPost.status !== 200 ||
      otlpRes.ok !== true ||
      otlpRes.accepted !== 1 ||
      otlpPost.headers.get("x-request-id") !== "mvp-ingest-rid-e1"
    ) {
      console.error("smoke ingest OTLP post failed", otlpPost.status, otlpRes);
      process.exit(1);
    }
    const costsAfter = await (await fetch(`${ingestBase}/v1/costs`)).json();
    const acmeRow = (costsAfter.byTenant || []).find((t) => t.tenant === "acme");
    const hasGpt4o = costsAfter.byModel && Number(costsAfter.byModel["gpt-4o"]) > 0;
    if (!acmeRow || !Number.isFinite(Number(acmeRow.usd)) || Number(acmeRow.usd) <= 0 || !hasGpt4o) {
      console.error("smoke ingest costs missing acme/gpt-4o", costsAfter);
      process.exit(1);
    }
    const secretPost = await fetch(`${ingestBase}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spans: [
          {
            spanId: "secret-span-1",
            timestamp: "2024-08-17T00:00:00.000Z",
            attributes: {
              "gen_ai.request.model": "gpt-4o-mini",
              "gen_ai.usage.input_tokens": 50,
              "gen_ai.usage.output_tokens": 10,
              tenant: "acme",
              "gen_ai.prompt": "SECRET_PROMPT",
              "gen_ai.completion": "SECRET_PROMPT",
            },
          },
        ],
      }),
    });
    const secretPostBody = await secretPost.json();
    if (secretPost.status !== 200 || secretPostBody.accepted !== 1) {
      console.error("smoke ingest SECRET_PROMPT post failed", secretPost.status, secretPostBody);
      process.exit(1);
    }
    const spansAfterIngest = await fetch(`${ingestBase}/v1/spans`);
    const spansAfterBody = await spansAfterIngest.json();
    const spansAfterBlob = JSON.stringify(spansAfterBody);
    const secretRow = (spansAfterBody.spans || []).find((s) => s.id === "secret-span-1") || (spansAfterBody.spans || [])[0];
    if (
      spansAfterIngest.status !== 200 ||
      spansAfterBody.ok !== true ||
      Number(spansAfterBody.count) < 1 ||
      !Array.isArray(spansAfterBody.spans) ||
      !secretRow ||
      !secretRow.model ||
      spansAfterBlob.includes("SECRET_PROMPT") ||
      spansAfterBlob.includes("gen_ai.prompt") ||
      spansAfterBlob.includes("gen_ai.completion")
    ) {
      console.error("smoke ingest GET /v1/spans leaked prompt or missing model", spansAfterIngest.status, spansAfterBody);
      process.exit(1);
    }
    const tenantsAfterIngest = await fetch(`${ingestBase}/v1/tenants`);
    const tenantsAfterBody = await tenantsAfterIngest.json();
    const tenantsAfterBlob = JSON.stringify(tenantsAfterBody);
    const acmeTenant = (tenantsAfterBody.tenants || []).find((t) => t.id === "acme");
    if (
      tenantsAfterIngest.status !== 200 ||
      tenantsAfterBody.ok !== true ||
      Number(tenantsAfterBody.count) < 1 ||
      !acmeTenant ||
      typeof acmeTenant.usd !== "number" ||
      tenantsAfterBlob.includes("SECRET_PROMPT") ||
      tenantsAfterBlob.includes("gen_ai.prompt")
    ) {
      console.error("smoke ingest GET /v1/tenants leaked prompt or missing acme", tenantsAfterIngest.status, tenantsAfterBody);
      process.exit(1);
    }
    const htmlAfterIngest = await (await fetch(`${ingestBase}/`)).text();
    const csvAfterIngest = await (await fetch(`${ingestBase}/v1/costs.csv`)).text();
    const mdAfterIngest = await (await fetch(`${ingestBase}/v1/costs.md`)).text();
    const metricsAfterIngest = await (await fetch(`${ingestBase}/metrics`)).text();
    if (
      !htmlAfterIngest.includes("gpt-4o") ||
      !csvAfterIngest.includes("gpt-4o") ||
      !csvAfterIngest.includes("acme") ||
      !mdAfterIngest.includes("gpt-4o") ||
      !mdAfterIngest.includes("acme") ||
      !metricsAfterIngest.includes("gpt-4o")
    ) {
      console.error("smoke ingest html/csv/md/metrics missing gpt-4o");
      process.exit(1);
    }
    const aliasPost = await fetch(`${ingestBase}/v1/otlp/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spans: [
          {
            timestamp: "2024-08-16T00:00:00.000Z",
            attributes: {
              "gen_ai.request.model": "gpt-4o-mini",
              "gen_ai.usage.input_tokens": 100,
              "gen_ai.usage.output_tokens": 10,
              tenant: "acme",
            },
          },
        ],
      }),
    });
    const aliasBody = await aliasPost.json();
    if (aliasPost.status !== 200 || aliasBody.accepted !== 1) {
      console.error("smoke ingest alias/flat spans failed", aliasPost.status, aliasBody);
      process.exit(1);
    }
    const unsignedNoToken = await fetch(`${ingestBase}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spans: [] }),
    });
    const unsignedBody = await unsignedNoToken.json();
    if (unsignedNoToken.status !== 200 || unsignedBody.ok !== true || unsignedBody.accepted !== 0) {
      console.error("smoke unsigned ingest without token failed", unsignedNoToken.status, unsignedBody);
      process.exit(1);
    }
  } finally {
    await closeServer(ingestServed.server);
  }

  const tokenServed = createReportServer({
    spans: [],
    groupBy: "day",
    version: VERSION,
    ingestToken: "whsec_ingest_smoke",
  });
  const tokenAddr = await listen(tokenServed.server, 0, "127.0.0.1");
  const tokenBase = `http://127.0.0.1:${tokenAddr.port}`;
  try {
    const noBearer = await fetch(`${tokenBase}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spans: [] }),
    });
    const noBearerBody = await noBearer.json();
    if (noBearer.status !== 401 || noBearerBody.error !== "unauthorized") {
      console.error("smoke ingest token missing bearer failed", noBearer.status, noBearerBody);
      process.exit(1);
    }
    if (JSON.stringify(noBearerBody).includes("whsec_ingest_smoke")) {
      console.error("smoke ingest 401 leaked token");
      process.exit(1);
    }
    const withBearer = await fetch(`${tokenBase}/v1/traces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer whsec_ingest_smoke",
      },
      body: JSON.stringify({ spans: [] }),
    });
    const withBearerBody = await withBearer.json();
    if (withBearer.status !== 200 || withBearerBody.ok !== true) {
      console.error("smoke ingest with bearer failed", withBearer.status, withBearerBody);
      process.exit(1);
    }
    const healthTok = await fetch(`${tokenBase}/health`);
    if (healthTok.status !== 200) {
      console.error("smoke ingest token must not gate /health", healthTok.status);
      process.exit(1);
    }
  } finally {
    await closeServer(tokenServed.server);
  }

  const oversizeServed = createReportServer({ spans: [], groupBy: "day", version: VERSION });
  const oversizeAddr = await listen(oversizeServed.server, 0, "127.0.0.1");
  try {
    const oversize = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: oversizeAddr.port,
          path: "/v1/traces",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(DEFAULT_MAX_BODY_BYTES + 1),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            let body = Buffer.concat(chunks).toString("utf8");
            try {
              body = JSON.parse(body);
            } catch {
              /* keep text */
            }
            resolve({ status: res.statusCode, body });
          });
        }
      );
      req.on("error", reject);
      req.end("[]");
    });
    if (oversize.status !== 413 || !oversize.body || oversize.body.error !== "payload_too_large") {
      console.error("smoke ingest 413 failed", oversize);
      process.exit(1);
    }
  } finally {
    await closeServer(oversizeServed.server);
  }

  const denySpan = {
    timestamp: "2024-08-18T00:00:00.000Z",
    attributes: {
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 5,
      tenant: "acme",
      "gen_ai.prompt": "SECRET_PROMPT_DENY",
    },
  };
  const noHookDenyServed = createReportServer({
    spans: acmeHighSpans,
    groupBy: "day",
    version: VERSION,
    tenantBudgets: parseTenantBudgets("acme=0.01"),
  });
  const noHookDenyAddr = await listen(noHookDenyServed.server, 0, "127.0.0.1");
  try {
    const noHookDeny = await fetch(`http://127.0.0.1:${noHookDenyAddr.port}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spans: [denySpan] }),
    });
    const noHookDenyBody = await noHookDeny.json();
    if (
      noHookDeny.status !== 200 ||
      noHookDenyBody.ok !== true ||
      noHookDenyBody.accepted !== 1 ||
      noHookDenyBody.denied !== 1
    ) {
      console.error("smoke ingest deny without webhook failed", noHookDeny.status, noHookDenyBody);
      process.exit(1);
    }
  } finally {
    await closeServer(noHookDenyServed.server);
  }

  const ingestHookReceived = [];
  const ingestHookMock = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      ingestHookReceived.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        raw: Buffer.concat(chunks).toString("utf8"),
      });
      const ack = JSON.stringify({ ok: true });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(ack),
      });
      res.end(ack);
    });
  });
  const ingestHookMockAddr = await listen(ingestHookMock, 0, "127.0.0.1");
  const ingestHookSecret = "whsec_ingest_deny_smoke";
  const ingestHookServed = createReportServer({
    spans: acmeHighSpans,
    groupBy: "day",
    version: VERSION,
    tenantBudgets: parseTenantBudgets("acme=0.01"),
    webhookUrl: `http://127.0.0.1:${ingestHookMockAddr.port}/hook`,
    webhookSecret: ingestHookSecret,
  });
  const ingestHookAddr = await listen(ingestHookServed.server, 0, "127.0.0.1");
  try {
    const hookDeny = await fetch(`http://127.0.0.1:${ingestHookAddr.port}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spans: [denySpan] }),
    });
    const hookDenyBody = await hookDeny.json();
    if (
      hookDeny.status !== 200 ||
      hookDenyBody.ok !== true ||
      hookDenyBody.accepted !== 1 ||
      hookDenyBody.denied !== 1
    ) {
      console.error("smoke ingest deny with webhook HTTP failed", hookDeny.status, hookDenyBody);
      process.exit(1);
    }
    if (ingestHookReceived.length !== 1) {
      console.error("smoke ingest deny webhook call count", ingestHookReceived.length, ingestHookReceived);
      process.exit(1);
    }
    let hookBody;
    try {
      hookBody = JSON.parse(ingestHookReceived[0].raw);
    } catch {
      hookBody = null;
    }
    const acmeSpendRow = (tbHigh.byTenant || []).find((t) => t.tenant === "acme");
    const hookSig = ingestHookReceived[0].headers["x-webhook-signature"];
    const hookTs = ingestHookReceived[0].headers["x-webhook-timestamp"];
    const hookRaw = ingestHookReceived[0].raw;
    if (
      !hookBody ||
      hookBody.ok !== false ||
      hookBody.tenant !== "acme" ||
      Number(hookBody.spend) !== Number(acmeSpendRow?.usd) ||
      Number(hookBody.budget) !== 0.01 ||
      Number(hookBody.denied) !== 1 ||
      hookRaw.includes("SECRET_PROMPT_DENY") ||
      hookRaw.includes("gen_ai.prompt") ||
      !hookSig ||
      !verifyWebhookSignature(ingestHookSecret, hookRaw, hookSig) ||
      !hookTs ||
      !/^\d+$/.test(String(hookTs))
    ) {
      console.error("smoke ingest deny webhook payload/HMAC failed", {
        hookBody,
        headers: ingestHookReceived[0].headers,
        acmeSpendRow,
      });
      process.exit(1);
    }
  } finally {
    await closeServer(ingestHookServed.server);
    await closeServer(ingestHookMock);
  }

  const wouldHookReceived = [];
  const wouldHookMock = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      wouldHookReceived.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        raw: Buffer.concat(chunks).toString("utf8"),
      });
      const ack = JSON.stringify({ ok: true });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(ack),
      });
      res.end(ack);
    });
  });
  const wouldHookMockAddr = await listen(wouldHookMock, 0, "127.0.0.1");
  const wouldHookServed = createReportServer({
    spans: [underSpan],
    groupBy: "day",
    version: VERSION,
    tenantBudgets: { acme: 0.0002 },
    webhookUrl: `http://127.0.0.1:${wouldHookMockAddr.port}/hook`,
    denyOnWouldExceed: true,
  });
  const wouldHookAddr = await listen(wouldHookServed.server, 0, "127.0.0.1");
  try {
    const spendBefore = Number(
      (wouldHookServed.report.byTenant || []).find((t) => t.tenant === "acme")?.usd
    );
    const wouldHttp = await fetch(`http://127.0.0.1:${wouldHookAddr.port}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spans: [incomingCross] }),
    });
    const wouldHttpBody = await wouldHttp.json();
    const spendAfter = Number(
      (wouldHookServed.report.byTenant || []).find((t) => t.tenant === "acme")?.usd
    );
    if (
      wouldHttp.status !== 200 ||
      wouldHttpBody.ok !== true ||
      wouldHttpBody.accepted !== 1 ||
      wouldHttpBody.denied !== 1 ||
      spendAfter !== spendBefore ||
      wouldHookReceived.length !== 1
    ) {
      console.error("smoke would-exceed HTTP deny failed", {
        status: wouldHttp.status,
        wouldHttpBody,
        spendBefore,
        spendAfter,
        hooks: wouldHookReceived.length,
      });
      process.exit(1);
    }
    let wouldHookBody;
    try {
      wouldHookBody = JSON.parse(wouldHookReceived[0].raw);
    } catch {
      wouldHookBody = null;
    }
    const wouldRaw = wouldHookReceived[0].raw;
    if (
      !wouldHookBody ||
      wouldHookBody.ok !== false ||
      wouldHookBody.tenant !== "acme" ||
      Number(wouldHookBody.denied) !== 1 ||
      Number(wouldHookBody.spend) !== spendBefore ||
      Number(wouldHookBody.budget) !== 0.0002 ||
      wouldRaw.includes("SECRET_PROMPT_WOULD_EXCEED") ||
      wouldRaw.includes("gen_ai.prompt")
    ) {
      console.error("smoke would-exceed webhook payload failed", wouldHookBody);
      process.exit(1);
    }
    console.log("would-exceed-ok");
  } finally {
    await closeServer(wouldHookServed.server);
    await closeServer(wouldHookMock);
  }

  const attrHookReceived = [];
  const attrHookMock = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      attrHookReceived.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        raw: Buffer.concat(chunks).toString("utf8"),
      });
      const ack = JSON.stringify({ ok: true });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(ack),
      });
      res.end(ack);
    });
  });
  const attrHookMockAddr = await listen(attrHookMock, 0, "127.0.0.1");
  const attrHookServed = createReportServer({
    spans: [seedAttr],
    groupBy: "day",
    version: VERSION,
    tenantBudgets: { acme: 0.5 },
    webhookUrl: `http://127.0.0.1:${attrHookMockAddr.port}/hook`,
    denyOnWouldExceed: true,
  });
  const attrHookAddr = await listen(attrHookServed.server, 0, "127.0.0.1");
  try {
    const attrSpendBefore = Number(
      (attrHookServed.report.byTenant || []).find((t) => t.tenant === "acme")?.usd
    );
    if (attrSpendBefore !== 0.4) {
      console.error("smoke gen_ai.cost.usd HTTP seed spend must be 0.4 not token math", {
        attrSpendBefore,
        report: attrHookServed.report,
      });
      process.exit(1);
    }
    const attrOne = createReportServer({ spans: [], groupBy: "day", version: VERSION });
    const attrOneIn = attrOne.ingest([attrSpan]);
    if (attrOneIn.denied !== 0 || Number(attrOne.report.totalUsd) !== 1.23) {
      console.error("smoke one-span gen_ai.cost.usd spend must match attribute", {
        attrOneIn,
        totalUsd: attrOne.report.totalUsd,
      });
      process.exit(1);
    }
    const attrHttp = await fetch(`http://127.0.0.1:${attrHookAddr.port}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spans: [incomingAttr] }),
    });
    const attrHttpBody = await attrHttp.json();
    const attrSpendAfter = Number(
      (attrHookServed.report.byTenant || []).find((t) => t.tenant === "acme")?.usd
    );
    if (
      attrHttp.status !== 200 ||
      attrHttpBody.ok !== true ||
      attrHttpBody.accepted !== 1 ||
      attrHttpBody.denied !== 1 ||
      attrSpendAfter !== 0.4 ||
      attrHookReceived.length !== 1
    ) {
      console.error("smoke gen_ai.cost.usd would-exceed HTTP deny failed", {
        status: attrHttp.status,
        attrHttpBody,
        attrSpendBefore,
        attrSpendAfter,
        hooks: attrHookReceived.length,
      });
      process.exit(1);
    }
    let attrHookBody;
    try {
      attrHookBody = JSON.parse(attrHookReceived[0].raw);
    } catch {
      attrHookBody = null;
    }
    const attrHookRaw = attrHookReceived[0].raw;
    if (
      !attrHookBody ||
      attrHookBody.ok !== false ||
      attrHookBody.tenant !== "acme" ||
      Number(attrHookBody.denied) !== 1 ||
      Number(attrHookBody.spend) !== 0.4 ||
      Number(attrHookBody.budget) !== 0.5 ||
      attrHookRaw.includes("SECRET_PROMPT_COST_ATTR") ||
      attrHookRaw.includes("gen_ai.prompt")
    ) {
      console.error("smoke gen_ai.cost.usd webhook payload failed", attrHookBody);
      process.exit(1);
    }
    console.log("cost-attr-ok");
  } finally {
    await closeServer(attrHookServed.server);
    await closeServer(attrHookMock);
  }

  const spanMaxOk =
    DEFAULT_SPAN_MAX === 50000 &&
    ENV_SPAN_MAX === "SPAN_MAX" &&
    resolveSpanMax(undefined, {}) === DEFAULT_SPAN_MAX &&
    resolveSpanMax(2) === 2 &&
    resolveSpanMax("2") === 2 &&
    resolveSpanMax(0) === 0 &&
    resolveSpanMax("0") === 0 &&
    resolveSpanMax(-1) === DEFAULT_SPAN_MAX &&
    resolveSpanMax("nope") === DEFAULT_SPAN_MAX &&
    resolveSpanMax(undefined, { SPAN_MAX: "7" }) === 7 &&
    resolveSpanMax("3", { SPAN_MAX: "7" }) === 3;
  if (!spanMaxOk) {
    console.error("smoke failed resolveSpanMax");
    process.exit(1);
  }
  const unlim = capSpans([{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }], 0);
  if (unlim.length !== 5) {
    console.error("smoke failed span-max 0 unlimited", unlim.length);
    process.exit(1);
  }

  const tiny = (tenant, ts) => ({
    timestamp: ts,
    attributes: {
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 1,
      "gen_ai.usage.output_tokens": 1,
      tenant,
    },
  });
  const capServed = createReportServer({
    spans: [],
    groupBy: "day",
    version: VERSION,
    spanMax: 2,
  });
  const capIn = capServed.ingest([
    tiny("old", "2024-08-15T00:00:00.000Z"),
    tiny("mid", "2024-08-15T01:00:00.000Z"),
    tiny("new", "2024-08-15T02:00:00.000Z"),
  ]);
  const capTenants = (capServed.report.byTenant || []).map((t) => t.tenant);
  const capOk =
    capIn.ok === true &&
    capIn.accepted === 3 &&
    capServed.spanMax === 2 &&
    Array.isArray(capServed.spans) &&
    capServed.spans.length === 2 &&
    capServed.health.spanCount === 2 &&
    capServed.report.rows.length === 2 &&
    capTenants.includes("mid") &&
    capTenants.includes("new") &&
    !capTenants.includes("old");
  if (!capOk) {
    console.error("smoke failed span store max=2 ingest 3", {
      accepted: capIn.accepted,
      spanCount: capServed.health.spanCount,
      tenants: capTenants,
      store: capServed.spans.length,
    });
    process.exit(1);
  }
  const capReload = capServed.reload([
    tiny("a", "2024-08-16T00:00:00.000Z"),
    tiny("b", "2024-08-16T01:00:00.000Z"),
    tiny("c", "2024-08-16T02:00:00.000Z"),
  ]);
  const reloadTenants = (capServed.report.byTenant || []).map((t) => t.tenant);
  if (
    !capReload ||
    capServed.spans.length !== 2 ||
    capReload.health.spanCount !== 2 ||
    reloadTenants.includes("a") ||
    reloadTenants.includes("old") ||
    !reloadTenants.includes("b") ||
    !reloadTenants.includes("c")
  ) {
    console.error("smoke failed watch reload replaces store then cap", {
      spanCount: capReload && capReload.health.spanCount,
      tenants: reloadTenants,
    });
    process.exit(1);
  }

  const exportServed = createReportServer({
    spans: [],
    groupBy: "day",
    version: VERSION,
    tenantBudgets: parseTenantBudgets("acme=10,other=5"),
  });
  const exportAddr = await listen(exportServed.server, 0, "127.0.0.1");
  const exportBase = `http://127.0.0.1:${exportAddr.port}`;
  try {
    const exportPost = await fetch(`${exportBase}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spans: [
          {
            timestamp: "2024-08-18T00:00:00.000Z",
            attributes: {
              "gen_ai.request.model": "gpt-4o-mini",
              tenant: "acme",
              "gen_ai.cost.usd": 1,
            },
          },
          {
            timestamp: "2024-08-18T00:00:01.000Z",
            attributes: {
              "gen_ai.request.model": "gpt-4o-mini",
              tenant: "other",
              "gen_ai.cost.usd": 2,
            },
          },
        ],
      }),
    });
    const exportPostBody = await exportPost.json();
    if (exportPost.status !== 200 || exportPostBody.ok !== true || Number(exportPostBody.denied) !== 0) {
      console.error("smoke export ingest two tenants failed", exportPost.status, exportPostBody);
      process.exit(1);
    }
    const exportJsonRes = await fetch(`${exportBase}/v1/tenants`);
    const exportJson = await exportJsonRes.json();
    const exportCsvRes = await fetch(`${exportBase}/v1/tenants.csv`);
    const exportCsv = await exportCsvRes.text();
    const exportCsvAlias = await (await fetch(`${exportBase}/v1/tenants?format=csv`)).text();
    const exportLines = exportCsv.trim().split("\n");
    const exportIds = (exportJson.tenants || []).map((t) => t.id);
    if (
      exportJsonRes.status !== 200 ||
      exportJson.ok !== true ||
      Number(exportJson.count) !== 2 ||
      !exportIds.includes("acme") ||
      !exportIds.includes("other") ||
      exportCsvRes.status !== 200 ||
      !String(exportCsvRes.headers.get("content-type") || "").includes("text/csv") ||
      exportLines[0] !== "tenant,spend_usd,budget_usd,remaining_usd,denied_count" ||
      exportLines.length !== 3 ||
      !exportLines.some((l) => l.startsWith("acme,1.000000,10.000000,9.000000,")) ||
      !exportLines.some((l) => l.startsWith("other,2.000000,5.000000,3.000000,")) ||
      exportCsvAlias !== exportCsv
    ) {
      console.error("smoke export GET /v1/tenants.csv failed", {
        status: exportCsvRes.status,
        exportCsv,
        exportJson,
      });
      process.exit(1);
    }
    console.log("export-ok", { header: exportLines[0], rows: exportLines.length - 1, tenants: exportIds });
    const dashHtml = await (await fetch(`${exportBase}/`)).text();
    if (
      !dashHtml.includes('id="budget-remaining"') ||
      !dashHtml.includes("remaining") ||
      !dashHtml.includes("acme") ||
      !dashHtml.includes("9.000000") ||
      !dashHtml.includes("other") ||
      !dashHtml.includes("3.000000")
    ) {
      console.error("smoke remain-dash GET / failed", dashHtml.slice(0, 800));
      process.exit(1);
    }
    console.log("remain-dash-ok");
  } finally {
    await closeServer(exportServed.server);
  }

  const periodFlagOk =
    ENV_BUDGET_PERIOD === "BUDGET_PERIOD" &&
    ENV_BUDGET_PERIOD_ALIAS === "OTEL_AI_COST_BUDGET_PERIOD" &&
    BUDGET_PERIOD_DAY === "day" &&
    resolveBudgetPeriod(null, {}) === null &&
    resolveBudgetPeriod(null, { [ENV_BUDGET_PERIOD]: "day" }) === "day" &&
    resolveBudgetPeriod(null, { [ENV_BUDGET_PERIOD_ALIAS]: "day" }) === "day" &&
    resolveBudgetPeriod("day", { [ENV_BUDGET_PERIOD]: "off" }) === "day" &&
    resolveBudgetPeriod("off", { [ENV_BUDGET_PERIOD]: "day" }) === null &&
    resolveBudgetPeriod("", { [ENV_BUDGET_PERIOD]: "day" }) === null;
  if (!periodFlagOk) {
    console.error("smoke resolveBudgetPeriod failed");
    process.exit(1);
  }
  const periodTodayIso = new Date().toISOString();
  const periodOldIso = "2024-01-15T12:00:00.000Z";
  const periodOld = {
    timestamp: periodOldIso,
    attributes: {
      "gen_ai.request.model": "gpt-4o-mini",
      tenant: "acme",
      "gen_ai.cost.usd": 9,
    },
  };
  const periodToday = {
    timestamp: periodTodayIso,
    attributes: {
      "gen_ai.request.model": "gpt-4o-mini",
      tenant: "acme",
      "gen_ai.cost.usd": 1,
    },
  };
  const periodIncoming = {
    timestamp: periodTodayIso,
    attributes: {
      "gen_ai.request.model": "gpt-4o-mini",
      tenant: "acme",
      "gen_ai.cost.usd": 1.5,
    },
  };
  const periodCsv = formatTenantsCsv([periodOld, periodToday], {
    budgets: { acme: 10 },
    period: "day",
  });
  const periodCsvLines = periodCsv.trim().split("\n");
  if (
    periodCsvLines[0] !== "tenant,spend_usd,budget_usd,remaining_usd,denied_count" ||
    !periodCsvLines.some((l) => l.startsWith("acme,1.000000,10.000000,9.000000,"))
  ) {
    console.error("smoke period CSV remaining must count only today", periodCsv);
    process.exit(1);
  }
  const periodOffCsv = formatTenantsCsv([periodOld, periodToday], { budgets: { acme: 10 } });
  if (!periodOffCsv.includes("acme,10.000000,10.000000,0.000000,")) {
    console.error("smoke default cumulative CSV must still sum old+today", periodOffCsv);
    process.exit(1);
  }
  const periodOldReport = report([periodOld], DEFAULT_PRICES, { tenantBudgets: { acme: 2 } });
  const periodAllow = applyBudgetDeny([periodToday], periodOldReport, { acme: 2 }, {
    period: "day",
    store: [periodOld],
  });
  if (periodAllow.denied !== 0 || periodAllow.kept.length !== 1) {
    console.error("smoke period would-exceed must ignore previous-day spend", periodAllow, periodOldReport);
    process.exit(1);
  }
  const periodBothReport = report([periodOld, periodToday], DEFAULT_PRICES, { tenantBudgets: { acme: 2 } });
  const periodWould = applyBudgetDeny([periodIncoming], periodBothReport, { acme: 2 }, {
    period: "day",
    store: [periodOld, periodToday],
  });
  if (periodWould.denied !== 1 || periodWould.kept.length !== 0) {
    console.error("smoke period would-exceed must use today spend only", periodWould, periodBothReport);
    process.exit(1);
  }
  const periodServed = createReportServer({
    spans: [],
    groupBy: "day",
    version: VERSION,
    tenantBudgets: { acme: 2 },
    budgetPeriod: "day",
    denyOnWouldExceed: true,
  });
  const periodAddr = await listen(periodServed.server, 0, "127.0.0.1");
  const periodBase = `http://127.0.0.1:${periodAddr.port}`;
  try {
    const oldPost = await fetch(`${periodBase}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spans: [periodOld] }),
    });
    const oldBody = await oldPost.json();
    const todayPost = await fetch(`${periodBase}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spans: [periodToday] }),
    });
    const todayBody = await todayPost.json();
    const csvAfter = await (await fetch(`${periodBase}/v1/tenants.csv`)).text();
    const jsonAfter = await (await fetch(`${periodBase}/v1/tenants`)).json();
    const acmeRow = (jsonAfter.tenants || []).find((t) => t.id === "acme");
    const denyPost = await fetch(`${periodBase}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spans: [periodIncoming] }),
    });
    const denyBody = await denyPost.json();
    const csvDenied = await (await fetch(`${periodBase}/v1/tenants.csv`)).text();
    const csvDeniedLines = csvDenied.trim().split("\n");
    if (
      oldPost.status !== 200 ||
      oldBody.denied !== 0 ||
      todayPost.status !== 200 ||
      todayBody.denied !== 0 ||
      Number(acmeRow?.usd) !== 1 ||
      !csvAfter.includes("acme,1.000000,2.000000,1.000000,0") ||
      denyPost.status !== 200 ||
      denyBody.denied !== 1 ||
      !csvDeniedLines.some((l) => l.startsWith("acme,1.000000,2.000000,1.000000,1"))
    ) {
      console.error("smoke period HTTP window failed", {
        oldBody,
        todayBody,
        csvAfter,
        jsonAfter,
        denyBody,
        csvDenied,
        today: utcToday(),
      });
      process.exit(1);
    }
    const periodHtml = await (await fetch(`${periodBase}/`)).text();
    if (
      !periodHtml.includes('id="budget-remaining"') ||
      !periodHtml.includes("period: UTC day") ||
      !periodHtml.includes("acme") ||
      !periodHtml.includes("1.000000")
    ) {
      console.error("smoke period HTML remaining failed", periodHtml.slice(0, 800));
      process.exit(1);
    }
    console.log("period-ok");
  } finally {
    await closeServer(periodServed.server);
  }

  console.log(`otel-ai-cost ${VERSION} smoke OK — totalUSD=${r.totalUsd} + cors+requestId+openapi+metrics+webhook+hmac+retry+watch+shutdown+accessLog+csv+md+gha+rateLimit+tenant+tenantBudget+budgets+models+config+otlpIngest+spanMax+ingestDenyWebhook+wouldExceed+costAttr+export+period+remainDash`);
} else if (cmd === "models" || cmd === "prices") {
  console.log(JSON.stringify(modelsJson(), null, 2));
} else if (cmd === "demo") {
  const r = report(demoSpans, DEFAULT_PRICES);
  console.log(formatTable(r));
} else if (cmd === "report" || cmd === "check-budget") {
  const args = parseArgs(process.argv.slice(3));
  if (!args.in) {
    console.error("missing --in");
    process.exit(2);
  }
  if (cmd === "check-budget" && !args.budget) {
    console.error("check-budget requires --budget");
    process.exit(2);
  }
  const spans = loadSpans(args.in);
  const tenantBudgets = resolveTenantBudgets(
    Object.prototype.hasOwnProperty.call(args, "tenantBudget") ? args.tenantBudget : null
  );
  const r = report(spans, DEFAULT_PRICES, { tenantBudgets });
  const groupBy = args.groupBy || null;
  if (groupBy && groupBy !== "day") {
    console.error(`unsupported --group-by ${groupBy} (supported: day)`);
    process.exit(2);
  }
  let format = args.format != null && String(args.format).trim() !== ""
    ? String(args.format).trim().toLowerCase()
    : "";
  if (
    format &&
    format !== "csv" &&
    format !== "json" &&
    format !== "html" &&
    format !== "md" &&
    format !== "markdown" &&
    format !== "gha" &&
    format !== "annotations"
  ) {
    console.error(`unsupported --format ${args.format} (supported: csv|json|html|md|gha)`);
    process.exit(2);
  }
  if (format === "markdown") format = "md";
  if (format === "annotations") format = "gha";

  let budgetPolicy = null;
  if (args.budget) {
    try {
      budgetPolicy = resolveBudget(args);
    } catch (e) {
      console.error("budget error:", e.message || e);
      process.exit(2);
    }
  }

  function dailyOrFlatPayload() {
    return groupBy === "day"
      ? toDailyJson(r)
      : {
          totalUsd: r.totalUsd,
          byModel: r.byModel,
          byDay: r.byDay,
          byTenant: r.byTenant,
          budgetBreaches: r.budgetBreaches || [],
          rows: r.rows,
        };
  }

  function writeHtmlFile(dest) {
    const abs = path.resolve(dest);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, formatHtml(r, { groupBy, tenantBudgets }));
    console.log(JSON.stringify({ html: abs, totalUsd: r.totalUsd, rows: r.rows.length, groupBy: groupBy || null }));
  }

  if (format === "csv") {
    const csv = formatCsv(r);
    if (args.out) {
      const abs = writeText(args.out, csv);
      console.log(JSON.stringify({ csv: abs, totalUsd: r.totalUsd, rows: r.rows.length, groupBy: groupBy || null }));
    } else {
      process.stdout.write(csv.endsWith("\n") ? csv : csv + "\n");
    }
    if (args.html) writeHtmlFile(args.html);
  } else if (format === "json") {
    const payload = dailyOrFlatPayload();
    if (args.out) {
      const absOut = writeJson(args.out, payload);
      console.log(JSON.stringify({ out: absOut, totalUsd: r.totalUsd, rows: r.rows.length, groupBy: groupBy || null, days: payload.days?.length ?? r.byDay?.length }));
    } else {
      console.log(JSON.stringify(payload, null, 2));
    }
    if (args.html) writeHtmlFile(args.html);
  } else if (format === "md") {
    const md = formatMd(r);
    if (args.out) {
      const abs = writeText(args.out, md);
      console.log(JSON.stringify({ md: abs, totalUsd: r.totalUsd, rows: r.rows.length, groupBy: groupBy || null }));
    } else {
      process.stdout.write(md.endsWith("\n") ? md : md + "\n");
    }
    if (args.html) writeHtmlFile(args.html);
  } else if (format === "gha") {
    const gha = formatGha(r, { budget: budgetPolicy });
    if (args.out) {
      const abs = writeText(args.out, gha);
      console.log(JSON.stringify({ gha: abs, totalUsd: r.totalUsd, rows: r.rows.length, groupBy: groupBy || null }));
    } else {
      process.stdout.write(gha);
    }
    if (args.html) writeHtmlFile(args.html);
  } else if (format === "html") {
    const dest = args.html || args.out;
    if (dest) {
      writeHtmlFile(dest);
    } else {
      process.stdout.write(formatHtml(r, { groupBy, tenantBudgets }));
    }
  } else {
    const table = formatTable(r, { groupBy });
    console.log(table);
    if (args.html) writeHtmlFile(args.html);
    if (args.out) {
      const payload = dailyOrFlatPayload();
      const absOut = writeJson(args.out, payload);
      console.log(JSON.stringify({ out: absOut, totalUsd: r.totalUsd, rows: r.rows.length, groupBy: groupBy || null, days: payload.days?.length ?? r.byDay?.length }));
    }
  }
  const hookUrl = webhookUrlFromArgs(args);
  const hookSecret = webhookSecretFromArgs(args);
  const tenantCheck = tenantBudgetWebhookCheck(r);
  if (!tenantCheck.ok) {
    await notifyBudgetBreach(hookUrl, tenantCheck, { secret: hookSecret });
  }
  if (budgetPolicy) {
    await runBudgetGate(r, budgetPolicy, {
      quiet: format === "gha",
      webhookUrl: hookUrl,
      webhookSecret: hookSecret,
    });
  }
} else if (cmd === "filter") {
  const args = parseArgs(process.argv.slice(3));
  if (!args.in || !args.out) {
    console.error("filter requires --in and --out");
    process.exit(2);
  }
  let policy = null;
  try {
    policy = resolvePolicy(args);
  } catch (e) {
    console.error("policy error:", e.message || e);
    process.exit(2);
  }
  const spans = loadSpans(args.in);
  const result = filterSpans(spans, {
    sample: args.sample ?? 1,
    redact: !!args.redact,
    seed: args.seed ?? 42,
    policy,
  });
  const absOut = writeJson(args.out, result.spans);
  console.log(
    JSON.stringify({
      wrote: absOut,
      before: result.before,
      after: result.after,
      dropped: result.droppedCount,
      reductionPct: result.reductionPct,
      sample: result.sample,
      redact: result.redact,
      policy: result.policy,
    })
  );
} else if (cmd === "route") {
  const args = parseArgs(process.argv.slice(3));
  if (!args.in) {
    console.error("route requires --in");
    process.exit(2);
  }
  if (!args.stdout && !args.file && !args.dropFile) {
    console.error("route requires at least one sink: --stdout and/or --file and/or --drop-file");
    process.exit(2);
  }
  let policy = null;
  try {
    policy = resolvePolicy(args);
  } catch (e) {
    console.error("policy error:", e.message || e);
    process.exit(2);
  }
  const spans = loadSpans(args.in);
  const result = filterSpans(spans, {
    sample: args.sample ?? 1,
    redact: !!args.redact,
    seed: args.seed ?? 42,
    policy,
  });
  // When sample is null, filterSpans coerces to 1 — but policy sampleRates still apply.
  const meta = {
    before: result.before,
    kept: result.after,
    dropped: result.droppedCount,
    reductionPct: result.reductionPct,
    sample: result.sample,
    redact: result.redact,
    policy: result.policy,
    sinks: {},
  };
  if (args.file) {
    meta.sinks.file = writeJson(args.file, result.kept);
  }
  if (args.dropFile) {
    meta.sinks.dropFile = writeJson(args.dropFile, result.dropped);
  }
  if (args.stdout) {
    // Print kept spans to stdout, then meta on stderr-style second line via meta JSON after
    console.log(JSON.stringify(result.kept, null, 2));
    meta.sinks.stdout = true;
  }
  // Always emit routing summary as a single JSON line (prefixed) for scripts
  console.log(JSON.stringify({ route: meta }));
} else if (cmd === "serve") {
  const args = parseArgs(process.argv.slice(3));
  if (!args.in) {
    console.error("serve requires --in");
    process.exit(2);
  }
  const groupBy = args.groupBy || "day";
  if (groupBy !== "day") {
    console.error(`unsupported --group-by ${groupBy} (supported: day)`);
    process.exit(2);
  }
  const port = Number.isFinite(args.port) ? args.port : DEFAULT_SERVE_PORT;
  const host = args.host || DEFAULT_SERVE_HOST;
  let spans;
  try {
    spans = loadSpans(args.in);
  } catch (e) {
    console.error("spans error:", e.message || e);
    process.exit(2);
  }
  const corsOrigins = resolveCorsOrigins(args.corsOrigins ?? null);
  const absIn = path.resolve(args.in);
  const logJsonEnabled = resolveLogJson(args.logJson);
  const rateLimit = resolveRateLimit(Object.prototype.hasOwnProperty.call(args, "rateLimit") ? args.rateLimit : undefined);
  const tenantBudgets = resolveTenantBudgets(
    Object.prototype.hasOwnProperty.call(args, "tenantBudget") ? args.tenantBudget : null
  );
  let budget = null;
  if (args.budget) {
    try {
      budget = resolveBudget(args);
    } catch (e) {
      console.error("budget error:", e.message || e);
      process.exit(2);
    }
  }
  const ingestToken = resolveIngestToken(
    Object.prototype.hasOwnProperty.call(args, "ingestToken") ? args.ingestToken : null
  );
  const spanMax = resolveSpanMax(
    Object.prototype.hasOwnProperty.call(args, "spanMax") ? args.spanMax : null
  );
  const hookUrl = webhookUrlFromArgs(args);
  const hookSecret = webhookSecretFromArgs(args);
  const denyOnWouldExceed = resolveDenyOnWouldExceed(
    Object.prototype.hasOwnProperty.call(args, "denyOnWouldExceed") ? args.denyOnWouldExceed : null
  );
  const budgetPeriod = resolveBudgetPeriod(
    Object.prototype.hasOwnProperty.call(args, "budgetPeriod") ? args.budgetPeriod : null
  );
  const served = createReportServer({
    spans,
    groupBy,
    version: VERSION,
    corsOrigins,
    logJson: logJsonEnabled,
    rateLimit,
    tenantBudgets,
    budget,
    ingestToken,
    spanMax,
    webhookUrl: hookUrl,
    webhookSecret: hookSecret,
    denyOnWouldExceed,
    budgetPeriod: budgetPeriod == null ? "off" : budgetPeriod,
  });
  const { server, reload, beginShutdown } = served;
  let watchTimer = null;
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    beginShutdown();
    console.log("shutting down");
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    const ms = resolveDrainMs(args.drainMs);
    await new Promise((r) => setTimeout(r, ms));
    try {
      await closeServer(server);
    } catch {
      /* ignore */
    }
    console.log("exit");
    process.exit(0);
  }
  process.on("SIGINT", () => {
    shutdown();
  });
  process.on("SIGTERM", () => {
    shutdown();
  });
  try {
    const addr = await listen(server, port, host);
    const bound = typeof addr === "object" && addr ? addr.port : port;
    console.log(`otel-ai-cost listening on http://${host}:${bound}`);
    console.log(`in=${absIn}`);
    console.log(`groupBy=${groupBy}`);
    console.log("GET /health  GET /ready  GET /  GET /report.json  GET /v1/costs.csv  GET /v1/costs.md  GET /v1/costs.gha.txt  GET /v1/budgets  GET /v1/models  GET /v1/config  GET /v1/spans  GET /v1/tenants  GET /v1/tenants.csv  GET /openapi.json  GET /metrics  POST /v1/traces");
    console.log(`cors=${corsOrigins.length ? corsOrigins.join(",") : "deny"}`);
    console.log(`rate_limit_per_minute=${rateLimit == null ? "unlimited" : rateLimit}`);
    console.log(
      `tenantBudget=${
        tenantBudgets && Object.keys(tenantBudgets).length
          ? Object.entries(tenantBudgets)
              .map(([k, v]) => `${k}=${v}`)
              .join(",")
          : "none"
      }`
    );
    console.log(`watch=${args.watch ? `poll ${WATCH_POLL_MS}ms` : "off"}`);
    console.log(`ingestToken=${ingestToken ? "on" : "off"}`);
    console.log(`spanMax=${spanMax === 0 ? "unlimited" : spanMax}`);
    console.log(`budgetPeriod=${budgetPeriod || "off"}`);
    console.log(`logJson=${logJsonEnabled ? "on" : "off"}`);
    console.log("hosted dashboard = paid later (this local serve is OSS)");
    if (args.watch) {
      watchTimer = startSpansWatch(absIn, { reload });
    }
  } catch (e) {
    console.error("serve listen failed:", e.message || e);
    process.exit(1);
  }
} else {
  printHelp();
}
