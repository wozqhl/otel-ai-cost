/** Estimate USD cost from OTel-like span attributes + price table + policy packs. */
import fs from "node:fs";

export const DEFAULT_PRICES = {
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "claude-sonnet": { inputPerMTok: 3, outputPerMTok: 15 },
};

const DEFAULT_REDACT_KEYS = [
  "gen_ai.prompt",
  "gen_ai.completion",
  "user.email",
  "user.id",
];

/** Missing/empty span attr `tenant` rolls up here (documented sentinel). */
export const UNKNOWN_TENANT = "_";

/**
 * Tenant id from span attribute `tenant` (map key or `span.tenant`).
 * Missing, null, or whitespace → `"_"`.
 */
export function spanTenant(span) {
  const raw = span?.attributes?.tenant ?? span?.attributes?.["tenant"] ?? span?.tenant ?? null;
  if (raw == null || raw === "") return UNKNOWN_TENANT;
  const s = String(raw).trim();
  return s || UNKNOWN_TENANT;
}

/** Span attribute for an incoming USD amount if present. Not a shipped OTel convention. */
export const COST_USD_ATTR = "gen_ai.cost.usd";

/**
 * Incoming USD from `gen_ai.cost.usd` if present and a finite number ≥ 0.
 * Missing / invalid (non-numeric, negative, NaN, Infinity) → null so callers
 * keep today's token × price path. Does not invent a semantic convention.
 */
export function spanCostUsdAttr(span) {
  const raw = span?.attributes?.[COST_USD_ATTR];
  if (raw == null || raw === "") return null;
  if (typeof raw === "boolean" || typeof raw === "object") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number(n.toFixed(6));
}

export function spanCost(span, prices = DEFAULT_PRICES) {
  const model = span.attributes?.["gen_ai.request.model"] || span.model || "unknown";
  const inTok = Number(span.attributes?.["gen_ai.usage.input_tokens"] ?? span.inputTokens ?? 0);
  const outTok = Number(span.attributes?.["gen_ai.usage.output_tokens"] ?? span.outputTokens ?? 0);
  const p = prices[model] || { inputPerMTok: 1, outputPerMTok: 3 };
  const tokenUsd = (inTok / 1e6) * p.inputPerMTok + (outTok / 1e6) * p.outputPerMTok;
  const attrUsd = spanCostUsdAttr(span);
  const usd = attrUsd != null ? attrUsd : Number(tokenUsd.toFixed(6));
  const day = spanUtcDay(span);
  const tenant = spanTenant(span);
  return { model, inTok, outTok, usd, day, tenant };
}

/** Extract UTC calendar day (YYYY-MM-DD) from common OTel / example timestamp fields. */
export function spanUtcDay(span) {
  const candidates = [
    span?.startTimeUnixNano,
    span?.endTimeUnixNano,
    span?.timestamp,
    span?.startTime,
    span?.time,
    span?.attributes?.["startTimeUnixNano"],
    span?.attributes?.startTimeUnixNano,
    span?.attributes?.["timestamp"],
    span?.attributes?.timestamp,
  ];
  for (const c of candidates) {
    const day = coerceUtcDay(c);
    if (day) return day;
  }
  return "unknown";
}

function coerceUtcDay(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // seconds vs ms vs ns heuristics
    let ms = value;
    if (value > 1e18) ms = value / 1e6; // ns
    else if (value > 1e14) ms = value / 1e3; // us
    else if (value < 1e12) ms = value * 1000; // seconds
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^\d+$/.test(s)) return coerceUtcDay(Number(s));
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  // OTel sometimes uses { seconds, nanos } or Long-like
  if (typeof value === "object") {
    if (value.seconds != null) {
      const sec = Number(value.seconds);
      const nanos = Number(value.nanos || 0);
      if (Number.isFinite(sec)) return coerceUtcDay(sec * 1e9 + nanos);
    }
  }
  return null;
}

export function groupRowsByDay(rows) {
  const map = new Map();
  for (const r of rows) {
    const day = r.day || "unknown";
    if (!map.has(day)) {
      map.set(day, { day, rows: [], totalUsd: 0, byModel: {}, spanCount: 0 });
    }
    const g = map.get(day);
    g.rows.push(r);
    g.totalUsd += r.usd;
    g.byModel[r.model] = (g.byModel[r.model] || 0) + r.usd;
    g.spanCount += 1;
  }
  const days = [...map.values()]
    .map((g) => ({
      ...g,
      totalUsd: Number(g.totalUsd.toFixed(6)),
      byModel: Object.fromEntries(
        Object.entries(g.byModel).map(([k, v]) => [k, Number(Number(v).toFixed(6))])
      ),
    }))
    .sort((a, b) => {
      if (a.day === "unknown") return 1;
      if (b.day === "unknown") return -1;
      return a.day.localeCompare(b.day);
    });
  return days;
}


export function groupRowsByTenant(rows) {
  const map = new Map();
  for (const r of rows) {
    const tenant = r.tenant || UNKNOWN_TENANT;
    if (!map.has(tenant)) {
      map.set(tenant, { tenant, usd: 0, spanCount: 0, byModel: {} });
    }
    const g = map.get(tenant);
    g.usd += r.usd;
    g.spanCount += 1;
    const model = r.model || "unknown";
    g.byModel[model] = (g.byModel[model] || 0) + r.usd;
  }
  return [...map.values()]
    .map((g) => ({
      tenant: g.tenant,
      usd: Number(g.usd.toFixed(6)),
      spanCount: g.spanCount,
      byModel: Object.fromEntries(
        Object.entries(g.byModel).map(([k, v]) => [k, Number(Number(v).toFixed(6))])
      ),
    }))
    .sort((a, b) => {
      if (a.tenant === UNKNOWN_TENANT && b.tenant !== UNKNOWN_TENANT) return 1;
      if (b.tenant === UNKNOWN_TENANT && a.tenant !== UNKNOWN_TENANT) return -1;
      return String(a.tenant).localeCompare(String(b.tenant));
    });
}

export const ENV_TENANT_BUDGETS = "OTEL_AI_COST_TENANT_BUDGETS";
/** Alias matching the task env example (`TENANT_BUDGETS=acme:10,other:5`). */
export const ENV_TENANT_BUDGETS_ALIAS = "TENANT_BUDGETS";

function normalizeTenantBudgetMap(obj) {
  const out = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const tenant = String(k).trim();
    if (!tenant) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out[tenant] = n;
  }
  return out;
}

/**
 * Parse `--tenant-budget` / env: CSV `acme=10,other=5` (also `acme:10`),
 * JSON object `{ "acme": 10 }`, or a JSON file path. Empty/invalid → {}.
 * Never throws (serve must not 500).
 */
export function parseTenantBudgets(raw) {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return normalizeTenantBudgetMap(raw);
  }
  const s = String(raw).trim();
  if (!s) return {};
  if (s.startsWith("{")) {
    try {
      return normalizeTenantBudgetMap(JSON.parse(s));
    } catch {
      return {};
    }
  }
  const looksLikeFile = /\.json$/i.test(s) || s.includes("/") || s.includes("\\");
  if (looksLikeFile) {
    try {
      if (fs.existsSync(s)) {
        const data = JSON.parse(fs.readFileSync(s, "utf8"));
        return normalizeTenantBudgetMap(data);
      }
    } catch {
      return {};
    }
    if (/\.json$/i.test(s)) return {};
  }
  const out = {};
  for (const part of s.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^([^=:]+?)\s*[=:]\s*(.+)$/);
    if (!m) continue;
    const tenant = m[1].trim();
    const n = Number(m[2].trim());
    if (!tenant || !Number.isFinite(n)) continue;
    out[tenant] = n;
  }
  return out;
}

