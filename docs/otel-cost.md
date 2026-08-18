# OTel AI cost — attributes, demo, positioning

> E · otel-ai-cost · local-mvp. Companion: [collector-contrib-issue.md](./collector-contrib-issue.md) (draft only; not filed).

This service is an **OTel-native tenant spend + budget deny** plane. It estimates USD from GenAI span attributes, rolls up by tenant, and rejects further OTLP ingest when a tenant is already over budget or the incoming cost would exceed it.

## Positioning (honest, no fake stats)

| Project | What happened | What this is not |
|---------|---------------|------------------|
| **Helicone** | Went **maintenance** after the **Mintlify acquisition (Mar 2026)**. | Not a Helicone proxy, prompt playground, or hosted request log. |
| **Langfuse** | **Acquired by ClickHouse (Jan 2026)**. | Not a trace UI, eval suite, or ClickHouse warehouse. |
| **OpenTelemetry** | **Graduated CNCF (May 2026)**. GenAI semantic conventions are the ingest contract. | Not a collector distribution. We consume OTLP JSON; we do not ship a contrib receiver. |

Helicone and Langfuse are (or were) full LLM observability products. After those ownership changes, teams that already emit OTel GenAI spans still need a **small, local cost + budget gate** that speaks Prometheus and does not require a vendor SaaS. That is this tool: tenant spend from spans, remaining budget, and a deny counter when ingest is rejected.

Hosted dashboards, anomaly alerts, and chargeback remain **paid later**. The OSS path is CLI + local `serve` + importable Grafana JSON.

## Attributes we accept

Ingest (`POST /v1/traces`, alias `POST /v1/otlp/v1/traces`) is **JSON only** (no protobuf). Shapes:

- simplified OTLP `ExportTraceServiceRequest`: `resourceSpans[].scopeSpans[].spans[]`
- flat `{ spans: [] }` or a bare array (same as `examples/spans.json`)

Attributes may be a map or an OTLP key/value list (`stringValue` / `intValue` / `doubleValue`). Resource attributes merge under span attributes (span wins).

| Attribute / field | Role |
|-------------------|------|
| `gen_ai.request.model` (or `span.model`) | Price-table key. Unknown model uses fallback `{ inputPerMTok: 1, outputPerMTok: 3 }`. |
| `gen_ai.usage.input_tokens` (or `span.inputTokens`) | Input tokens. |
| `gen_ai.usage.output_tokens` (or `span.outputTokens`) | Output tokens. |
| `tenant` (span attr or `span.tenant`) | Tenant id. Missing / null / whitespace becomes `"_"` (documented sentinel). |
| `gen_ai.cost.usd` (if present) | Incoming USD for this span when a finite number ≥ 0. Missing / invalid → token × price. Not a shipped OTel semantic convention. |
| `timestamp` / `startTime` / `startTimeUnixNano` / `endTimeUnixNano` | UTC day + ISO `ts` on `/v1/spans`. |

**Never stored on `/v1/spans` or `/v1/tenants`:** `gen_ai.prompt`, `gen_ai.completion`, emails, API keys, `Authorization`. Filter/redact packs still strip those on the CLI path.

Built-in price table (`DEFAULT_PRICES`): `gpt-4o-mini`, `gpt-4o`, `claude-sonnet` (`inputPerMTok` / `outputPerMTok`).

## Attributes / series we emit

HTTP JSON (`GET /report.json`, `GET /v1/costs`, `GET /v1/tenants`) already exposes `byTenant`, `budgetBreaches`, optional `budgetUsd`. Prometheus `GET /metrics` (0.0.4 text):

| Metric | Type | Source |
|--------|------|--------|
| `otel_ai_cost_total_usd` | gauge | snapshot `totalUsd` |
| `otel_ai_cost_by_model_usd{model}` | gauge | snapshot `byModel` |
| `otel_ai_cost_by_tenant_usd{tenant}` | gauge | snapshot `byTenant` |
| `otel_ai_cost_budget_remaining_usd{tenant}` | gauge | configured `--tenant-budget` minus spend (may be **negative**) |
| `otel_ai_cost_budget_deny_total` / `{tenant}` | counter | process-lifetime ingest denies; snapshot fallback = current `budgetBreaches` |
| `otel_ai_cost_input_tokens` | gauge | sum of `inTok` |
| `otel_ai_cost_output_tokens` | gauge | sum of `outTok` |
| `otel_ai_cost_span_count` | counter | snapshot row count |

**Budget deny:** ingest is denied when the tenant is already over budget **or** `current + incoming` would exceed it (default; exact-on-budget allowed). Denied `POST /v1/traces` spans are **not stored**. The POST stays **200** `{ ok, accepted, denied }` (`accepted` is still the parsed count, same as span-max). `DENY_ON_WOULD_EXCEED=false` restores deny-only-after-already-over. `_` is not gated unless you set a budget for `_`. No tenant budgets means deny never fires. When `--webhook-url` is set, the existing budget-breach webhook fires **once per denied request** (`tenant`, `spend`, `budget`, `denied`; HMAC/timestamp if configured; no prompt text). No webhook URL → still **200** `{denied:N}`.

Grafana: dedicated `deploy/grafana/e-otel-ai-cost.json` (per-tenant spend, remaining, deny, tokens, top models). Shared portfolio panels (Total USD, Cost by model) stay in `oss-cash-lab.json` — do not edit that file from this stream.


## How to run the demo

No Docker. Node 18+.

See the scripts directory for otlp-demo and local-mvp.
The demo uses loopback port 8841 unless OTLP_DEMO_PORT is set.
It proves tenant spend, budget remaining, deny count, and token series.
Grafana parse-only check lives at repo scripts/check-grafana.sh (no Grafana process).
