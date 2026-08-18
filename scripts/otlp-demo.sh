#!/usr/bin/env bash
# Local OTLP ingest demo (no Docker): start serve, POST fake GenAI/OTLP
# payloads, curl /v1/tenants /v1/spans /metrics. Used by local-mvp; also
# runnable alone: bash bets/e-otel-ai-cost/scripts/otlp-demo.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p out

PORT="${OTLP_DEMO_PORT:-8841}"
SPANS="$ROOT/out/otlp-demo-empty.json"
LOG="$ROOT/out/otlp-demo-serve.log"
rm -f "$LOG" out/otlp-demo-cheap.json out/otlp-demo-other.json out/otlp-demo-over.json out/otlp-demo-deny.json out/otlp-demo-tenants.json out/otlp-demo-spans-out.json out/otlp-demo-metrics.txt out/otlp-demo-*.h
printf "%s\n" "[]" > "$SPANS"

unset OTEL_AI_COST_CORS_ORIGINS || true
unset INGEST_TOKEN || true
unset RATE_LIMIT_PER_MINUTE RATE_LIMIT_RPM || true
unset OTEL_AI_COST_TENANT_BUDGETS TENANT_BUDGETS DENY_ON_WOULD_EXCEED || true

node src/cli.js serve --port "$PORT" --in "$SPANS" \
  --tenant-budget "acme=0.01,other=5" >"$LOG" 2>&1 &
PID=$!
cleanup() {
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "otlp-demo serve did not become healthy"
    cat "$LOG" || true
    exit 1
  fi
done

echo "==> [otlp-demo] POST cheap acme span (under budget)"
CHEAP="$(curl -s -o out/otlp-demo-cheap.json -D out/otlp-demo-cheap.h -w "%{http_code}" \
  -X POST "http://127.0.0.1:$PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: otlp-demo-cheap" \
  -d '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"otlp-demo"}}]},"scopeSpans":[{"spans":[{"name":"gen_ai.chat","timestamp":"2024-08-16T00:00:00.000Z","attributes":[{"key":"gen_ai.request.model","value":{"stringValue":"gpt-4o-mini"}},{"key":"gen_ai.usage.input_tokens","value":{"intValue":"800"}},{"key":"gen_ai.usage.output_tokens","value":{"intValue":"200"}},{"key":"tenant","value":{"stringValue":"acme"}}]}]}]}]}')"
echo "cheap_status=$CHEAP body=$(cat out/otlp-demo-cheap.json)"
test "$CHEAP" = "200"
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' out/otlp-demo-cheap.json
grep -Eq '"accepted"[[:space:]]*:[[:space:]]*1' out/otlp-demo-cheap.json
grep -Eq '"denied"[[:space:]]*:[[:space:]]*0' out/otlp-demo-cheap.json

echo "==> [otlp-demo] POST other-tenant + expensive acme (would exceed 0.01 → deny, spend unchanged)"
OTHER="$(curl -s -o out/otlp-demo-other.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{"spans":[{"timestamp":"2024-08-16T01:00:00.000Z","attributes":{"gen_ai.request.model":"claude-sonnet","gen_ai.usage.input_tokens":400,"gen_ai.usage.output_tokens":100,"tenant":"other"}}]}')"
test "$OTHER" = "200"

OVER="$(curl -s -o out/otlp-demo-over.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{"resourceSpans":[{"scopeSpans":[{"spans":[{"name":"gen_ai.chat","timestamp":"2024-08-16T02:00:00.000Z","attributes":[{"key":"gen_ai.request.model","value":{"stringValue":"gpt-4o"}},{"key":"gen_ai.usage.input_tokens","value":{"intValue":"2000"}},{"key":"gen_ai.usage.output_tokens","value":{"intValue":"800"}},{"key":"tenant","value":{"stringValue":"acme"}}]}]}]}]}')"
echo "over_status=$OVER body=$(cat out/otlp-demo-over.json)"
test "$OVER" = "200"
grep -Eq '"accepted"[[:space:]]*:[[:space:]]*1' out/otlp-demo-over.json
grep -Eq '"denied"[[:space:]]*:[[:space:]]*1' out/otlp-demo-over.json