/**
 * CLI `--tenant-budget` wins when provided (including empty → none);
 * otherwise env OTEL_AI_COST_TENANT_BUDGETS, else TENANT_BUDGETS.
 * Default none ({}).
 */
export function resolveTenantBudgets(cliValue, env = process.env) {
  if (cliValue !== null && cliValue !== undefined) {
    return parseTenantBudgets(cliValue);
  }
  const environ = env && typeof env === "object" ? env : {};
  const primary = environ[ENV_TENANT_BUDGETS];
  if (primary != null && String(primary).trim() !== "") {
    return parseTenantBudgets(primary);
  }
  const alias = environ[ENV_TENANT_BUDGETS_ALIAS];
  if (alias != null && String(alias).trim() !== "") {
    return parseTenantBudgets(alias);
  }
  return {};
}

/**
 * After byTenant rollup: configured tenants with usd > budget.
 * Missing tenant budgets → []. `_` is not gated unless `_` is explicitly set.
 */
export function tenantBudgetBreaches(byTenant, budgets) {
  const map = normalizeTenantBudgetMap(budgets);
  const out = [];
  for (const row of byTenant || []) {
    const tenant = row?.tenant || UNKNOWN_TENANT;
    if (!Object.prototype.hasOwnProperty.call(map, tenant)) continue;
    const budget = map[tenant];
    const usd = Number(row?.usd);
    const actual = Number.isFinite(usd) ? Number(usd.toFixed(6)) : 0;
    if (actual > budget) {
      out.push({ tenant, usd: actual, budget });
    }
  }
  return out;
}

/**
 * Remaining USD per configured tenant (budget - spend).
 * Missing spend → 0. Tenants without a budget are omitted.
 * Remaining may be negative when already over budget (honest, not clamped).
 */
export function tenantBudgetRemaining(byTenant, budgets) {
  const map = normalizeTenantBudgetMap(budgets);
  const spend = new Map();
  for (const row of byTenant || []) {
    const tenant = row?.tenant || UNKNOWN_TENANT;
    spend.set(tenant, Number(row?.usd) || 0);
  }
  const out = [];
  for (const tenant of Object.keys(map).sort()) {
    const usd = spend.has(tenant) ? spend.get(tenant) : 0;
    const budget = map[tenant];
    out.push({
      tenant,
      usd: Number(Number(usd).toFixed(6)),
      budget,
      remaining: Number((budget - usd).toFixed(6)),
    });
  }
  return out;
}

export const ENV_DENY_ON_WOULD_EXCEED = "DENY_ON_WOULD_EXCEED";

function parseBoolFlag(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim().toLowerCase();
  if (s === "false" || s === "0" || s === "off" || s === "no" || s === "disabled") return false;
  if (s === "true" || s === "1" || s === "on" || s === "yes") return true;
  return null;
}

/**
 * CLI wins when provided; else env DENY_ON_WOULD_EXCEED; default true.
 * false / 0 / off / no restores deny-only-after-already-over.
 */
export function resolveDenyOnWouldExceed(cliValue, env = process.env) {
  if (cliValue !== null && cliValue !== undefined) {
    const v = parseBoolFlag(cliValue);
    return v == null ? Boolean(cliValue) : v;
  }
  const environ = env && typeof env === "object" ? env : {};
  const v = parseBoolFlag(environ[ENV_DENY_ON_WOULD_EXCEED]);
  return v == null ? true : v;
}

export const ENV_BUDGET_PERIOD = "BUDGET_PERIOD";
export const ENV_BUDGET_PERIOD_ALIAS = "OTEL_AI_COST_BUDGET_PERIOD";
export const BUDGET_PERIOD_DAY = "day";

function normalizeBudgetPeriod(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().toLowerCase();
  if (s === "off" || s === "all" || s === "none" || s === "cumulative" || s === "false" || s === "0") {
    return null;
  }
  if (s === "day" || s === "daily" || s === "utc-day") return BUDGET_PERIOD_DAY;
  return null;
}

/**
 * CLI `--budget-period` wins when provided (including empty/off to disable);
 * else env BUDGET_PERIOD (alias OTEL_AI_COST_BUDGET_PERIOD); default off (null).
 * Only `day` is supported — remaining / deny / would-exceed use the current UTC calendar day.
 */
export function resolveBudgetPeriod(cliValue, env = process.env) {
  if (cliValue !== null && cliValue !== undefined) {
    return normalizeBudgetPeriod(cliValue);
  }
  const environ = env && typeof env === "object" ? env : {};
  const raw = environ[ENV_BUDGET_PERIOD] ?? environ[ENV_BUDGET_PERIOD_ALIAS];
  return normalizeBudgetPeriod(raw);
}

