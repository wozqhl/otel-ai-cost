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

/**
 * Render Prometheus 0.0.4 text for a cost report snapshot.
 * Gauges: `otel_ai_cost_total_usd`, `otel_ai_cost_by_model_usd{model}`.
 * Counter: `otel_ai_cost_span_count`.
 */
export function renderCostMetrics(reportResult = {}) {
  const totalUsd = Number(reportResult.totalUsd);
  const spanCount = Array.isArray(reportResult.rows)
    ? reportResult.rows.length
    : Number(reportResult.spanCount);
  const byModel =
    reportResult.byModel && typeof reportResult.byModel === "object" && !Array.isArray(reportResult.byModel)
      ? reportResult.byModel
      : {};

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

  lines.push("# HELP otel_ai_cost_span_count Number of spans in the snapshot report");
  lines.push("# TYPE otel_ai_cost_span_count counter");
  lines.push(`otel_ai_cost_span_count ${Number.isFinite(spanCount) ? spanCount : 0}`);

  lines.push("");
  return lines.join("\n");
}
