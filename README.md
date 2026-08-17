# E · otel-ai-cost

> AI telemetry cost plane (OpenTelemetry) · **Status: local-mvp** · Phase 3

## Thesis / 立意

Token invoices are too coarse. Attribute cost from OTel spans to teams/features with a configurable price table.

从 OTel span 估算 token 成本，按团队/特性分摊，支撑 FinOps。

## Who pays / 谁付钱

- FinOps / platform teams
- 财务 / 平台工程

## OSS vs Paid

| OSS | Paid (Pro wedge) |
|-----|------------------|
| CLI cost report from spans JSON (+ HTML table + pure-SVG byModel chart + **UTC daily rollup** + **finance CSV** + **Markdown cost report** + **GHA `::error` annotations** + **tenant attribution**) | Anomaly alerts, chargeback |
| **Local report server** (`serve --port 8792`, stdlib `http`: `GET /health`, `GET /ready`, `GET /` HTML+SVG, `GET /report.json`, **`GET /v1/costs.csv`**, **`GET /v1/costs.md`**, **`GET /v1/costs.gha.txt`**, `GET /v1/costs?format=csv|json|md|gha`, **`GET /v1/budgets`**, **`GET /v1/models`**, **`GET /v1/config`**, **`GET /v1/spans`**, **`GET /v1/tenants`**, `GET /openapi.json`, `GET /metrics`, **`POST /v1/traces`** OTLP JSON ingest; optional `--cors-origins` / `OTEL_AI_COST_CORS_ORIGINS`; HTTP rate-limit `--rate-limit` / `RATE_LIMIT_PER_MINUTE`; optional `--ingest-token` / `INGEST_TOKEN`; in-memory span cap `--span-max` / `SPAN_MAX` default 50000; `X-Request-Id` echo; optional `--watch` mtime poll reload) | **Hosted dashboard = paid later** |
| OpenAPI 3 (`openapi/cost.openapi.json`, `GET /openapi.json`; `X-Request-Id`) + Prometheus `GET /metrics` + A dogfood SDK stubs | Hosted cost APIs / signed feeds |
| Local threshold checks (`--budget` / `check-budget`, exit 1 on breach) + **per-tenant budget** (`--tenant-budget`) + **budget-breach webhook** (fire-and-forget, **1 retry** on 5xx/timeout; tenant breaches include `tenant`) + **simple HMAC-SHA256** (`--webhook-secret` / `OTEL_AI_COST_WEBHOOK_SECRET`) | Alerting dashboards, **webhook exponential backoff / queues / key rotation / timestamp replay** (paid later) |
| Manual sample/redact flags | Policy packs (redact attrs + prefix sample rates) |
| route multi-sink sketch (kept/dropped files) | Multi-sink exporters, SSO, multi-tenant |

**OSS one-liner:** estimate token $ from OTel spans (table/HTML + local `serve` report) + local budget thresholds + per-tenant budget + fire-and-forget breach webhook + simple HMAC + 1 retry.  
**Paid one-liner:** hosted dashboard + alerting; webhook exponential backoff / queues / key rotation / timestamp replay; policy-driven redact/sample + multi-sink routing.

## 2-week MVP checklist / 2周MVP清单