/** UTC calendar day YYYY-MM-DD for `now` (ms or Date). */
export function utcToday(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/**
 * Stamp ingest time so a span without its own timestamp can fall into the
 * current UTC day window later (midnight reset). Does not overwrite an existing stamp.
 */
export function stampIngestTime(span, now = Date.now()) {
  if (!span || typeof span !== "object") return span;
  if (span._ingestTime == null && span.ingestTime == null) {
    span._ingestTime = now instanceof Date ? now.getTime() : Number(now);
  }
  return span;
}

/**
 * Day used for the optional budget period window.
 * Span time first; else ingest stamp; else `now` (ingest time).
 */
export function spanPeriodDay(span, now = Date.now()) {
  const day = spanUtcDay(span);
  if (day && day !== "unknown") return day;
  const ingest = span?._ingestTime ?? span?.ingestTime;
  if (ingest != null && ingest !== "") {
    const fromIngest = spanUtcDay({ timestamp: ingest });
    if (fromIngest && fromIngest !== "unknown") return fromIngest;
  }
  return utcToday(now);
}

/** Spans whose period-day is the current UTC day. Period off → same list. */
export function spansInBudgetPeriod(spans, period, now = Date.now()) {
  const list = Array.isArray(spans) ? spans : [];
  if (normalizeBudgetPeriod(period) !== BUDGET_PERIOD_DAY) return list;
  const today = utcToday(now);
  return list.filter((s) => spanPeriodDay(s, now) === today);
}

function tenantSpendMap(spans, prices = DEFAULT_PRICES) {
  const spend = new Map();
  for (const span of Array.isArray(spans) ? spans : []) {
    const cost = spanCost(span, prices);
    const tenant = cost.tenant || UNKNOWN_TENANT;
    spend.set(tenant, (spend.get(tenant) || 0) + (Number(cost.usd) || 0));
  }
  return spend;
}

function spendMapFromReport(reportResult, period, now, prices, store) {
  if (normalizeBudgetPeriod(period) === BUDGET_PERIOD_DAY) {
    if (Array.isArray(store)) {
      return tenantSpendMap(spansInBudgetPeriod(store, period, now), prices);
    }
    const today = utcToday(now);
    const spend = new Map();
    for (const row of reportResult?.rows || []) {
      const day = row?.day && row.day !== "unknown" ? row.day : today;
      if (day !== today) continue;
      const tenant = row?.tenant || UNKNOWN_TENANT;
      spend.set(tenant, (spend.get(tenant) || 0) + (Number(row?.usd) || 0));
    }
    return spend;
  }
  const spend = new Map();
  for (const row of reportResult?.byTenant || []) {
    spend.set(row?.tenant || UNKNOWN_TENANT, Number(row?.usd) || 0);
  }
  return spend;
}

/**
 * True when current + incoming is strictly greater than budget (6-decimal).
 * Exact equality is allowed. Non-finite budget → false.
 */
export function wouldExceedBudget(currentUsd, incomingUsd, budgetUsd) {
  const budget = Number(budgetUsd);
  if (!Number.isFinite(budget)) return false;
  const current = Number(currentUsd);
  const incoming = Number(incomingUsd);
  const c = Number.isFinite(current) ? current : 0;
  const i = Number.isFinite(incoming) ? incoming : 0;
  return Number((c + i).toFixed(6)) > budget;
}

/**
 * Split incoming spans into kept vs budget-denied.
 * A tenant already in breach (`usd` > budget) is denied further ingest.
 * Default (deny-on-would-exceed): also deny when `current + incoming > budget`
 * (exact-on-budget is allowed). Set `{ denyOnWouldExceed: false }` or
 * `DENY_ON_WOULD_EXCEED=false` to restore deny-only-after-already-over.
 * `_` is not gated unless `_` is explicitly budgeted (same as tenantBudgetBreaches).
 * Does not mutate spans. Empty/invalid → `{ kept: [], denied: 0, deniedSpans: [] }`.
 */
export function applyBudgetDeny(spans, reportResult, tenantBudgets, opts = {}) {
  const list = Array.isArray(spans) ? spans : [];
  const map = normalizeTenantBudgetMap(tenantBudgets);
  const denyOnWouldExceed =
    opts && typeof opts === "object" && opts.denyOnWouldExceed === false ? false : true;
  const prices =
    opts && opts.prices && typeof opts.prices === "object" && !Array.isArray(opts.prices)
      ? opts.prices
      : DEFAULT_PRICES;
  const period = opts && typeof opts === "object" ? normalizeBudgetPeriod(opts.period ?? opts.budgetPeriod) : null;
  const now = opts && opts.now != null ? opts.now : Date.now();
  const store = opts && Array.isArray(opts.store) ? opts.store : null;
  const dayWindow = period === BUDGET_PERIOD_DAY;
  const today = utcToday(now);
  const spend = spendMapFromReport(reportResult, period, now, prices, store);
  const breaches = dayWindow
    ? tenantBudgetBreaches(
        [...spend.entries()].map(([tenant, usd]) => ({
          tenant,
          usd: Number(Number(usd).toFixed(6)),
        })),
        tenantBudgets
      )
    : Array.isArray(reportResult?.budgetBreaches)
      ? reportResult.budgetBreaches
      : tenantBudgetBreaches(reportResult?.byTenant || [], tenantBudgets);
  const blocked = new Set();
  for (const b of breaches || []) {
    blocked.add(b?.tenant || UNKNOWN_TENANT);
  }
  if (denyOnWouldExceed) {
    const incomingByTenant = new Map();
    for (const span of list) {
      const tenant = spanTenant(span);
      if (!Object.prototype.hasOwnProperty.call(map, tenant)) continue;
      if (dayWindow && spanPeriodDay(span, now) !== today) continue;
      incomingByTenant.set(
        tenant,
        (incomingByTenant.get(tenant) || 0) + (Number(spanCost(span, prices).usd) || 0)
      );
    }
    for (const [tenant, incoming] of incomingByTenant) {
      const current = spend.has(tenant) ? spend.get(tenant) : 0;
      if (wouldExceedBudget(current, incoming, map[tenant])) blocked.add(tenant);
    }
  }
  if (!blocked.size) {
    return { kept: list.slice(), denied: 0, deniedSpans: [] };
  }
  const kept = [];
  const deniedSpans = [];
  for (const span of list) {
    const tenant = spanTenant(span);
    const inWindow = !dayWindow || spanPeriodDay(span, now) === today;
    if (blocked.has(tenant) && inWindow) deniedSpans.push(span);
    else kept.push(span);
  }
  return { kept, denied: deniedSpans.length, deniedSpans };
}

/**
 * Shape for notifyBudgetBreach on HTTP ingest deny.
 * Once per denied request (not coalesced across requests).
 * Payload fields: tenant, spend, budget, denied. Never prompt/completion text.
 */
export function ingestDenyWebhookCheck(gated, reportResult, tenantBudgets) {
  const denied = Number(gated?.denied) || 0;
  const totalUsd =
    typeof reportResult?.totalUsd === "number" && Number.isFinite(reportResult.totalUsd)
      ? reportResult.totalUsd
      : Number(reportResult?.totalUsd) || 0;
  if (denied < 1) {
    return { ok: true, breaches: [], totalUsd, denied: 0 };
  }
  const first = Array.isArray(gated?.deniedSpans) ? gated.deniedSpans[0] : null;
  const tenant = spanTenant(first);
  const items = Array.isArray(reportResult?.budgetBreaches) ? reportResult.budgetBreaches : [];
  const match = items.find((b) => (b?.tenant || UNKNOWN_TENANT) === tenant);
  const map = normalizeTenantBudgetMap(tenantBudgets);
  const spendRaw = match
    ? Number(match.usd)
    : Number((reportResult?.byTenant || []).find((t) => (t?.tenant || UNKNOWN_TENANT) === tenant)?.usd) || 0;
  const budgetRaw = match
    ? Number(match.budget)
    : Object.prototype.hasOwnProperty.call(map, tenant)
      ? Number(map[tenant])
      : 0;
  const spend = Number(Number(spendRaw).toFixed(6));
  const budget = Number.isFinite(budgetRaw) ? Number(budgetRaw) : 0;
  return {
    ok: false,
    tenant,
    spend,
    budget,
    denied,
    totalUsd: spend,
    breaches: [
      {
        type: "ingestDeny",
        tenant,
        usd: spend,
        budget,
        limit: budget,
        actual: spend,
        denied,
        message: `ingest denied: tenant ${tenant} over budget (spend=${spend} budget=${budget} denied=${denied})`,
      },
    ],
  };
}

/** Shape for notifyBudgetBreach: one payload with tenant on each breach + top-level tenant. */
export function tenantBudgetWebhookCheck(reportResult) {
  const items = Array.isArray(reportResult?.budgetBreaches) ? reportResult.budgetBreaches : [];
  const totalUsd =
    typeof reportResult?.totalUsd === "number" && Number.isFinite(reportResult.totalUsd)
      ? reportResult.totalUsd
      : Number(reportResult?.totalUsd) || 0;
  if (!items.length) {
    return { ok: true, breaches: [], totalUsd };
  }
  return {
    ok: false,
    breaches: items.map((b) => ({
      type: "tenantUsd",
      tenant: b.tenant,
      usd: b.usd,
      budget: b.budget,
      limit: b.budget,
      actual: b.usd,
      message: `tenantUsd[${b.tenant}] exceeded: actual=${b.usd} budget=${b.budget}`,
    })),
    totalUsd,
    tenant: items[0].tenant,
  };
}

/**
 * Configured budget thresholds (not spend). No secrets.
 * `globalUsd` is `--budget` / policy `maxTotalUsd` (missing → null).
 * `tenants` is `--tenant-budget` / env map (missing → {}).
 */
export function budgetsJson({ budget = null, tenantBudgets = null } = {}) {
  let globalUsd = null;
  if (budget && typeof budget === "object" && !Array.isArray(budget)) {
    if (budget.maxTotalUsd != null && budget.maxTotalUsd !== "") {
      const n = Number(budget.maxTotalUsd);
      if (Number.isFinite(n)) globalUsd = n;
    }
  }
  const tenants = parseTenantBudgets(tenantBudgets == null ? {} : tenantBudgets);
  return { ok: true, globalUsd, tenants };
}

/** Rate keys copied from a price-table entry. Never copy secrets/unknown keys. */
const MODEL_RATE_KEYS = [
  "inputPerMTok",
  "outputPerMTok",
  "cachedPerMTok",
  "usdPer1kInput",
  "usdPer1kOutput",
  "usdPer1kCached",
  "usdPer1k",
];

function finiteRate(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function modelRateFromEntry(id, raw) {
  const entry = { id };
  if (typeof raw === "number") {
    const n = finiteRate(raw);
    if (n != null) entry.usdPer1k = n;
    return entry;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return entry;
  for (const k of MODEL_RATE_KEYS) {
    const n = finiteRate(raw[k]);
    if (n != null) entry[k] = n;
  }
  return entry;
}

/**
 * Pricing catalog (rates, not spend). No secrets.
 * Reads the loaded price table (`DEFAULT_PRICES` unless a custom table is passed).
 * Field names match the table (`inputPerMTok` / `outputPerMTok` on the built-in pack).
 * A single `usdPer1k` is used when that is all the entry has. Cached rates only when present.
 * Empty table → `{ok:true, models:[], defaultModel:null, pack:null}` (HTTP still 200).
 */
export function modelsJson({ prices = DEFAULT_PRICES, pack = null, defaultModel = null } = {}) {
  const table = prices && typeof prices === "object" && !Array.isArray(prices) ? prices : {};
  const models = [];
  for (const [k, raw] of Object.entries(table)) {
    const id = String(k).trim();
    if (!id) continue;
    models.push(modelRateFromEntry(id, raw));
  }
  models.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  let packName = null;
  if (pack != null && String(pack).trim() !== "") packName = String(pack).trim();
  let def = null;
  if (defaultModel != null && String(defaultModel).trim() !== "") def = String(defaultModel).trim();
  return { ok: true, models, defaultModel: def, pack: packName };
}

/** GET /v1/spans array cap (newest first). Full retained size is still `count`. */
export const SPAN_LIST_CAP = 100;

function spanIdOf(span, index) {
  const raw =
    span?.spanId ??
    span?.id ??
    span?.attributes?.["span.id"] ??
    span?.attributes?.spanId ??
    null;
  if (raw != null && String(raw).trim() !== "") return String(raw);
  return `s${index}`;
}

function coerceUtcIso(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    let ms = value;
    if (value > 1e18) ms = value / 1e6;
    else if (value > 1e14) ms = value / 1e3;
    else if (value < 1e12) ms = value * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^\d+$/.test(s)) return coerceUtcIso(Number(s));
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  if (typeof value === "object") {
    if (value.seconds != null) {
      const sec = Number(value.seconds);
      const nanos = Number(value.nanos || 0);
      if (Number.isFinite(sec)) return coerceUtcIso(sec * 1e9 + nanos);
    }
  }
  return null;
}

/** ISO-8601 timestamp from common OTel / example fields. Missing → null. */
export function spanTs(span) {
  const candidates = [
    span?.timestamp,
    span?.startTime,
    span?.time,
    span?.startTimeUnixNano,
    span?.endTimeUnixNano,
    span?.attributes?.timestamp,
    span?.attributes?.["timestamp"],
    span?.attributes?.startTimeUnixNano,
    span?.attributes?.["startTimeUnixNano"],
  ];
  for (const c of candidates) {
    const iso = coerceUtcIso(c);
    if (iso) return iso;
  }
  return null;
}

/**
 * Recent span summaries for GET /v1/spans (FinOps debug).
 * Allowlist only — never prompt/completion/input/output text, API keys, Authorization.
 * Newest first (store is a ring: oldest at front). Cap default 100;
 * `count` is the full retained size; `truncated: true` when more.
 * Empty → `{ok:true, count:0, spans:[]}`.
 */
export function spansJson(spans, { prices = DEFAULT_PRICES, limit = SPAN_LIST_CAP } = {}) {
  const buf = Array.isArray(spans) ? spans : [];
  const count = buf.length;
  const capLimit =
    typeof limit === "number" && Number.isFinite(limit) && limit >= 0
      ? Math.floor(limit)
      : SPAN_LIST_CAP;
  const truncated = capLimit > 0 && count > capLimit;
  const start = truncated ? count - capLimit : 0;
  const rows = [];
  for (let i = count - 1; i >= start; i--) {
    const span = buf[i];
    const cost = spanCost(span, prices);
    const inTok = Number.isFinite(cost.inTok) ? cost.inTok : 0;
    const outTok = Number.isFinite(cost.outTok) ? cost.outTok : 0;
    rows.push({
      id: spanIdOf(span, i),
      model: cost.model,
      tenant: cost.tenant,
      inputTokens: inTok,
      outputTokens: outTok,
      usd: cost.usd,
      ts: spanTs(span),
    });
  }
  const out = { ok: true, count, spans: rows };
  if (truncated) out.truncated = true;
  return out;
}

/** GET /v1/tenants array cap (highest usd first). Full tenant count is still `count`. */
export const TENANT_LIST_CAP = 100;

function tenantBudgetMapOf(budgets) {
  if (budgets == null) return {};
  if (typeof budgets !== "object" || Array.isArray(budgets)) return {};
  if (
    Object.prototype.hasOwnProperty.call(budgets, "tenants") &&
    budgets.tenants &&
    typeof budgets.tenants === "object" &&
    !Array.isArray(budgets.tenants)
  ) {
    return normalizeTenantBudgetMap(budgets.tenants);
  }
  return normalizeTenantBudgetMap(budgets);
}

function isTenantsJsonOpts(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  return (
    "prices" in obj ||
    "budgets" in obj ||
    "tenantBudgets" in obj ||
    "tenant" in obj ||
    "limit" in obj ||
    "denyByTenant" in obj ||
    "period" in obj ||
    "budgetPeriod" in obj ||
    "now" in obj
  );
}

/**
 * Per-tenant cost rollup for GET /v1/tenants (FinOps inventory).
 * Allowlist only — never prompt/completion/input/output text, API keys, Authorization.
 * One row per distinct tenant id (missing/empty → `_`).
 * Sort: highest usd first, then id (stable).
 * Cap default 100; `count` is the full tenant count; `truncated: true` when more.
 * Empty → `{ok:true, count:0, tenants:[]}`.
 * Optional `budgetUsd` only when a matching tenant budget is configured (omit otherwise).
 * Do not attach the global budget to every row.
 * Optional `tenant` exact filter (unknown → empty list).
 *
 * Signature: tenantsJson(store, budgets?, cap=100)
 * Second arg may also be `{ prices, budgets, tenant, limit }` (same style as spansJson).
 */
export function tenantsJson(store, budgets = null, cap = TENANT_LIST_CAP) {
  let prices = DEFAULT_PRICES;
  let budgetMap = {};
  let filterTenant = null;
  let limit =
    typeof cap === "number" && Number.isFinite(cap) && cap >= 0
      ? Math.floor(cap)
      : TENANT_LIST_CAP;

  if (typeof budgets === "number" && Number.isFinite(budgets)) {
    limit = Math.floor(budgets);
  } else if (isTenantsJsonOpts(budgets)) {
    if (budgets.prices && typeof budgets.prices === "object" && !Array.isArray(budgets.prices)) {
      prices = budgets.prices;
    }
    budgetMap = tenantBudgetMapOf(budgets.budgets ?? budgets.tenantBudgets ?? null);
    if (budgets.tenant != null && String(budgets.tenant).trim() !== "") {
      filterTenant = String(budgets.tenant).trim();
    }
    if (budgets.limit != null) {
      const n = Number(budgets.limit);
      if (Number.isFinite(n) && n >= 0) limit = Math.floor(n);
    }
  } else {
    budgetMap = tenantBudgetMapOf(budgets);
  }

  const buf = Array.isArray(store) ? store : [];
  let period = null;
  let now = Date.now();
  if (isTenantsJsonOpts(budgets)) {
    period = resolveBudgetPeriod(budgets.period ?? budgets.budgetPeriod ?? null, {});
    if (budgets.now != null) now = budgets.now;
  }
  const counted = spansInBudgetPeriod(buf, period, now);
  const map = new Map();
  if (period === BUDGET_PERIOD_DAY) {
    for (const span of buf) {
      const id = spanTenant(span);
      if (!map.has(id)) map.set(id, { id, usd: 0, spanCount: 0 });
    }
  }
  for (const span of counted) {
    const cost = spanCost(span, prices);
    const id = cost.tenant || UNKNOWN_TENANT;
    if (!map.has(id)) map.set(id, { id, usd: 0, spanCount: 0 });
    const g = map.get(id);
    g.usd += Number(cost.usd) || 0;
    g.spanCount += 1;
  }

  let rows = [...map.values()].map((g) => {
    const row = {
      id: g.id,
      spanCount: g.spanCount,
      usd: Number(g.usd.toFixed(6)),
    };
    if (Object.prototype.hasOwnProperty.call(budgetMap, g.id)) {
      row.budgetUsd = budgetMap[g.id];
    }
    return row;
  });

  if (filterTenant != null) {
    rows = rows.filter((r) => r.id === filterTenant);
  }

  rows.sort((a, b) => {
    const d = Number(b.usd) - Number(a.usd);
    if (d) return d;
    return String(a.id).localeCompare(String(b.id));
  });

  const count = rows.length;
  const truncated = limit > 0 && count > limit;
  const tenants = truncated ? rows.slice(0, limit) : rows;
  const out = { ok: true, count, tenants };
  if (truncated) out.truncated = true;
  return out;
}

export const TENANT_CSV_COLUMNS = ["tenant", "spend_usd", "budget_usd", "remaining_usd", "denied_count"];

function denyCountMap(raw) {
  if (raw == null) return {};
  if (raw instanceof Map) return Object.fromEntries(raw);
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  return {};
}

/**
 * Chargeback-lite CSV from in-memory tenant totals (GET /v1/tenants.csv).
 * Header `tenant,spend_usd,budget_usd,remaining_usd,denied_count`.
 * Empty store → header only. Missing tenant → `_`.
 * budget_usd / remaining_usd blank when that tenant has no configured budget.
 * remaining = budget - spend (may be negative; same as tenantBudgetRemaining).
 * denied_count from the ingest deny map (0 if none). Do not invent extra series.
 */
export function formatTenantsCsv(store, opts = {}) {
  const list = tenantsJson(store, opts);
  const denies = denyCountMap(opts && (opts.denyByTenant ?? opts.denied));
  const lines = [TENANT_CSV_COLUMNS.join(",")];
  for (const t of list.tenants || []) {
    const spend = Number(t.usd) || 0;
    const hasBudget =
      t != null &&
      Object.prototype.hasOwnProperty.call(t, "budgetUsd") &&
      t.budgetUsd != null &&
      Number.isFinite(Number(t.budgetUsd));
    const budget = hasBudget ? Number(t.budgetUsd) : null;
    const remaining = hasBudget ? Number((budget - spend).toFixed(6)) : "";
    const deniedRaw = denies[t.id];
    const denied = Number.isFinite(Number(deniedRaw)) ? Math.floor(Number(deniedRaw)) : 0;
    lines.push(
      [
        csvEscape(t.id ?? UNKNOWN_TENANT),
        spend.toFixed(6),
        hasBudget ? Number(budget).toFixed(6) : "",
        remaining === "" ? "" : Number(remaining).toFixed(6),
        String(denied),
      ].join(",")
    );
  }
  return lines.join("\n") + "\n";
}

export function report(spans, prices = DEFAULT_PRICES, opts = {}) {
  const rows = spans.map((s) => spanCost(s, prices));
  const totalUsd = rows.reduce((a, r) => a + r.usd, 0);
  const byModel = {};
  for (const r of rows) {
    byModel[r.model] = (byModel[r.model] || 0) + r.usd;
  }
  for (const k of Object.keys(byModel)) {
    byModel[k] = Number(byModel[k].toFixed(6));
  }
  const byDay = groupRowsByDay(rows);
  const byTenant = groupRowsByTenant(rows);
  const tenantBudgets = opts && typeof opts === "object" ? opts.tenantBudgets : null;
  const budgetBreaches = tenantBudgetBreaches(byTenant, tenantBudgets);
  return { rows, totalUsd: Number(totalUsd.toFixed(6)), byModel, byDay, byTenant, budgetBreaches };
}

export function loadBudget(file) {
  const raw = fs.readFileSync(file, "utf8");
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("budget must be a JSON object");
  }
  return data;
}

/**
 * Compare a cost report against local threshold policy.
 * Returns { ok, breaches[], totalUsd, byModel, budget }.
 * Breach when actual > limit (strict greater-than).
 */
export function checkBudget(reportResult, budget) {
  if (!budget || typeof budget !== "object") {
    throw new Error("budget policy required");
  }
  const breaches = [];
  if (budget.maxTotalUsd != null && budget.maxTotalUsd !== "") {
    const limit = Number(budget.maxTotalUsd);
    if (Number.isFinite(limit) && reportResult.totalUsd > limit) {
      breaches.push({
        type: "maxTotalUsd",
        limit,
        actual: reportResult.totalUsd,
        message: `maxTotalUsd exceeded: actual=${reportResult.totalUsd} limit=${limit}`,
      });
    }
  }
  const perModel = budget.maxPerModelUsd || {};
  for (const [model, limitRaw] of Object.entries(perModel)) {
    const limit = Number(limitRaw);
    if (!Number.isFinite(limit)) continue;
    const actual = Number(reportResult.byModel?.[model] || 0);
    if (actual > limit) {
      breaches.push({
        type: "maxPerModelUsd",
        model,
        limit,
        actual: Number(actual.toFixed(6)),
        message: `maxPerModelUsd[${model}] exceeded: actual=${Number(actual.toFixed(6))} limit=${limit}`,
      });
    }
  }
  return {
    ok: breaches.length === 0,
    breaches,
    totalUsd: reportResult.totalUsd,
    byModel: reportResult.byModel,
    budget: {
      name: budget.name || null,
      maxTotalUsd: budget.maxTotalUsd ?? null,
      maxPerModelUsd: budget.maxPerModelUsd || {},
    },
  };
}

export function toDailyJson(reportResult) {
  const days = reportResult.byDay || groupRowsByDay(reportResult.rows || []);
  return {
    groupBy: "day",
    timezone: "UTC",
    totalUsd: reportResult.totalUsd,
    byModel: reportResult.byModel,
    byTenant: reportResult.byTenant || groupRowsByTenant(reportResult.rows || []),
    budgetBreaches: Array.isArray(reportResult.budgetBreaches) ? reportResult.budgetBreaches : [],
    days: days.map((g) => ({
      day: g.day,
      spanCount: g.spanCount,
      totalUsd: g.totalUsd,
      byModel: g.byModel,
      rows: g.rows.map((r) => ({
        model: r.model,
        inTok: r.inTok,
        outTok: r.outTok,
        usd: r.usd,
        day: r.day,
      })),
    })),
    rows: (reportResult.rows || []).map((r) => ({
      model: r.model,
      inTok: r.inTok,
      outTok: r.outTok,
      usd: r.usd,
      day: r.day,
    })),
  };
}

export const CSV_COLUMNS = ["date", "model", "spanCount", "usd", "tenant"];

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Flatten UTC daily-by-model+tenant totals into finance CSV rows.
 * Grain is date+model+tenant. Missing tenant → `"_"`.
 * `date` is the `day` field (YYYY-MM-DD / unknown). `tenant` is last so
 * existing `date,model,spanCount,usd` header greps still match.
 */
export function csvRowsFromReport(reportResult) {
  const days = reportResult.byDay || groupRowsByDay(reportResult.rows || []);
  const out = [];
  for (const g of days) {
    const map = new Map();
    for (const r of g.rows || []) {
      const model = r.model || "unknown";
      const tenant = r.tenant || UNKNOWN_TENANT;
      const key = model + "\0" + tenant;
      if (!map.has(key)) {
        map.set(key, { date: g.day, model, tenant, spanCount: 0, usd: 0 });
      }
      const row = map.get(key);
      row.spanCount += 1;
      row.usd += r.usd;
    }
    const rows = [...map.values()].sort((a, b) => {
      const m = String(a.model).localeCompare(String(b.model));
      if (m) return m;
      return String(a.tenant).localeCompare(String(b.tenant));
    });
    for (const r of rows) {
      out.push({
        date: r.date,
        model: r.model,
        spanCount: r.spanCount,
        usd: Number(r.usd.toFixed(6)),
        tenant: r.tenant,
      });
    }
  }
  return out;
}

/**
 * Finance CSV: header `date,model,spanCount,usd,tenant` (tenant last),
 * one row per day+model+tenant, plus a TOTAL row when there is data.
 * Empty spans → header only. Missing tenant → `"_"`.
 */
export function formatCsv(reportResult) {
  const rows = csvRowsFromReport(reportResult);
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.date),
        csvEscape(r.model),
        String(r.spanCount),
        Number(r.usd).toFixed(6),
        csvEscape(r.tenant ?? UNKNOWN_TENANT),
      ].join(",")
    );
  }
  if (rows.length) {
    const spanCount = rows.reduce((a, r) => a + Number(r.spanCount || 0), 0);
    const usd = Number(reportResult.totalUsd || 0);
    lines.push(["TOTAL", "", String(spanCount), usd.toFixed(6), ""].join(","));
  }
  return lines.join("\n") + "\n";
}

