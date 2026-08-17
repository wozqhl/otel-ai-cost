# Roadmap — E · otel-ai-cost

## Now (local-mvp)

- OTel-native tenant spend + budget deny from GenAI span attributes.
- Budget-breach webhook on HTTP ingest deny (once per denied request).
- Prometheus series for total / model / tenant / remaining / deny / tokens.
- Dedicated Grafana JSON plus the shared portfolio Total USD / Cost by model panels.
- Local OTLP demo (no Docker).

## Next (still OSS)

- Accept an upstream `gen_ai.cost.usd` attribute if semantic conventions land (see `docs/collector-contrib-issue.md`; draft only).
- Optional deny-on-would-exceed (today we deny only after the tenant is already over).

## Paid later

- Hosted dashboard, anomaly alerts, chargeback.
- Webhook exponential backoff / queues / key rotation / timestamp replay.
- Multi-sink exporters, SSO, multi-tenant control plane.