- [x] Parse OTel span attrs for model + tokens
- [x] Configurable price table
- [x] otel-ai-cost report spans.json
- [x] stdout table or static HTML (pure-SVG byModel bar chart, no CDN)
- [x] Policy pack policies/redact-basic.json for filter
- [x] route multi-sink (stdout / file / drop-file)
- [x] Local budget thresholds (`policies/budget.json`, `--budget` / `check-budget`)
- [x] Budget-breach webhook (`report --budget … --webhook-url` / `OTEL_AI_COST_WEBHOOK_URL`; POST `{ok:false,breaches,totalUsd}` on breach only; OSS 1 retry on 5xx/timeout; exponential backoff / queues / key rotation / timestamp replay = paid later)
- [x] Budget-breach webhook HMAC (`--webhook-secret` / `OTEL_AI_COST_WEBHOOK_SECRET` → `X-Webhook-Signature: sha256=<hex>` HMAC-SHA256 of raw body; mock receiver optional `--secret` verify; simple HMAC OSS; key rotation / timestamp replay = paid later)
- [x] Budget-breach webhook timestamp (`X-Webhook-Timestamp: <unix-seconds>` on every POST; HMAC still body-only; replay window enforcement = paid later)
- [x] Daily cost rollup (`report --group-by day`, `--out` JSON, HTML by-day section)
- [x] Finance CSV export (`report --format csv`; `GET /v1/costs.csv` / `GET /v1/costs?format=csv`; columns `date,model,spanCount,usd,tenant` from UTC daily-by-model+tenant totals; `tenant` last)
- [x] Markdown cost report (`report --format md`; `GET /v1/costs.md` / `GET /v1/costs?format=md`; `text/markdown`; `# otel-ai-cost` + **totalUsd** / **spans** + by-model / by-tenant tables; `|` escaped; empty → heading + zeros 200; Slack / email / `$GITHUB_STEP_SUMMARY`)
- [x] GitHub Actions workflow-command annotations (`report --format gha`; `GET /v1/costs.gha.txt` / `GET /v1/costs?format=gha`; `text/plain`; global `::error title=budget`; tenant `::error title=tenant/<id>`; no breach → empty)
- [x] Tenant cost attribution (span attr `tenant`; JSON `byTenant[{tenant,usd,spanCount,byModel}]`; missing/empty → `_`)
- [x] Per-tenant budget (`--tenant-budget acme=10,other=5` / env `OTEL_AI_COST_TENANT_BUDGETS` alias `TENANT_BUDGETS=acme:10`; JSON `budgetBreaches[{tenant,usd,budget}]`; `_` not gated unless set; global `--budget` independent; webhook includes `tenant`)
- [x] `GET /v1/budgets` configured thresholds (not spend): `{ok:true, globalUsd: number|null, tenants:{acme:10,…}}`; missing → `null` / `{}`; no secrets; CORS + `X-Request-Id`
- [x] `GET /v1/models` pricing catalog (rates, not spend): `{ok:true, models:[{id, inputPerMTok, outputPerMTok, …}], defaultModel, pack}`; built-in table; no secrets; CORS + `X-Request-Id`
- [x] `GET /v1/config` redacted runtime config (knobs, not spend): `{ok, spanCap, spansMax, rateLimit.perMinute, cors.origins, pack, hasGlobalBudget, tenantBudgetCount, webhooks.hasUrl/hasSecret}`; never URL/secret/tokens/price table; CORS + `X-Request-Id`
- [x] `GET /v1/spans` recent span summaries (FinOps debug): `{ok, count, spans:[{id, model, tenant, inputTokens, outputTokens, usd, ts}]}`; no prompts/completions/API keys/Authorization; cap 100 newest + `truncated`; `count` = full retained size; empty 200; CORS + `X-Request-Id`; OpenAPI `listSpans`
- [x] `GET /v1/tenants` per-tenant spend rollup: `{ok, count, tenants:[{id, spanCount, usd}]}`; missing tenant → `_`; optional `budgetUsd` when configured; cap 100 + `truncated`; empty 200; CORS + `X-Request-Id`; OpenAPI `listTenants`
- [x] Local report server (`serve --port 8792 --in spans.json`, optional `--group-by day`; hosted dashboard = paid later)
- [x] OTLP JSON ingest (`POST /v1/traces` / alias `/v1/otlp/v1/traces`; merge into in-memory store; optional `INGEST_TOKEN`; JSON only, no protobuf)
- [x] In-memory span cap (`--span-max` / `SPAN_MAX` default 50000; `0` = unlimited; drop oldest; watch reload replaces store then caps)
- [x] Serve `--watch` (poll `--in` spans mtime ~200ms; reload snapshot for `/` `/report.json` `/v1/costs.csv` `/v1/costs.md` `/metrics` `/health`; local-mvp isolated temp-copy prove)
- [x] `GET /ready` 200 `{ok:true, service}` + same snapshot as `/health` when healthy; 503 `shutting_down` on SIGTERM/SIGINT (Compose stays on `/health`)
- [x] Serve CORS (`--cors-origins` CSV / `OTEL_AI_COST_CORS_ORIGINS`; default deny; OPTIONS 204/403 `cors_denied`; GET ACAO; allow/expose `Retry-After` + `X-Request-Id`)
- [x] HTTP rate limit (`--rate-limit` / `RATE_LIMIT_PER_MINUTE` default 120; IP sliding window; 429 + `Retry-After`; skip `/health` `/ready` `/metrics`)
- [x] `X-Request-Id` (incoming or generated UUID; echo every response incl 4xx/OPTIONS)
- [x] OpenAPI 3 (`openapi/cost.openapi.json` + `GET /openapi.json`; `/ready` `getReady`; 403 CORS notes; `X-Request-Id`)
- [x] Prometheus `GET /metrics` (`otel_ai_cost_total_usd`, `otel_ai_cost_by_model_usd{model}`, `otel_ai_cost_by_tenant_usd{tenant}`, `otel_ai_cost_budget_remaining_usd{tenant}`, `otel_ai_cost_budget_deny_total`, `otel_ai_cost_input_tokens`, `otel_ai_cost_output_tokens`, `otel_ai_cost_span_count`; CORS same as other GET)
- [x] Dedicated Grafana dashboard `deploy/grafana/e-otel-ai-cost.json` (shared `oss-cash-lab.json` E panels unchanged)
- [x] Local OTLP demo `scripts/otlp-demo.sh` (no Docker; wired from local-mvp)
- [x] Demo with sample spans