function mdEscapeCell(value) {
  const s = value == null ? "" : String(value);
  return s.replace(/\r\n/g, " ").replace(/\n/g, " ").replace(/\r/g, " ").replace(/\|/g, "\\|");
}

/**
 * Flatten byModel totals into Markdown table rows with span counts from `rows`.
 * Sort by usd desc, then model name. Empty → [].
 */
export function mdModelRows(reportResult) {
  const map = new Map();
  for (const r of reportResult?.rows || []) {
    const model = r.model || "unknown";
    if (!map.has(model)) map.set(model, { model, usd: 0, spans: 0 });
    const g = map.get(model);
    g.usd += Number(r.usd) || 0;
    g.spans += 1;
  }
  for (const [model, usd] of Object.entries(reportResult?.byModel || {})) {
    if (!map.has(model)) {
      map.set(model, { model, usd: Number(usd) || 0, spans: 0 });
    }
  }
  return [...map.values()]
    .map((g) => ({ model: g.model, usd: Number(Number(g.usd).toFixed(6)), spans: g.spans }))
    .sort((a, b) => {
      const d = b.usd - a.usd;
      if (d) return d;
      return String(a.model).localeCompare(String(b.model));
    });
}

/**
 * FinOps Markdown report for Slack / email / GitHub Actions `$GITHUB_STEP_SUMMARY`.
 *
 * Shape:
 *   # otel-ai-cost
 *   **totalUsd:** …  **spans:** …
 *   ## by model
 *   | model | usd | spans |
 *   ## by tenant
 *   | tenant | usd | spans |
 *
 * `|` in model/tenant cells is escaped. Empty spans → heading + zeros + table
 * headers (no data rows). Missing tenant → `"_"`.
 */
