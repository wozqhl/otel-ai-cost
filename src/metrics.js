/** Prometheus text exposition of the cost snapshot (Node stdlib only). */

function escapeLabelValue(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function formatNumber(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0";
  return String(x);
}

function asObjectMap(value) {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function tokenTotals(reportResult) {
  const rows = Array.isArray(reportResult.rows) ? reportResult.rows : [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const r of rows) {
    const inn = Number(r?.inTok);
    const out = Number(r?.outTok);
    if (Number.isFinite(inn)) inputTokens += inn;
    if (Number.isFinite(out)) outputTokens += out;
  }
  return { inputTokens, outputTokens };
}

function denySeries(reportResult, opts) {
  const labeled = asObjectMap(opts.denyByTenant);
  if (Object.keys(labeled).length) return labeled;
  const breaches = Array.isArray(reportResult.budgetBreaches) ? reportResult.budgetBreaches : [];
  if (breaches.length) {
    const out = {};
    for (const b of breaches) {
      const tenant = b?.tenant == null || String(b.tenant).trim() === "" ? "_" : String(b.tenant);
      out[tenant] = (out[tenant] || 0) + 1;
    }
    return out;
  }
  return null;
}

/**
 * Render Prometheus 0.0.4 text for a cost report snapshot.
 * Gauges: `otel_ai_cost_total_usd`, `otel_ai_cost_by_model_usd{model}`,
 * `otel_ai_cost_by_tenant_usd{tenant}`, `otel_ai_cost_budget_remaining_usd{tenant}`,
 * `otel_ai_cost_input_tokens`, `otel_ai_cost_output_tokens`.
 * Counters: `otel_ai_cost_span_count`, `otel_ai_cost_budget_deny_total`.
 *
 * Tenant / remaining / deny series are derived from cost.js `byTenant`,
 * `budgetBreaches`, and optional `tenantBudgets` (same map as `--tenant-budget`).
 * Optional `denyTotal` / `denyByTenant` are process-lifetime ingest denies
 * (serve). When omitted, deny falls back to current `budgetBreaches`.
 */
export function renderCostMetrics(reportResult = {}, opts = {}) {
  const totalUsd = Number(reportResult.totalUsd);
  const spanCount = Array.isArray(reportResult.rows)
    ? reportResult.rows.length
    : Number(reportResult.spanCount);
  const byModel =
    reportResult.byModel && typeof reportResult.byModel === "object" && !Array.isArray(reportResult.byModel)
      ? reportResult.byModel
      : {};
  const byTenant = Array.isArray(reportResult.byTenant) ? reportResult.byTenant : [];
  const tenantBudgets = asObjectMap(opts.tenantBudgets);
  const { inputTokens, outputTokens } = tokenTotals(reportResult);

  const lines = [];

  lines.push("# HELP otel_ai_cost_total_usd Total estimated USD cost from the snapshot report");
  lines.push("# TYPE otel_ai_cost_total_usd gauge");
  lines.push(`otel_ai_cost_total_usd ${formatNumber(Number.isFinite(totalUsd) ? totalUsd : 0)}`);

  lines.push("# HELP otel_ai_cost_by_model_usd Estimated USD cost by model");
  lines.push("# TYPE otel_ai_cost_by_model_usd gauge");
  const models = Object.keys(byModel).sort();
  if (models.length === 0) {
    // unlabeled zero so scrapers still see the metric name
    lines.push("otel_ai_cost_by_model_usd 0");
  } else {
    for (const model of models) {
      lines.push(
        `otel_ai_cost_by_model_usd{model="${escapeLabelValue(model)}"} ${formatNumber(byModel[model])}`
      );
    }
  }

  lines.push("# HELP otel_ai_cost_by_tenant_usd Estimated USD cost by tenant (missing tenant → _)");
  lines.push("# TYPE otel_ai_cost_by_tenant_usd gauge");
  if (byTenant.length === 0) {
    lines.push("otel_ai_cost_by_tenant_usd 0");
  } else {
    const tenantRows = [...byTenant].sort((a, b) =>
      String(a?.tenant ?? "_").localeCompare(String(b?.tenant ?? "_"))
    );
    for (const row of tenantRows) {
      const tenant = row?.tenant == null || String(row.tenant).trim() === "" ? "_" : String(row.tenant);
      lines.push(
        `otel_ai_cost_by_tenant_usd{tenant="${escapeLabelValue(tenant)}"} ${formatNumber(row?.usd)}`
      );
    }
  }

  lines.push("# HELP otel_ai_cost_budget_remaining_usd Configured tenant budget minus spend (may be negative)");
  lines.push("# TYPE otel_ai_cost_budget_remaining_usd gauge");
  const spendByTenant = new Map();
  for (const row of byTenant) {
    const tenant = row?.tenant == null || String(row.tenant).trim() === "" ? "_" : String(row.tenant);
    spendByTenant.set(tenant, Number(row?.usd) || 0);
  }
  const budgetTenants = Object.keys(tenantBudgets).sort();
  if (budgetTenants.length === 0) {
    lines.push("otel_ai_cost_budget_remaining_usd 0");
  } else {
    for (const tenant of budgetTenants) {
      const budget = Number(tenantBudgets[tenant]);
      if (!Number.isFinite(budget)) continue;
      const usd = spendByTenant.has(tenant) ? spendByTenant.get(tenant) : 0;
      const remaining = budget - usd;
      lines.push(
        `otel_ai_cost_budget_remaining_usd{tenant="${escapeLabelValue(tenant)}"} ${formatNumber(remaining)}`
      );
    }
  }

  lines.push("# HELP otel_ai_cost_budget_deny_total Tenant budget-deny events (ingest rejected while over budget; snapshot falls back to current breaches)");
  lines.push("# TYPE otel_ai_cost_budget_deny_total counter");
  const denyMap = denySeries(reportResult, opts);
  if (denyMap) {
    for (const tenant of Object.keys(denyMap).sort()) {
      lines.push(
        `otel_ai_cost_budget_deny_total{tenant="${escapeLabelValue(tenant)}"} ${formatNumber(denyMap[tenant])}`
      );
    }
  } else {
    const denyTotal = Number(opts.denyTotal);
    lines.push(
      `otel_ai_cost_budget_deny_total ${formatNumber(Number.isFinite(denyTotal) ? denyTotal : 0)}`
    );
  }

  lines.push("# HELP otel_ai_cost_input_tokens Sum of gen_ai.usage.input_tokens in the snapshot");
  lines.push("# TYPE otel_ai_cost_input_tokens gauge");
  lines.push(`otel_ai_cost_input_tokens ${formatNumber(inputTokens)}`);

  lines.push("# HELP otel_ai_cost_output_tokens Sum of gen_ai.usage.output_tokens in the snapshot");
  lines.push("# TYPE otel_ai_cost_output_tokens gauge");
  lines.push(`otel_ai_cost_output_tokens ${formatNumber(outputTokens)}`);

  lines.push("# HELP otel_ai_cost_span_count Number of spans in the snapshot report");
  lines.push("# TYPE otel_ai_cost_span_count counter");
  lines.push(`otel_ai_cost_span_count ${Number.isFinite(spanCount) ? spanCount : 0}`);

  lines.push("");
  return lines.join("\n");
}