## Quick start

See scripts/local-mvp.sh for the full demo commands (smoke, report, budget tight/loose, filter with policy pack, route multi-sink, otlp-demo). Attributes and positioning: docs/otel-cost.md.

```bash
# cost report + local thresholds (OSS); OSS 1 retry; exponential backoff / queues / key rotation / timestamp replay = paid later
node src/cli.js report --in examples/spans.json --budget policies/budget.json   # exit 1 if breached
node src/cli.js report --in examples/spans.json --tenant-budget acme=10,other=5
node src/cli.js report --in examples/spans.json --budget policies/budget.json \
  --webhook-url http://127.0.0.1:8815/hook   # fire-and-forget POST on breach only
# or: OTEL_AI_COST_WEBHOOK_URL=http://127.0.0.1:8815/hook
# optional HMAC (OSS): --webhook-secret whsec_local_mvp  or  OTEL_AI_COST_WEBHOOK_SECRET
#   → X-Webhook-Signature: sha256=<hex> of the raw JSON body
node src/cli.js check-budget --in examples/spans.json --budget policies/budget-loose.json

# UTC daily cost rollup (stdout table + structured JSON + HTML day section)
node src/cli.js report --in examples/spans.json --group-by day
node src/cli.js report --in examples/spans.json --group-by day --out out/daily.json --html out/daily.html

# finance CSV (Sheets-friendly; same daily-by-model+tenant totals; default table/JSON/HTML unchanged)
node src/cli.js report --in examples/spans.json --format csv --out out/costs.csv

# FinOps Markdown (Slack / email / GitHub Actions $GITHUB_STEP_SUMMARY)
node src/cli.js report --in examples/spans.json --format md --out out/costs.md

# GitHub Actions log annotations (budget / tenant-budget breaches)
node src/cli.js report --in examples/spans.json --tenant-budget acme=0.0001 --format gha

# local report server (OSS; hosted dashboard = paid later)
node src/cli.js serve --port 8792 --in examples/spans.json
# --host defaults to 127.0.0.1; Compose / Docker uses --host 0.0.0.0
# optional: --group-by day (default for serve)
# optional per-tenant budget: --tenant-budget acme=10,other=5  or  OTEL_AI_COST_TENANT_BUDGETS / TENANT_BUDGETS
#   JSON budgetBreaches[{tenant,usd,budget}]; `_` not gated unless `_` is set; missing → [] / no extra webhook
# optional: --watch  poll --in spans mtime (~200ms) and reload snapshot (/, /report.json, /v1/costs.csv, /v1/costs.md, /v1/costs.gha.txt, /metrics, /health)
# optional ingest token: --ingest-token TOKEN  or  INGEST_TOKEN (default off; when set, POST /v1/traces requires Authorization: Bearer)
# optional in-memory span cap: --span-max 50000  or  SPAN_MAX (default 50000; 0 = unlimited; over cap drop oldest)
# optional CORS: --cors-origins http://localhost:3000  or  OTEL_AI_COST_CORS_ORIGINS
#   empty/omit = deny extra CORS (no ACAO; OPTIONS 404)
#   explicit list: OPTIONS allowed Origin → 204 + ACAO; unlisted (e.g. http://evil.example) → 403 cors_denied
#   matching GET includes Access-Control-Allow-Origin (`*` allowed)
#   default allow/expose headers include Retry-After + X-Request-Id
# optional HTTP rate limit: --rate-limit 120  or  RATE_LIMIT_PER_MINUTE / RATE_LIMIT_RPM (default 120; 0 = unlimited)
#   per client IP (X-Forwarded-For first hop); exceed → 429 {ok:false, reason:rate_limited} + Retry-After
#   /health /ready /metrics are not limited
# optional: curl -H 'X-Request-Id: my-id' (echoed on every response)
# optional JSON access logs: --log-json or LOG_FORMAT=json (default off; skips /health /ready /metrics)
# GET /health          JSON {ok,totalUsd,…}
# GET /ready           always 200 {ok:true, service} + same snapshot as /health
# GET /                HTML report (SVG chart + UTC daily)
# GET /report.json     structured JSON including totalUsd + byTenant + budgetBreaches
# GET /v1/costs.csv    finance CSV (date,model,spanCount,usd,tenant + TOTAL; empty → header only)
# GET /v1/costs.md     FinOps Markdown (# otel-ai-cost + by-model / by-tenant tables; empty → heading + zeros)
# GET /v1/costs.gha.txt GitHub Actions ::error (empty when no budget breach)
# GET /v1/costs        ?format=csv|json|md|gha (json default = same as /report.json)
# GET /v1/budgets      configured thresholds {ok, globalUsd, tenants} (not spend; missing → null / {})
# GET /v1/models       pricing catalog {ok, models[{id, inputPerMTok, outputPerMTok}], defaultModel, pack} (rates, not spend)
# GET /v1/config       redacted knobs {ok, spanCap, cors, rateLimit, pack, hasGlobalBudget, tenantBudgetCount, webhooks.hasUrl/hasSecret} (never secrets)
# GET /v1/spans        recent summaries {ok, count, spans:[{id, model, tenant, inputTokens, outputTokens, usd, ts}]} (no prompts/secrets; cap 100 newest)
# GET /v1/tenants      per-tenant spend {ok, count, tenants:[{id, spanCount, usd}]} (missing → `_`; optional budgetUsd; cap 100)
# GET /openapi.json    file-backed OpenAPI 3 (openapi/cost.openapi.json)
# GET /metrics         Prometheus text (total / by-model / by-tenant / budget remaining / deny / tokens / span-count)
# POST /v1/traces      OTLP JSON ingest (also POST /v1/otlp/v1/traces); merge into snapshot; default no auth
# portfolio stack: make stack-demo (port 8792; default deny CORS so curls unchanged)
```

