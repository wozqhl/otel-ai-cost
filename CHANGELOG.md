# Changelog — E · otel-ai-cost

## Unreleased

- Local HTML dashboard (`GET /` / `--html`) shows remaining-by-tenant when `--tenant-budget` is set (same remaining as CSV/metrics; period: UTC day / cumulative). Grafana remaining panel already scraped `otel_ai_cost_budget_remaining_usd`; no new series or panel.
- Optional UTC calendar-day budget window: `BUDGET_PERIOD=day` / `--budget-period day` (default off); remaining / denied_count / would-exceed count only the current UTC day.
- Chargeback-lite: `GET /v1/tenants.csv` (alias `?format=csv`) exports in-memory tenant totals as `tenant,spend_usd,budget_usd,remaining_usd,denied_count`; JSON `GET /v1/tenants` unchanged.
- Ingest/report: if span attribute `gen_ai.cost.usd` is present and a finite number ≥ 0, use it as that span's cost (would-exceed deny + webhook included); otherwise keep token × price. Not a shipped OTel convention.
- Prometheus: per-tenant spend (`otel_ai_cost_by_tenant_usd`), budget remaining (`otel_ai_cost_budget_remaining_usd`), budget-deny counter (`otel_ai_cost_budget_deny_total`), token totals (`otel_ai_cost_input_tokens` / `otel_ai_cost_output_tokens`). Existing total / by-model / span-count names unchanged.
- Ingest: deny when current spend + incoming cost would exceed the tenant budget (default ON; exact-on-budget allowed). Already-over deny unchanged. `DENY_ON_WOULD_EXCEED=false` restores deny-only-after-over.
- Ingest: when a tenant is already over `--tenant-budget`, further traces for that tenant are not stored; response includes `denied` (still HTTP 200; `accepted` remains parsed count).
- HTTP ingest deny fires the existing budget-breach webhook **once per denied request** (`tenant`, `spend`, `budget`, `denied`; HMAC/timestamp if configured; no prompt text). No webhook URL → still 200 `{denied:N}`.
- Dedicated Grafana dashboard `deploy/grafana/e-otel-ai-cost.json` (per-tenant spend, remaining, deny, tokens, top models). Shared `oss-cash-lab.json` is untouched.
- Local OTLP demo: `scripts/otlp-demo.sh` (wired from `scripts/local-mvp.sh`).
- Docs: `docs/otel-cost.md` (attributes, demo, Helicone/Langfuse/OTel positioning) and `docs/collector-contrib-issue.md` (draft only; not filed).