export function formatMd(reportResult) {
  const totalUsd = Number(reportResult?.totalUsd);
  const usd = Number.isFinite(totalUsd) ? Number(totalUsd.toFixed(6)) : 0;
  const spans = Array.isArray(reportResult?.rows) ? reportResult.rows.length : 0;
  const models = mdModelRows(reportResult);
  const tenants = reportResult?.byTenant || groupRowsByTenant(reportResult?.rows || []);
  const lines = [
    "# otel-ai-cost",
    `**totalUsd:** ${usd.toFixed(6)}  **spans:** ${spans}`,
    "## by model",
    "| model | usd | spans |",
    "| --- | --- | --- |",
  ];
  for (const m of models) {
    lines.push(`| ${mdEscapeCell(m.model)} | ${Number(m.usd).toFixed(6)} | ${m.spans} |`);
  }
  lines.push("## by tenant");
  lines.push("| tenant | usd | spans |");
  lines.push("| --- | --- | --- |");
  for (const t of tenants) {
    lines.push(
      `| ${mdEscapeCell(t.tenant ?? UNKNOWN_TENANT)} | ${Number(t.usd || 0).toFixed(6)} | ${t.spanCount ?? t.spans ?? 0} |`
    );
  }
  return lines.join("\n") + "\n";
}