Example spans in `examples/spans.json` include `timestamp` / `startTimeUnixNano` so costs roll up by **UTC calendar day**. One fixture span sets span attribute **`tenant=acme`**.

**Tenant attribution:** read span attribute `tenant` (also `span.tenant`). Missing, null, or whitespace → `"_"` (documented sentinel, not empty string). JSON reports include `byTenant: [{ tenant, usd, spanCount, byModel }]`. `byDay` / `byModel` totals are unchanged. Finance CSV appends column `tenant` at the **end** (`date,model,spanCount,usd,tenant`) so existing header greps still pass; grain is date+model+tenant. HTML lists tenant totals after the byModel chart.

**Per-tenant budget (OSS):** `--tenant-budget acme=10,other=5` (CSV `tenant=usd`, also `tenant:usd`) or env **`OTEL_AI_COST_TENANT_BUDGETS`** (alias **`TENANT_BUDGETS`**). JSON object / `.json` file path also accepted. CLI wins over env (empty disables). Default **none**. After `byTenant` aggregation, if a configured tenant's `usd` **>** budget, the report includes `budgetBreaches: [{ tenant, usd, budget }]`. Catch-all `"_"` is **not** gated unless you set a budget for `_`. Global `--budget` (`maxTotalUsd` / `maxPerModelUsd`) still works independently. HTTP JSON (`GET /report.json`, `GET /v1/costs`) always includes `budgetBreaches` (empty array when unset). **`GET /v1/budgets`** returns **configured thresholds** (not spend): `{ok:true, globalUsd: number|null, tenants:{acme:10,…}}` (`globalUsd` = `--budget` `maxTotalUsd`; `tenants` = `--tenant-budget` map). Missing config → `globalUsd: null` and `tenants: {}`. No secrets. CORS + `X-Request-Id`. Missing tenant budgets → no extra webhook; never 500.

**Runtime config (OSS):** **`GET /v1/config`** is a public redacted snapshot of serve **knobs** (not spend): `{ok, spanCap, spansMax, rateLimit:{perMinute}, cors:{origins}, pack, hasGlobalBudget, tenantBudgetCount, webhooks:{hasUrl,hasSecret}}`. **Never** webhook URL (query tokens), webhook secret, ingest token, API keys, or the price table (that is `GET /v1/models`). Dollar thresholds stay on `GET /v1/budgets`. CORS + `X-Request-Id`.

**Span summaries (OSS):** **`GET /v1/spans`** lists recent ingested / file-loaded spans as FinOps debug rows `{ok:true, count, spans:[{id, model, tenant, inputTokens, outputTokens, usd, ts}]}`. Field names match `spanCost` / OTel attrs (`gen_ai.request.model`, `tenant`, token usage, `spanId`/`id`, `timestamp`). **Never** prompt/completion/input/output text, API keys, or Authorization (allowlist only — planted `SECRET_PROMPT` must not appear). Newest first. Cap **100**; `count` is the full retained ring size; `truncated: true` when more. Empty store → **200** `{ok:true, count:0, spans:[]}`. CORS + `X-Request-Id`.

