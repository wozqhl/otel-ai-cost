# Roadmap — E · otel-ai-cost

## Now (local-mvp)

- OTel-native tenant spend + budget deny from GenAI span attributes.
- Budget-breach webhook on HTTP ingest deny (once per denied request).
- Deny ingest when current spend + incoming cost would exceed the tenant budget (default; exact-on-budget allowed; `DENY_ON_WOULD_EXCEED=false` restores deny-only-after-over).
- Prometheus series for total / model / tenant / remaining / deny / tokens.
- Dedicated Grafana JSON plus the shared portfolio Total USD / Cost by model panels.
- Local OTLP demo (no Docker).
- Accept `gen_ai.cost.usd` on a span **if present** (finite number ≥ 0) as that span's incoming cost; missing/invalid keeps token × price. Draft name only — not a shipped OTel convention (see `docs/collector-contrib-issue.md`).
- Chargeback-lite CSV: `GET /v1/tenants.csv` from in-memory totals (`tenant,spend_usd,budget_usd,remaining_usd,denied_count`); hosted dashboard still paid later.
- Optional `BUDGET_PERIOD=day` / `--budget-period day` so tenant remaining and deny reset at UTC midnight (default off, cumulative).

## Next (still OSS)

- Collector-contrib processor that *writes* cost/budget attributes (draft only; not filed). This repo already *reads* `gen_ai.cost.usd` if present.

## Paid later

- Hosted dashboard, anomaly alerts, chargeback.
- Webhook exponential backoff / queues / key rotation / timestamp replay.
- Multi-sink exporters, SSO, multi-tenant control plane.