echo "==> [otlp-demo] POST another expensive acme span (would still exceed → deny)"
DENY="$(curl -s -o out/otlp-demo-deny.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{"spans":[{"timestamp":"2024-08-16T03:00:00.000Z","attributes":{"gen_ai.request.model":"gpt-4o","gen_ai.usage.input_tokens":2000,"gen_ai.usage.output_tokens":800,"tenant":"acme"}}]}')"
echo "deny_status=$DENY body=$(cat out/otlp-demo-deny.json)"
test "$DENY" = "200"
grep -Eq '"denied"[[:space:]]*:[[:space:]]*1' out/otlp-demo-deny.json

echo "==> [otlp-demo] GET /v1/tenants"
TENANTS="$(curl -s -o out/otlp-demo-tenants.json -D out/otlp-demo-tenants.h -w "%{http_code}" \
  "http://127.0.0.1:$PORT/v1/tenants" -H "X-Request-Id: otlp-demo-tenants")"
echo "tenants_status=$TENANTS"
test "$TENANTS" = "200"
node -e '
const d=require("./out/otlp-demo-tenants.json");
if(d.ok!==true || !Array.isArray(d.tenants) || d.tenants.length<2) { console.error(d); process.exit(1); }
const acme=d.tenants.find((t)=>t.id==="acme");
const other=d.tenants.find((t)=>t.id==="other");
if(!acme || !(Number(acme.usd)>0) || !(Number(acme.usd)<0.01) || Number(acme.budgetUsd)!==0.01) { console.error("acme spend must stay under budget after would-exceed deny", acme); process.exit(1); }
if(!other || Number(other.budgetUsd)!==5) { console.error("other budget", other); process.exit(1); }
console.log("tenants_ok", {count:d.count, acmeUsd:acme.usd, otherUsd:other.usd});
'

echo "==> [otlp-demo] GET /v1/spans"
SPANS_CODE="$(curl -s -o out/otlp-demo-spans-out.json -w "%{http_code}" \
  "http://127.0.0.1:$PORT/v1/spans")"
test "$SPANS_CODE" = "200"
node -e '
const d=require("./out/otlp-demo-spans-out.json");
if(d.ok!==true || !Array.isArray(d.spans) || Number(d.count)<2) { console.error(d); process.exit(1); }
if(d.spans.some((x)=>x.model==="gpt-4o" && x.tenant==="acme")) { console.error("denied expensive acme span must not be stored", d); process.exit(1); }
const blob=JSON.stringify(d);
if(blob.includes("gen_ai.prompt") || blob.includes("SECRET")) { console.error("spans leaked", d); process.exit(1); }
console.log("spans_ok", {count:d.count, models:[...new Set(d.spans.map((s)=>s.model))]});
'

echo "==> [otlp-demo] GET /metrics"
curl -sf "http://127.0.0.1:$PORT/metrics" -o out/otlp-demo-metrics.txt
test -s out/otlp-demo-metrics.txt
grep -q "otel_ai_cost_total_usd" out/otlp-demo-metrics.txt
grep -q "otel_ai_cost_by_model_usd" out/otlp-demo-metrics.txt
grep -q "otel_ai_cost_by_tenant_usd" out/otlp-demo-metrics.txt
grep -q 'otel_ai_cost_by_tenant_usd{tenant="acme"}' out/otlp-demo-metrics.txt
grep -q "otel_ai_cost_budget_remaining_usd" out/otlp-demo-metrics.txt
grep -q "otel_ai_cost_budget_deny_total" out/otlp-demo-metrics.txt
grep -q 'otel_ai_cost_budget_deny_total{tenant="acme"}' out/otlp-demo-metrics.txt
grep -q "otel_ai_cost_input_tokens" out/otlp-demo-metrics.txt
grep -q "otel_ai_cost_output_tokens" out/otlp-demo-metrics.txt
grep -q "otel_ai_cost_span_count" out/otlp-demo-metrics.txt
echo "metrics_ok"

cleanup
PID=""
trap - EXIT
echo "otlp-demo OK (serve + OTLP POST + tenants/spans/metrics + budget deny)"