**Tenant inventory (OSS):** **`GET /v1/tenants`** rolls up the current in-memory store as `{ok:true, count, tenants:[{id, spanCount, usd}]}` (same window as `/v1/spans` / costs). Missing/empty tenant → `_`. Sort highest `usd` first, then id. Cap **100**; `count` is the full tenant count; `truncated: true` when more. Optional `budgetUsd` only when that tenant has a configured budget (`GET /v1/budgets`.tenants). Optional `?tenant=` exact filter. **Never** prompts, completions, API keys, Authorization, or the price catalog. Empty → **200** `{ok:true, count:0, tenants:[]}`. CORS + `X-Request-Id`.

**Pricing catalog (OSS):** **`GET /v1/models`** returns **configured rates** (not spend): `{ok:true, models:[{id, inputPerMTok, outputPerMTok, …}], defaultModel:null, pack:null}` from the loaded price table (built-in `DEFAULT_PRICES`: `gpt-4o`, `gpt-4o-mini`, `claude-sonnet`). Field names match the table — do not invent rates. A single `usdPer1k` is used when that is all an entry has. Cached rates only when present. Empty/default still **200** with the built-in table. No secrets. CORS + `X-Request-Id`. Optional CLI `otel-ai-cost models` (alias `prices`) prints the same JSON. When a tenant breaches and `--webhook-url` is set, the existing budget webhook fires (one payload with the breach array) with **`tenant` in the JSON body**; HMAC still signs the raw body; **no tokens**.

Finance CSV reuses those daily-by-model+tenant totals (no second price table): columns `date` (from `day`), `model`, `spanCount`, `usd`, `tenant`. CLI default remains the stdout table (`--html` / `--out` JSON unchanged). `--format csv` writes a file via `--out`. HTTP `Content-Type: text/csv`; CORS + `X-Request-Id` apply; the path is access-logged (not skipped like `/metrics`). Empty spans → header-only **200**.

**Markdown cost report (OSS):** `report --format md` prints GitHub-flavored Markdown for Slack / email / GitHub Actions `$GITHUB_STEP_SUMMARY` (`# otel-ai-cost` + **totalUsd** / **spans** + `| model | usd | spans |` and `| tenant | usd | spans |`). HTTP: `GET /v1/costs.md` and `GET /v1/costs?format=md` (`text/markdown; charset=utf-8`). `|` in model/tenant cells is escaped. Empty spans → heading + zeros, **200**. Same `byModel` / `byTenant` totals as JSON. CSV / JSON / HTML unchanged.

**GitHub Actions annotations (OSS):** `report --format gha` (alias `--format annotations`) prints workflow commands so budget breaches show up in GHA logs. Global `--budget` maxTotalUsd → `::error title=budget::totalUsd X > budget Y`. Each `--tenant-budget` breach → `::error title=tenant/<id>::usd X > budget Y`. No breach → empty stdout (no `::error`). HTTP: `GET /v1/costs.gha.txt` and `GET /v1/costs?format=gha` (`text/plain; charset=utf-8`; empty body **200**). `%` / CR / LF / `:` / `,` escaped like C/D `to_gha`. Does **not** require GitHub. CSV / JSON / HTML / Markdown / OTLP / span-max unchanged.

**Copy-paste workflow:** portfolio [`examples/github-actions/otel-ai-cost-gha.yml`](../../examples/github-actions/otel-ai-cost-gha.yml) → consumer `.github/workflows/`. Green path: `node src/cli.js report --in examples/spans.json --format gha` (empty stdout / exit 0 when no `--budget`). Optional Markdown `$GITHUB_STEP_SUMMARY` + `upload-artifact` `costs.md`. Tight `--budget policies/budget.json` prints `::error title=budget::` and exits 1; `--tenant-budget acme=0.0001` prints `::error title=tenant/acme::` (exit 0). Optional composite: [`examples/github-actions/otel-ai-cost-gha/action.yml`](../../examples/github-actions/otel-ai-cost-gha/action.yml). See [`examples/github-actions/README.md`](../../examples/github-actions/README.md). Not a required workflow on this repo.

## Local HTTP serve / 本地成本报告服务

`otel-ai-cost serve --port 8792 --in examples/spans.json` computes a snapshot at start (stdlib `http`) and serves (optional `--watch` reloads that snapshot when `--in` mtime changes):