function ghaEscapeData(text) {
  const s = text == null ? "" : String(text);
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function ghaEscapeProperty(text) {
  return ghaEscapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function ghaErrorLine(title, message) {
  return `::error title=${ghaEscapeProperty(title)}::${ghaEscapeData(message)}`;
}

function ghaUsd(n) {
  const x = Number(n);
  return Number.isFinite(x) ? String(x) : "0";
}

/**
 * GitHub Actions workflow commands for budget breaches (FinOps in CI).
 *
 * Global `--budget` maxTotalUsd → `::error title=budget::totalUsd X > budget Y`.
 * Each tenant breach → `::error title=tenant/<id>::usd X > budget Y`.
 * No breach → empty (no `::error`). Does not require GitHub.
 * Same `%` / CR / LF / `:` / `,` escaping as C/D `to_gha`.
 */
export function formatGha(reportResult, { budget = null } = {}) {
  const lines = [];
  const policy = budget && typeof budget === "object" && !Array.isArray(budget) ? budget : null;
  if (policy && policy.maxTotalUsd != null && policy.maxTotalUsd !== "") {
    const limit = Number(policy.maxTotalUsd);
    const actual = Number(reportResult?.totalUsd);
    if (Number.isFinite(limit) && Number.isFinite(actual) && actual > limit) {
      lines.push(ghaErrorLine("budget", `totalUsd ${ghaUsd(actual)} > budget ${ghaUsd(limit)}`));
    }
  }
  const items = Array.isArray(reportResult?.budgetBreaches) ? reportResult.budgetBreaches : [];
  for (const b of items) {
    const tenant = b?.tenant == null || String(b.tenant).trim() === "" ? UNKNOWN_TENANT : String(b.tenant);
    lines.push(ghaErrorLine(`tenant/${tenant}`, `usd ${ghaUsd(b.usd)} > budget ${ghaUsd(b.budget)}`));
  }
  if (!lines.length) return "";
  return lines.join("\n") + "\n";
}

export function formatBudgetResult(check) {
  const lines = [];
  if (check.ok) {
    lines.push("budget: OK");
  } else {
    lines.push(`budget: BREACHED (${check.breaches.length} limit(s))`);
    for (const b of check.breaches) {
      lines.push(`  - ${b.message}`);
    }
  }
  lines.push(`totalUsd=${check.totalUsd}`);
  lines.push("byModel: " + JSON.stringify(check.byModel));
  return lines.join("\n");
}

export function formatTable(reportResult, { groupBy = null } = {}) {
  const lines = [];
  if (groupBy === "day") {
    const days = reportResult.byDay || groupRowsByDay(reportResult.rows || []);
    lines.push("UTC day cost rollup");
    lines.push("===============");
    for (const g of days) {
      lines.push("");
      lines.push(`day ${g.day}  spans=${g.spanCount}  totalUsd=${g.totalUsd.toFixed(6)}`);
      lines.push("model           inTok   outTok       usd");
      lines.push("-------------- ------- -------- ----------");
      for (const r of g.rows) {
        lines.push(
          r.model.padEnd(14) +
            String(r.inTok).padStart(8) +
            String(r.outTok).padStart(9) +
            r.usd.toFixed(6).padStart(11)
        );
      }
      lines.push("-------------- ------- -------- ----------");
      lines.push(("SUBTOTAL " + g.day).padEnd(31) + g.totalUsd.toFixed(6).padStart(11));
      lines.push("byModel: " + JSON.stringify(g.byModel));
    }
    lines.push("");
    lines.push("===============");
    lines.push("TOTAL".padEnd(31) + reportResult.totalUsd.toFixed(6).padStart(11));
    lines.push("byDay: " + JSON.stringify(Object.fromEntries((days || []).map((d) => [d.day, d.totalUsd]))));
    lines.push("byModel: " + JSON.stringify(reportResult.byModel));
    return lines.join("\n");
  }
  lines.push("model           inTok   outTok       usd");
  lines.push("-------------- ------- -------- ----------");
  for (const r of reportResult.rows) {
    lines.push(
      r.model.padEnd(14) +
        String(r.inTok).padStart(8) +
        String(r.outTok).padStart(9) +
        r.usd.toFixed(6).padStart(11)
    );
  }
  lines.push("-------------- ------- -------- ----------");
  lines.push("TOTAL".padEnd(31) + reportResult.totalUsd.toFixed(6).padStart(11));
  lines.push("");
  lines.push("byModel: " + JSON.stringify(reportResult.byModel));
  return lines.join("\n");
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function loadPolicy(file) {
  const raw = fs.readFileSync(file, "utf8");
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("policy must be a JSON object");
  }
  return data;
}

function sampleRateForSpan(span, policy, fallback = 1) {
  const name = span.name || span.attributes?.["span.name"] || "";
  const rates = Array.isArray(policy?.sampleRates) ? policy.sampleRates : [];
  let star = null;
  for (const rule of rates) {
    const prefix = rule.prefix ?? "";
    const rate = Number(rule.rate);
    if (!Number.isFinite(rate)) continue;
    if (prefix === "*") {
      star = rate;
      continue;
    }
    if (prefix && name.startsWith(prefix)) return rate;
  }
  if (star != null) return star;
  if (policy && Number.isFinite(Number(policy.defaultSampleRate))) {
    return Number(policy.defaultSampleRate);
  }
  return fallback;
}

export function redactSpan(span, policy = null) {
  const copy = JSON.parse(JSON.stringify(span));
  const attrs = copy.attributes || {};
  const keys = policy?.redactAttrs?.length ? policy.redactAttrs : DEFAULT_REDACT_KEYS;
  const patterns = (policy?.redactAttrPatterns || [
    "prompt",
    "completion",
    "email",
    "secret",
    "password",
  ]).map((p) => new RegExp(p, "i"));
  for (const k of Object.keys(attrs)) {
    if (keys.includes(k) || patterns.some((rx) => rx.test(k))) {
      attrs[k] = "[REDACTED]";
    }
  }
  copy.attributes = attrs;
  return copy;
}

/**
 * Filter spans with optional policy pack (sample rates by name prefix + redact attrs).
 * Returns kept + dropped for multi-sink routing.
 *
 * Options:
 *   sample  global keep probability when no policy sampleRates (default 1)
 *   redact  force redaction
 *   seed    deterministic RNG seed
 *   policy  loaded policy pack
 */
export function filterSpans(
  spans,
  { sample = 1, redact = false, seed = 42, policy = null } = {}
) {
  const rand = mulberry32(seed);
  const kept = [];
  const dropped = [];
  const usePolicySample =
    policy && Array.isArray(policy.sampleRates) && policy.sampleRates.length > 0;
  const shouldRedact =
    !!redact ||
    !!(policy && (policy.redactAttrs?.length || policy.redactAttrPatterns?.length));
  const globalSample = sample == null ? 1 : Number(sample);

  for (const s of spans) {
    const rate = usePolicySample
      ? sampleRateForSpan(s, policy, globalSample)
      : globalSample;
    const keep = rate >= 1 || rand() < rate;
    if (keep) {
      kept.push(shouldRedact ? redactSpan(s, policy) : s);
    } else {
      dropped.push(s);
    }
  }

  const before = spans.length;
  const after = kept.length;
  const reductionPct =
    before === 0 ? 0 : Number((((before - after) / before) * 100).toFixed(2));
  return {
    spans: kept,
    kept,
    dropped,
    before,
    after,
    droppedCount: dropped.length,
    reductionPct,
    sample: usePolicySample ? "policy" : globalSample,
    redact: shouldRedact,
    policy: policy ? { name: policy.name, version: policy.version } : null,
  };
}

function byModelChartSvg(byModel, esc) {
  const entries = Object.entries(byModel || {})
    .map(([model, usd]) => [model, Number(usd) || 0])
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return `<svg role="img" aria-label="cost by model (empty)" width="480" height="40" xmlns="http://www.w3.org/2000/svg"><text x="0" y="20" fill="#555" font-size="12">no byModel data</text></svg>`;
  }
  const max = Math.max(...entries.map(([, u]) => u), 1e-12);
  const rowH = 28;
  const labelW = 120;
  const barMaxW = 280;
  const padL = 8;
  const padR = 72;
  const padT = 8;
  const width = padL + labelW + barMaxW + padR;
  const height = padT + entries.length * rowH + 8;
  const bars = entries
    .map(([model, usd], i) => {
      const y = padT + i * rowH;
      const w = Math.max(2, Math.round((usd / max) * barMaxW));
      const label = esc(model);
      const value = `$${usd.toFixed(6)}`;
      return `<g>
  <text x="${padL}" y="${y + 16}" fill="#222" font-size="12" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${label}</text>
  <rect x="${padL + labelW}" y="${y + 4}" width="${w}" height="16" fill="#3b82f6" rx="2"/>
  <text x="${padL + labelW + w + 6}" y="${y + 16}" fill="#555" font-size="11" font-family="ui-sans-serif,system-ui,sans-serif">${value}</text>
</g>`;
    })
    .join("\n");
  return `<svg role="img" aria-label="cost by model" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
${bars}
</svg>`;
}

export function formatHtml(reportResult, { groupBy = null, tenantBudgets = null, period = null, remaining = null } = {}) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const rows = reportResult.rows
    .map(
      (r) =>
        `<tr><td>${esc(r.model)}</td><td>${r.inTok}</td><td>${r.outTok}</td><td>${r.usd.toFixed(6)}</td></tr>`
    )
    .join("\n");
  const byModelList = Object.entries(reportResult.byModel || {})
    .map(([m, u]) => `<li><code>${esc(m)}</code>: $${Number(u).toFixed(6)}</li>`)
    .join("\n");
  const chart = byModelChartSvg(reportResult.byModel, esc);
  const tenants = reportResult.byTenant || groupRowsByTenant(reportResult.rows || []);
  const tenantBreaches = Array.isArray(reportResult.budgetBreaches) ? reportResult.budgetBreaches : [];
  const tenantRows = tenants
    .map(
      (t) =>
        `<tr><td><code>${esc(t.tenant)}</code></td><td>${t.spanCount}</td><td>${Number(t.usd).toFixed(6)}</td></tr>`
    )
    .join("\n");
  const tenantSection = tenants.length
    ? `
<h2 id="by-tenant">by tenant</h2>
<p class="meta">Span attribute <code>tenant</code> · missing/empty → <code>_</code></p>
<table>
<thead><tr><th>tenant</th><th>spans</th><th>usd</th></tr></thead>
<tbody>
${tenantRows}
</tbody>
</table>
`
    : "";
  const remainingRows = Array.isArray(remaining)
    ? remaining
    : tenantBudgetRemaining(tenants, tenantBudgets);
  const remainRows = remainingRows
    .map(
      (t) =>
        `<tr><td><code>${esc(t.tenant)}</code></td><td>${Number(t.usd).toFixed(6)}</td><td>${Number(t.budget).toFixed(6)}</td><td>${Number(t.remaining).toFixed(6)}</td></tr>`
    )
    .join("\n");
  const periodLabel = period === "day" ? "UTC day" : "cumulative";
  const remainSection = remainingRows.length
    ? `
<h2 id="budget-remaining">budget remaining</h2>
<p class="meta">Configured <code>--tenant-budget</code> minus spend (may be negative) · period: ${esc(periodLabel)}</p>
<table>
<thead><tr><th>tenant</th><th>usd</th><th>budget</th><th>remaining</th></tr></thead>
<tbody>
${remainRows}
</tbody>
</table>
`
    : "";
  const breachRows = tenantBreaches
    .map(
      (b) =>
        `<tr><td><code>${esc(b.tenant)}</code></td><td>${Number(b.usd).toFixed(6)}</td><td>${Number(b.budget).toFixed(6)}</td></tr>`
    )
    .join("\n");
  const breachSection = tenantBreaches.length
    ? `
<h2 id="budget-breaches">tenant budget breaches</h2>
<p class="meta">Per-tenant usd &gt; <code>--tenant-budget</code> · <code>_</code> gated only when set explicitly</p>
<table>
<thead><tr><th>tenant</th><th>usd</th><th>budget</th></tr></thead>
<tbody>
${breachRows}
</tbody>
</table>
`
    : "";
  const days = reportResult.byDay || [];
  const showDays =
    groupBy === "day" ||
    (Array.isArray(days) && days.length > 0 && days.some((d) => d.day && d.day !== "unknown"));
  let daySection = "";
  if (showDays && days.length) {
    const dayBlocks = days
      .map((g) => {
        const dayRows = g.rows
          .map(
            (r) =>
              `<tr><td>${esc(r.model)}</td><td>${r.inTok}</td><td>${r.outTok}</td><td>${r.usd.toFixed(6)}</td></tr>`
          )
          .join("\n");
        const bm = Object.entries(g.byModel || {})
          .map(([m, u]) => `<li><code>${esc(m)}</code>: $${Number(u).toFixed(6)}</li>`)
          .join("\n");
        return `<section class="day" data-day="${esc(g.day)}">
<h3>day ${esc(g.day)} <span class="meta">(spans=${g.spanCount})</span></h3>
<table>
<thead><tr><th>model</th><th>inTok</th><th>outTok</th><th>usd</th></tr></thead>
<tbody>
${dayRows}
</tbody>
<tfoot><tr><td colspan="3">SUBTOTAL ${esc(g.day)}</td><td>${g.totalUsd.toFixed(6)}</td></tr></tfoot>
</table>
<ul>${bm}</ul>
</section>`;
      })
      .join("\n");
    const daySummary = days
      .map(
        (g) =>
          `<tr><td><code>${esc(g.day)}</code></td><td>${g.spanCount}</td><td>${g.totalUsd.toFixed(6)}</td></tr>`
      )
      .join("\n");
    daySection = `
<h2 id="by-day">by day (UTC)</h2>
<p class="meta">Daily cost rollup · UTC calendar days from span timestamps</p>
<table>
<thead><tr><th>day (UTC)</th><th>spans</th><th>usd</th></tr></thead>
<tbody>
${daySummary}
</tbody>
<tfoot><tr><td colspan="2">TOTAL</td><td>${reportResult.totalUsd.toFixed(6)}</td></tr></tfoot>
</table>
${dayBlocks}
`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>otel-ai-cost report</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;margin:2rem;color:#111}
h1{font-size:1.25rem}
h2{font-size:1.05rem;margin-top:1.5rem}
h3{font-size:0.95rem;margin-top:1.25rem}
table{border-collapse:collapse;margin:1rem 0;min-width:28rem}
th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}
th{background:#f5f5f5}
tfoot td{font-weight:700}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.meta{color:#555;font-size:.9rem}
.chart{margin:1rem 0;overflow-x:auto}
section.day{margin:1rem 0 1.5rem;padding:0.5rem 0;border-top:1px solid #eee}
</style>
</head>
<body>
<h1>otel-ai-cost report</h1>
<p class="meta">Self-contained static HTML · pure SVG chart · no external JS/CDN · generated by otel-ai-cost</p>
<table>
<thead><tr><th>model</th><th>inTok</th><th>outTok</th><th>usd</th></tr></thead>
<tbody>
${rows}
</tbody>
<tfoot><tr><td colspan="3">TOTAL</td><td>${reportResult.totalUsd.toFixed(6)}</td></tr></tfoot>
</table>
${daySection}
<h2>byModel</h2>
<div class="chart">
${chart}
</div>
<ul>
${byModelList}
</ul>
${tenantSection}
${remainSection}
${breachSection}
</body>
</html>
`;
}
