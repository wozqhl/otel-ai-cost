# Draft: collector-contrib cost / budget attribute

> **Draft only. Do not file upstream.** Local notes for a possible OpenTelemetry Collector contrib issue.
> Status: not submitted. No GitHub issue, no PR.

## Title (draft)

processor/attributes: optional `gen_ai.cost.usd` + `gen_ai.cost.budget_usd` from usage tokens and a price table

## Problem

OTel GenAI semantic conventions (post CNCF graduation, May 2026) standardize `gen_ai.request.model` and `gen_ai.usage.{input,output}_tokens`. They do **not** standardize a USD cost or a tenant budget remaining on the span.

FinOps pipelines therefore re-price in a sidecar (this repo: otel-ai-cost) or in a vendor (Helicone, now maintenance after Mintlify, Mar 2026; Langfuse, acquired by ClickHouse, Jan 2026). A collector processor that attached cost/budget attributes would let any OTLP backend — including a local budget-deny gate — filter without a second price table.

## Proposed attributes (draft; names not final)

| Attribute | Type | Meaning |
|-----------|------|---------|
| `gen_ai.cost.usd` | double | Estimated USD for this span (input+output * configured rates). |
| `gen_ai.cost.budget_usd` | double | Optional remaining or configured tenant budget (processor config, not a secret). |
| `gen_ai.cost.tenant` | string | Optional copy of `tenant` / `gen_ai.cost.tenant` for processors that cannot read arbitrary keys. |

This repo already reads `tenant`, `gen_ai.request.model`, and usage tokens. It **emits** Prometheus `otel_ai_cost_*` series; it does **not** write cost attributes back onto spans today. If contrib adopted `gen_ai.cost.usd`, this service would accept it as an override and stop re-pricing when present (honest: not implemented yet).

## Non-goals

- Not a contrib exporter to this repo.
- Not a protobuf change.
- Not a replacement for `gen_ai.usage.*`.
- No vendor lock-in; price table is local config.

## Why not file now

The attribute names need semantic-conventions review first. Filing a collector-contrib issue before the spec discussion would create a processor that invents `gen_ai.cost.*` and then has to rename. Keep this draft next to the local-mvp until conventions exist.

## Local workaround

`bets/e-otel-ai-cost` prices spans at ingest/report time and exposes `otel_ai_cost_by_tenant_usd`, `otel_ai_cost_budget_remaining_usd`, and `otel_ai_cost_budget_deny_total`. See `docs/otel-cost.md`.