| Path | Body |
|------|------|
| `GET /health` | `{ok, service: otel-ai-cost, version, groupBy, spanCount, totalUsd}` |
| `GET /ready` | Always **200** `{ok:true, service}` plus the same snapshot fields as `/health` (no circuit/queue). Compose/stack-demo healthchecks stay on `/health`. |
| `GET /` | Self-contained HTML + SVG chart (+ UTC daily when `--group-by day`) |
| `GET /report.json` | Structured JSON including `totalUsd` + `byTenant` + `budgetBreaches` (daily rollup by default; empty breaches when no `--tenant-budget`) |
| `GET /v1/costs.csv` | Finance CSV (`text/csv`): header `date,model,spanCount,usd,tenant` (`tenant` last) from UTC daily-by-model+tenant totals + TOTAL row; missing tenant → `_`; empty spans → header only (200) |
| `GET /v1/costs.md` | FinOps Markdown (`text/markdown; charset=utf-8`): `# otel-ai-cost` + **totalUsd** / **spans** + by-model / by-tenant tables; `|` escaped; empty → heading + zeros (200) |
| `GET /v1/costs.gha.txt` | GitHub Actions workflow commands (`text/plain`): global `::error title=budget::totalUsd X > budget Y`; tenant `::error title=tenant/<id>::usd X > budget Y`; no breach → empty 200 |
| `GET /v1/costs` | Same snapshot including `byTenant`; `?format=csv` → CSV, `?format=md` → Markdown, `?format=gha` → annotations (alias `annotations`), `?format=json` or omit → JSON (same as `/report.json`); unknown format → 400 `bad_format` |
| `GET /v1/budgets` | Configured thresholds **not spend**: `{ok:true, globalUsd: number|null, tenants:{acme:10,…}}`. `globalUsd` = `--budget` `maxTotalUsd` (missing → `null`). `tenants` = `--tenant-budget` map (missing → `{}`). No secrets. CORS + `X-Request-Id`. |
| `GET /v1/models` | Pricing catalog **rates not spend**: `{ok:true, models:[{id, inputPerMTok, outputPerMTok, …}], defaultModel:null, pack:null}` from the loaded price table (built-in `DEFAULT_PRICES`). Field names match the table. No secrets. CORS + `X-Request-Id`. Optional CLI `models` / `prices`. |
| `GET /v1/config` | Redacted runtime **knobs** (not spend): `{ok, spanCap, spansMax, rateLimit:{perMinute}, cors:{origins}, pack, hasGlobalBudget, tenantBudgetCount, webhooks:{hasUrl,hasSecret}}`. **Never** webhook URL/secret, ingest token, API keys, or price table. CORS + `X-Request-Id`. |
| `GET /v1/spans` | Recent ingested/file-loaded span **summaries**: `{ok:true, count, spans:[{id, model, tenant, inputTokens, outputTokens, usd, ts}]}`. Allowlist only — **never** prompt/completion/input/output text, API keys, or Authorization. Newest first. Cap **100**; `count` is the full retained ring size; `truncated: true` when more. Empty → **200** `{ok:true, count:0, spans:[]}`. CORS + `X-Request-Id`. |
| `GET /v1/tenants` | Per-tenant **spend** rollup: `{ok:true, count, tenants:[{id, spanCount, usd}]}`. Missing/empty → `_`. Sort highest usd first, then id. Cap **100**; `count` is the full tenant count; `truncated: true` when more. Optional `budgetUsd` when a tenant budget is configured. Optional `?tenant=`. Empty → **200** `{ok:true, count:0, tenants:[]}`. Never prompts/secrets. CORS + `X-Request-Id`. |
| `GET /openapi.json` | File-backed OpenAPI 3 (`openapi/cost.openapi.json`) |
| `GET /metrics` | Prometheus text: gauges `otel_ai_cost_total_usd`, `otel_ai_cost_by_model_usd{model}`, `otel_ai_cost_by_tenant_usd{tenant}`, `otel_ai_cost_budget_remaining_usd{tenant}`, `otel_ai_cost_input_tokens`, `otel_ai_cost_output_tokens`; counters `otel_ai_cost_span_count`, `otel_ai_cost_budget_deny_total` |
| `POST /v1/traces` | OTLP JSON ingest (alias `POST /v1/otlp/v1/traces`). Simplified `resourceSpans[].scopeSpans[].spans[]` or flat `{spans:[]}`. **200** `{ok:true, accepted}` (`accepted` = parsed count, not how many fit the cap). Bad JSON **400**. Empty **200** `accepted:0`. Optional Bearer when `--ingest-token` / `INGEST_TOKEN` set (**401** otherwise). Body > 1 MiB **413**. Rate-limited. Over `--span-max` drop oldest. |

