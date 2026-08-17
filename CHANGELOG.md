# Changelog — E · otel-ai-cost

## Unreleased

- Prometheus: per-tenant spend (`otel_ai_cost_by_tenant_usd`), budget remaining (`otel_ai_cost_budget_remaining_usd`), budget-deny counter (`otel_ai_cost_budget_deny_total`), token totals (`otel_ai_cost_input_tokens` / `otel_ai_cost_output_tokens`). Existing total / by-model / span-count names unchanged.
- Ingest: when a tenant is already over `--tenant-budget`, further traces for that tenant are not stored; response includes `denied` (still HTTP 200; `accepted` remains parsed count).
- Dedicated Grafana dashboard `deploy/grafana/e-otel-ai-cost.json` (per-tenant spend, remaining, deny, tokens, top models). Shared `oss-cash-lab.json` is untouched.
- Local OTLP demo: `scripts/otlp-demo.sh` (wired from `scripts/local-mvp.sh`).
- Docs: `docs/otel-cost.md` (attributes, demo, Helicone/Langfuse/OTel positioning) and `docs/collector-contrib-issue.md` (draft only; not filed).