`GET /openapi.json` serves the file-backed OpenAPI 3 document ([`openapi/cost.openapi.json`](./openapi/cost.openapi.json)): `/health`, **`/ready`** (`getReady`), `/`, `/report.json`, **`/v1/costs.csv`** (`getCostsCsv`), **`/v1/costs.md`** (`getCostsMd`), **`/v1/costs.gha.txt`** (`getCostsGha`), **`/v1/costs`** (`getCosts`, `?format=`), **`/v1/budgets`** (`getBudgets`), **`/v1/models`** (`getModels`), **`/v1/config`** (`getConfig`; redacted knobs; no secrets), **`/v1/spans`** (`listSpans`; allowlist summaries; no prompts/secrets; cap 100 newest), **`/v1/tenants`** (`listTenants`; `{id, spanCount, usd}`), `/metrics`, **`POST /v1/traces`** (`postTraces`), plus `X-Request-Id` and **403** CORS notes. Portfolio dogfood: `make dogfood-a-e` (A generates TS/Python/Go clients under `sdk/generated/`, gitignored).

`--host` defaults to `127.0.0.1` (Compose uses `0.0.0.0`). Optional CORS: `--cors-origins` CSV or env `OTEL_AI_COST_CORS_ORIGINS` (`*` allowed). Empty/omit = **deny extra CORS** (no ACAO; OPTIONS 404). Explicit list: allowed Origin OPTIONS → **204** + ACAO; unlisted (e.g. `http://evil.example`) → **403** `cors_denied`. Matching GET/POST includes `Access-Control-Allow-Origin`. Default allow methods include **POST**; allow headers include **Authorization** (ingest Bearer). Default allow/expose headers include **`Retry-After`** and **`X-Request-Id`** (GET/POST/OPTIONS ACEH). local-mvp isolated prove uses `http://localhost:3000`; main serve / stack-demo default deny.

### HTTP rate limit

`serve --rate-limit N` or env **`RATE_LIMIT_PER_MINUTE`** (alias **`RATE_LIMIT_RPM`**). Default **120**/min per client IP (`X-Forwarded-For` first hop, else socket). In-memory sliding window (stdlib). Exceed → **429** `{ok:false, reason:"rate_limited"}` + header **`Retry-After`**. **`GET /health`**, **`GET /ready`**, **`GET /metrics`** are not limited (k8s probes / Prometheus). `0` disables. CLI flag wins over env. local-mvp isolated prove uses `--rate-limit 2` (third `/report.json` is 429; `/health` stays 200). Main serve / stack-demo keep the generous default so curls never 429.

Optional **`--watch`**: poll the `--in` spans file mtime every **200ms** and reload the snapshot used by `GET /`, `GET /report.json`, `GET /v1/costs.csv`, `GET /v1/costs.md`, `GET /v1/costs.gha.txt`, `GET /v1/spans`, `GET /metrics`, `GET /health` (and `GET /ready`). `GET /openapi.json` stays file-backed (not rebuilt from spans). Parse errors keep the previous snapshot. Main serve / stack-demo omit `--watch` (one-shot snapshot). local-mvp isolated prove: temp copy → curl `totalUsd` → append a span → wait for `regenerated` → higher `totalUsd` / `spanCount` → kill (must not hang). File reload **replaces the in-memory store** (then caps); previously ingested spans are not kept.

### OTLP JSON ingest (live FinOps)

`POST /v1/traces` (alias `POST /v1/otlp/v1/traces`) accepts **JSON only** (no protobuf): a simplified OTLP `ExportTraceServiceRequest` (`resourceSpans[].scopeSpans[].spans[]`) or E's existing flat `spans` array / `{spans:[]}`. Span/resource attributes may be a map or OTLP `{key,value:{stringValue|intValue}}` list. `gen_ai.request.model` / `tenant` / token usage are the same fields `cost.js` already reads. Merges into the in-memory store so the next `/v1/costs` / HTML / CSV / Markdown / GHA annotations / metrics include them. File `--watch` reload **replaces** that store (then caps).

**In-memory cap:** default **50000** spans (`--span-max` / env **`SPAN_MAX`**). Over cap, drop oldest. Costs / CSV / HTML / Markdown / metrics recompute from the retained window. `0` = unlimited (**dangerous**, process can grow forever). Ingest still **200**; `accepted` is how many spans were parsed, not how many fit. CLI flag wins over env. Default is generous so stack-demo / main demo (6 example spans) never drop. Isolated local-mvp `--span-max 2` POSTs 3 tiny spans then `GET /v1/costs` `spanCount=2` (oldest gone).

Auth: **none by default** (local). Optional `--ingest-token` or env **`INGEST_TOKEN`**: when set, require `Authorization: Bearer`; missing/wrong → **401** `{error:"unauthorized"}` (token never echoed). Default off so stack-demo / main serve never 401. Bad JSON → **400** `{error:"bad_json"}`. Empty spans → **200** `{ok:true, accepted:0}`. Body over **1048576** bytes → **413** `{error:"payload_too_large"}` before JSON parse (Content-Length early or stream count, same cap as B). Ingest **is** rate-limited like other app routes (`/health` `/ready` `/metrics` still skipped). Prove on an **isolated port** so the demo file store is not polluted.

```bash
# unsigned (default): collector can POST traces
curl -s -X POST http://127.0.0.1:8792/v1/traces \
  -H 'Content-Type: application/json' \
  -d '{"resourceSpans":[{"scopeSpans":[{"spans":[{"attributes":[{"key":"gen_ai.request.model","value":{"stringValue":"gpt-4o"}},{"key":"tenant","value":{"stringValue":"acme"}}]}]}]}]}'
# optional: serve --ingest-token secret   then  -H 'Authorization: Bearer secret'
```

### X-Request-Id

Optional correlation header. Echoed on **every** response (including 4xx / OPTIONS). If omitted/empty, the server generates a UUID (max 128 chars; CR/LF stripped). CORS allow/expose includes `X-Request-Id`. local-mvp sends a custom id on `/health` and `/openapi.json` and asserts the response header.

```bash
curl -sD - http://127.0.0.1:8792/health -H 'X-Request-Id: mvp-health-rid-e1'
# → X-Request-Id: mvp-health-rid-e1
```

**Hosted dashboard = paid later**; this local serve is OSS.

Container (k8s placeholder; images not published; skip if no Docker): `docker build -t ghcr.io/wozqhl/e-otel-ai-cost:dev bets/e-otel-ai-cost` (`node:20-alpine`, EXPOSE **8792**, `node src/cli.js serve --host 0.0.0.0`).

### Budget-breach webhook (OSS)

`report --budget … --webhook-url URL` or env `OTEL_AI_COST_WEBHOOK_URL`. When thresholds are exceeded, fire-and-forget POST JSON `{ok:false, breaches, totalUsd}` (short timeout ~750ms; webhook errors **never change** the exit code — still **exit 1** on breach). **Per-tenant breaches** reuse this helper: body includes `tenant` (and `breaches[].tenant`); HMAC still signs the raw body; **do not send tokens**. Missing tenant budgets → no extra webhook. Global `--budget` POST is unchanged (3 keys when no `tenant`). **Do not POST on pass.** Empty/omit = disabled. CLI `--webhook-url` wins over env (including empty to disable). Optional **HMAC (OSS):** `--webhook-secret` or env `OTEL_AI_COST_WEBHOOK_SECRET`. When set, POST includes `X-Webhook-Signature: sha256=<hex>` — HMAC-SHA256 of the **raw JSON body**. Omit / empty secret → unsigned (existing prove). **Every** outbound POST also sends `X-Webhook-Timestamp: <unix-seconds>` (HMAC still body-only). On **5xx** or **network/timeout**, retry the POST **once** after ~50ms (success on first try = no retry; **4xx do not retry**). Simple HMAC + **1 retry** is OSS. local-mvp mock receiver (`mock-webhook-receiver.js`) writes the last body (optional `--secret` verifies HMAC; `--headers-out` persists signature + timestamp); unsigned prove stays and asserts timestamp present/roughly now; isolated signed receiver asserts header + HMAC (body) + timestamp. Smoke unit-tests 200/4xx = no retry and 5xx/network = one retry. **Exponential backoff / queues, key rotation / timestamp replay window enforcement = paid later**.

### Tenant / budget Prometheus + Grafana

`GET /metrics` also exposes per-tenant spend, budget remaining, a budget-deny counter, and token totals. Names follow the existing `otel_ai_cost_*` prefix. Remaining may be negative when over budget.

Once a tenant is already over `--tenant-budget`, further ingest for that tenant is not stored; the JSON includes `denied` (HTTP 200; `accepted` stays parsed count).

Dedicated dashboard (importable, no live Grafana): [`deploy/grafana/e-otel-ai-cost.json`](../../deploy/grafana/e-otel-ai-cost.json). Shared `oss-cash-lab.json` already has E Total USD / Cost by model; this stream does not edit it.

Local OTLP demo (no Docker): `scripts/otlp-demo.sh`.

### Positioning vs Helicone / Langfuse

Honest, no fake stats: Helicone went maintenance after the Mintlify acquisition (Mar 2026). Langfuse was acquired by ClickHouse (Jan 2026). OpenTelemetry graduated CNCF (May 2026).

This tool is an OTel-native tenant spend + budget deny plane, not a hosted LLM observability SaaS. See [docs/otel-cost.md](./docs/otel-cost.md). Collector contrib draft (not filed): [docs/collector-contrib-issue.md](./docs/collector-contrib-issue.md).
