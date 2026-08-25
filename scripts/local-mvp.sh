#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p out

node src/cli.js smoke

echo "==> report"
node src/cli.js report --in examples/spans.json | tee out/report.txt
grep -q TOTAL out/report.txt

echo "==> html report"
rm -f out/report.html
node src/cli.js report --in examples/spans.json --html out/report.html | tee out/report-html-meta.json
test -f out/report.html
grep -q '<table' out/report.html
grep -q 'TOTAL' out/report.html
grep -q 'gpt-4o' out/report.html
grep -q '<svg' out/report.html
# self-contained: inline style, no external script/link
if grep -Eiq '<script[^>]+src=|<link[^>]+href=' out/report.html; then
  echo "html should be self-contained"
  exit 1
fi

echo "==> filter (legacy flags)"
rm -f out/filtered.json
node src/cli.js filter --in examples/spans.json --out out/filtered.json --sample 0.5 --redact | tee out/filter-meta.json
test -f out/filtered.json
node -e 'const m=require("./out/filter-meta.json"); if(typeof m.reductionPct!=="number") process.exit(1); const f=require("./out/filtered.json"); if(!Array.isArray(f)||f.length===0) process.exit(1); const s=JSON.stringify(f); if(!s.includes("[REDACTED]") && s.includes("alice@")) process.exit(2); console.log("filter ok", m);'

echo "==> filter with policy pack"
rm -f out/filtered-policy.json
node src/cli.js filter --in examples/spans.json --out out/filtered-policy.json --policy policies/redact-basic.json --seed 7 | tee out/filter-policy-meta.json
test -f out/filtered-policy.json
node -e '
const m=require("./out/filter-policy-meta.json");
const f=require("./out/filtered-policy.json");
if(!m.policy || m.policy.name!=="redact-basic") { console.error(m); process.exit(1); }
if(m.sample!=="policy") { console.error("expected policy sample", m); process.exit(1); }
if(!Array.isArray(f) || f.length===0) process.exit(1);
const s=JSON.stringify(f);
if(s.includes("alice@") || s.includes("secret user")) { console.error("redact failed"); process.exit(2); }
if(!s.includes("[REDACTED]")) { console.error("missing REDACTED"); process.exit(2); }
console.log("policy filter ok", m);
'

echo "==> route multi-sink"
rm -f out/kept.json out/dropped.json
node src/cli.js route --in examples/spans.json --policy policies/redact-basic.json --seed 7 \
  --file out/kept.json --drop-file out/dropped.json | tee out/route-meta.json
test -f out/kept.json
test -f out/dropped.json
node -e '
const fs=require("fs");
const lines=fs.readFileSync("out/route-meta.json","utf8").trim().split(/\n/);
const meta=JSON.parse(lines[lines.length-1]);
if(!meta.route) { console.error(meta); process.exit(1); }
const r=meta.route;
const kept=require("./out/kept.json");
const dropped=require("./out/dropped.json");
if(!Array.isArray(kept) || !Array.isArray(dropped)) process.exit(1);
if(r.kept!==kept.length || r.dropped!==dropped.length) { console.error(r, kept.length, dropped.length); process.exit(1); }
if(r.before!==kept.length+dropped.length) process.exit(1);
if(r.kept+r.dropped!==r.before) process.exit(1);
if(r.kept===0) { console.error("expected some kept"); process.exit(1); }
console.log("route ok", {kept:r.kept, dropped:r.dropped, before:r.before});
'


echo "==> mock budget-breach webhook receiver"
WH_PORT="${WH_PORT:-8815}"
WH_OUT="$ROOT/out/webhook-last.json"
WH_HDR="$ROOT/out/webhook-last.headers.json"
WH_LOG="$ROOT/out/mock-webhook.log"
rm -f "$WH_OUT" "$WH_HDR" "$WH_LOG"
unset OTEL_AI_COST_WEBHOOK_URL || true
unset OTEL_AI_COST_WEBHOOK_SECRET || true
unset OTEL_AI_COST_TENANT_BUDGETS TENANT_BUDGETS || true
node mock-webhook-receiver.js --port "$WH_PORT" --out "$WH_OUT" --headers-out "$WH_HDR" >"$WH_LOG" 2>&1 &
WH_PID=$!
cleanup_wh() {
  if [ -n "${WH_PID:-}" ] && kill -0 "$WH_PID" 2>/dev/null; then
    kill "$WH_PID" 2>/dev/null || true
    wait "$WH_PID" 2>/dev/null || true
  fi
}
trap cleanup_wh EXIT
for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$WH_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 40 ]; then
    echo "mock webhook receiver did not become healthy"
    cat "$WH_LOG" || true
    exit 1
  fi
done

echo "==> budget tight (expect exit 1) + webhook POST"
rm -f out/budget-tight.txt "$WH_OUT"
set +e
node src/cli.js report --in examples/spans.json --budget policies/budget.json \
  --webhook-url "http://127.0.0.1:${WH_PORT}/hook" > out/budget-tight.txt 2>&1
ec=$?
set -e
if [ "$ec" -ne 1 ]; then
  echo "expected exit 1 for tight budget, got $ec"
  cat out/budget-tight.txt
  exit 1
fi
grep -q 'BREACHED' out/budget-tight.txt
grep -q 'maxTotalUsd exceeded' out/budget-tight.txt
grep -q 'maxPerModelUsd\[gpt-4o\] exceeded' out/budget-tight.txt
WH_OK=0
for i in $(seq 1 40); do
  if test -f "$WH_OUT" && grep -q 'totalUsd' "$WH_OUT" 2>/dev/null; then
    WH_OK=1
    break
  fi
  sleep 0.05
done
test "$WH_OK" = "1"
test -s "$WH_OUT"
node -e '
const d=require("./out/webhook-last.json");
if(d.ok!==false) { console.error("expected ok:false", d); process.exit(1); }
if(typeof d.totalUsd!=="number") { console.error("missing totalUsd", d); process.exit(1); }
if(!Array.isArray(d.breaches) || d.breaches.length<1) { console.error("missing breaches", d); process.exit(1); }
const keys=Object.keys(d);
if(!keys.includes("ok") || !keys.includes("breaches") || !keys.includes("totalUsd")) {
  console.error("payload keys", keys); process.exit(1);
}
console.log("webhook_breach_ok", {totalUsd:d.totalUsd, breaches:d.breaches.length});
'
echo "tight budget breach + webhook ok"
echo "==> budget-breach webhook timestamp header (OSS; replay window = paid)"
test -f "$WH_HDR"
node --input-type=module -e '
import fs from "node:fs";
const meta = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));

const raw = meta.timestamp ?? (meta.headers && (meta.headers["x-webhook-timestamp"] || meta.headers["X-Webhook-Timestamp"]));
const ts = Number(String(raw || "").trim());
if (!Number.isFinite(ts) || ts <= 0) {
  console.error("missing X-Webhook-Timestamp", meta);
  process.exit(1);
}
const now = Math.floor(Date.now() / 1000);
if (Math.abs(now - ts) > 120) {
  console.error("timestamp not now", { ts, now });
  process.exit(1);
}

console.log("webhook_timestamp_ok", ts);
' "$WH_HDR"
echo "webhook_timestamp_ok"

echo "==> budget tight + dead webhook still exit 1 (errors never change exit code)"
set +e
node src/cli.js report --in examples/spans.json --budget policies/budget.json   --webhook-url "http://127.0.0.1:1/nope" > out/budget-tight-dead-hook.txt 2>&1
ec=$?
set -e
if [ "$ec" -ne 1 ]; then
  echo "expected exit 1 even when webhook fails, got $ec"
  cat out/budget-tight-dead-hook.txt
  exit 1
fi
grep -q 'BREACHED' out/budget-tight-dead-hook.txt
echo "dead webhook still exit 1 ok"

echo "==> budget loose (expect pass, no webhook POST)"
rm -f out/budget-loose.txt "$WH_OUT"
node src/cli.js report --in examples/spans.json --budget policies/budget-loose.json \
  --webhook-url "http://127.0.0.1:${WH_PORT}/hook" | tee out/budget-loose.txt
grep -q 'budget: OK' out/budget-loose.txt
# give a brief window; pass must not write a new body
sleep 0.2
if [ -f "$WH_OUT" ]; then
  echo "loose budget must not POST webhook"
  cat "$WH_OUT"
  exit 1
fi
echo "loose budget pass (no webhook post) ok"

cleanup_wh
WH_PID=""
trap - EXIT

echo "==> [hmac] isolated report --webhook-secret (unsigned prove above stays intact)"
HMAC_WH_PORT="${HMAC_WH_PORT:-8818}"
HMAC_SECRET="whsec_local_mvp"
HMAC_OUT="$ROOT/out/webhook-hmac-last.json"
HMAC_HDR="$ROOT/out/webhook-hmac-last.headers.json"
HMAC_WH_LOG="$ROOT/out/mock-webhook.hmac.log"
rm -f "$HMAC_OUT" "$HMAC_HDR" "$HMAC_WH_LOG" out/budget-hmac.txt
unset OTEL_AI_COST_WEBHOOK_URL || true
unset OTEL_AI_COST_WEBHOOK_SECRET || true
unset OTEL_AI_COST_TENANT_BUDGETS TENANT_BUDGETS || true
node mock-webhook-receiver.js --port "$HMAC_WH_PORT" --out "$HMAC_OUT" \
  --headers-out "$HMAC_HDR" --secret "$HMAC_SECRET" >"$HMAC_WH_LOG" 2>&1 &
HMAC_WH_PID=$!
cleanup_hmac() {
  if [ -n "${HMAC_WH_PID:-}" ] && kill -0 "$HMAC_WH_PID" 2>/dev/null; then
    kill "$HMAC_WH_PID" 2>/dev/null || true
    wait "$HMAC_WH_PID" 2>/dev/null || true
  fi
}
trap cleanup_hmac EXIT
for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$HMAC_WH_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 40 ]; then
    echo "hmac mock webhook receiver did not become healthy"
    cat "$HMAC_WH_LOG" || true
    exit 1
  fi
done
set +e
node src/cli.js report --in examples/spans.json --budget policies/budget.json \
  --webhook-url "http://127.0.0.1:${HMAC_WH_PORT}/hook" \
  --webhook-secret "$HMAC_SECRET" > out/budget-hmac.txt 2>&1
ec=$?
set -e
if [ "$ec" -ne 1 ]; then
  echo "expected exit 1 for tight budget HMAC prove, got $ec"
  cat out/budget-hmac.txt
  exit 1
fi
grep -q 'BREACHED' out/budget-hmac.txt
HMAC_OK=0
for i in $(seq 1 40); do
  if test -f "$HMAC_OUT" && grep -q 'totalUsd' "$HMAC_OUT" 2>/dev/null \
     && test -f "$HMAC_HDR" && grep -q 'sha256=' "$HMAC_HDR" 2>/dev/null; then
    HMAC_OK=1
    break
  fi
  sleep 0.05
done
test "$HMAC_OK" = "1"
test -s "$HMAC_OUT"
grep -qi 'sha256=' "$HMAC_HDR"
grep -q '"verified": true' "$HMAC_HDR"
HMAC_SECRET="$HMAC_SECRET" HMAC_OUT="$HMAC_OUT" HMAC_HDR="$HMAC_HDR" node --input-type=module -e '
import fs from "node:fs";
import { signWebhookBody, verifyWebhookSignature } from "./src/webhook.js";
const secret = process.env.HMAC_SECRET;
const body = fs.readFileSync(process.env.HMAC_OUT);
const meta = JSON.parse(fs.readFileSync(process.env.HMAC_HDR, "utf8"));
const sig = String(meta.signature || "");
if (!sig.toLowerCase().startsWith("sha256=")) {
  console.error("missing X-Webhook-Signature sha256= prefix");
  process.exit(1);
}
const expected = signWebhookBody(secret, body.toString("utf8"));
if (sig.toLowerCase() !== expected) {
  console.error("HMAC mismatch", { got: sig, expected });
  process.exit(1);
}
if (!verifyWebhookSignature(secret, body.toString("utf8"), sig)) {
  console.error("verifyWebhookSignature failed");
  process.exit(1);
}
if (meta.verified !== true) {
  console.error("receiver verified flag", meta.verified);
  process.exit(1);
}
const d = JSON.parse(body.toString("utf8"));
if (d.ok !== false) { console.error("expected ok:false", d); process.exit(1); }
if (typeof d.totalUsd !== "number") { console.error("missing totalUsd", d); process.exit(1); }
if (!Array.isArray(d.breaches) || d.breaches.length < 1) { console.error("missing breaches", d); process.exit(1); }

const raw = meta.timestamp ?? (meta.headers && (meta.headers["x-webhook-timestamp"] || meta.headers["X-Webhook-Timestamp"]));
const ts = Number(String(raw || "").trim());
if (!Number.isFinite(ts) || ts <= 0) {
  console.error("missing X-Webhook-Timestamp", meta);
  process.exit(1);
}
const now = Math.floor(Date.now() / 1000);
if (Math.abs(now - ts) > 120) {
  console.error("timestamp not now", { ts, now });
  process.exit(1);
}

console.log("webhook_hmac_ok", expected.slice(0, 18) + "…", "ts=" + ts);
'
echo "webhook_hmac_ok"
cleanup_hmac
HMAC_WH_PID=""
trap - EXIT

echo "==> check-budget alias (tight fail + loose pass)"
set +e
node src/cli.js check-budget --in examples/spans.json --budget policies/budget.json > out/check-budget-tight.txt 2>&1
ec=$?
set -e
test "$ec" -eq 1
grep -q 'BREACHED' out/check-budget-tight.txt
node src/cli.js check-budget --in examples/spans.json --budget policies/budget-loose.json | tee out/check-budget-loose.txt
grep -q 'budget: OK' out/check-budget-loose.txt

echo "==> daily cost rollup (--group-by day)"
rm -f out/daily.txt out/daily.json out/daily.html
node src/cli.js report --in examples/spans.json --group-by day | tee out/daily.txt
grep -q 'UTC day cost rollup' out/daily.txt
grep -q 'day 2024-08-11' out/daily.txt
grep -q 'day 2024-08-12' out/daily.txt
grep -q 'day 2024-08-13' out/daily.txt
grep -q 'TOTAL' out/daily.txt
grep -q 'byDay' out/daily.txt

node src/cli.js report --in examples/spans.json --group-by day --out out/daily.json --html out/daily.html | tee out/daily-meta.json
test -f out/daily.json
test -f out/daily.html
node -e '
const d=require("./out/daily.json");
if(d.groupBy!=="day") { console.error(d); process.exit(1); }
if(d.timezone!=="UTC") process.exit(1);
if(!Array.isArray(d.days) || d.days.length<3) { console.error("expected >=3 days", d.days); process.exit(1); }
const days=d.days.map(x=>x.day);
for (const need of ["2024-08-11","2024-08-12","2024-08-13"]) {
  if(!days.includes(need)) { console.error("missing day", need, days); process.exit(1); }
}
const sum=Number(d.days.reduce((a,x)=>a+x.totalUsd,0).toFixed(6));
if(sum!==d.totalUsd) { console.error("day sum mismatch", sum, d.totalUsd); process.exit(1); }
if(!Array.isArray(d.byTenant) || !d.byTenant.some((t)=>t.tenant==="acme" && Number.isFinite(Number(t.usd)))) {
  console.error("missing byTenant acme", d.byTenant); process.exit(1);
}
console.log("daily json ok", {days:days.length, totalUsd:d.totalUsd, tenants:d.byTenant.length});
'
grep -q 'by day (UTC)' out/daily.html
grep -q '2024-08-11' out/daily.html
grep -q 'data-day=' out/daily.html
grep -q 'TOTAL' out/daily.html

echo "==> finance CSV export (CLI --format csv)"
rm -f out/costs.csv
node src/cli.js report --in examples/spans.json --format csv --out out/costs.csv | tee out/costs-csv-meta.json
test -f out/costs.csv
grep -q '"csv"' out/costs-csv-meta.json
node --input-type=module -e '
import fs from "node:fs";
const raw = fs.readFileSync("out/costs.csv", "utf8");
const lines = raw.trimEnd().split(/\n/);
if (!lines[0].startsWith("date,model,spanCount,usd") || !lines[0].split(",").includes("tenant")) {
  console.error("bad csv header", lines[0]);
  process.exit(1);
}
const data = lines.filter((ln) => ln && ln !== lines[0] && !ln.startsWith("TOTAL") && !ln.startsWith("#"));
if (!data.length) {
  console.error("expected at least one csv data row", raw);
  process.exit(1);
}
const usd = Number(data[0].split(",")[3]);
if (!Number.isFinite(usd)) {
  console.error("unparseable usd", data[0]);
  process.exit(1);
}
if (!raw.includes("acme")) {
  console.error("expected tenant acme in csv", raw);
  process.exit(1);
}
console.log("cli --format csv ok", { header: lines[0], rows: data.length, usd });
'

echo "==> markdown cost report (CLI --format md)"
rm -f out/costs.md
node src/cli.js report --in examples/spans.json --format md --out out/costs.md | tee out/costs-md-meta.json
test -f out/costs.md
grep -q '"md"' out/costs-md-meta.json
grep -q '# ' out/costs.md
grep -q 'totalUsd' out/costs.md
grep -q '|' out/costs.md
grep -q '| model | usd | spans |' out/costs.md
grep -q '| tenant | usd | spans |' out/costs.md
grep -q acme out/costs.md
echo "cli --format md ok"

echo "==> GitHub Actions annotations (CLI --format gha; isolated tenant budget; no-budget empty)"
rm -f out/costs.gha.txt out/costs-nobudget.gha.txt
node src/cli.js report --in examples/spans.json --tenant-budget "acme=0.0001" --format gha > out/costs.gha.txt
grep -q '::error' out/costs.gha.txt
grep -q 'title=tenant/acme::' out/costs.gha.txt
grep -q 'usd ' out/costs.gha.txt
grep -q ' > budget ' out/costs.gha.txt
node src/cli.js report --in examples/spans.json --format annotations > out/costs-nobudget.gha.txt
if grep -q '::error' out/costs-nobudget.gha.txt; then
  echo "no-budget --format gha must not emit ::error"
  cat out/costs-nobudget.gha.txt
  exit 1
fi
echo "cli --format gha ok"

echo "==> local report server (serve --port 8792; hosted dashboard = paid later)"
PORT=8792
SERVE_LOG="$ROOT/out/serve.log"
rm -f "$SERVE_LOG" out/serve-index.html out/serve-report.json out/serve-health.json out/serve-openapi.json out/serve-metrics.txt out/serve-costs.csv out/serve-costs.h out/serve-costs-q.csv out/serve-costs-q.h out/serve-costs.json out/serve-costs-json.h out/serve-costs.md out/serve-costs.md.h out/serve-costs-q.md out/serve-costs-q.md.h out/serve-costs.gha.txt out/serve-costs.gha.h out/serve-costs-q.gha.txt out/serve-costs-q.gha.h
# Default deny CORS: do not pass --cors-origins; ignore leftover env.
unset OTEL_AI_COST_CORS_ORIGINS || true
unset RATE_LIMIT_PER_MINUTE RATE_LIMIT_RPM || true
unset SPAN_MAX || true
node src/cli.js serve --port "$PORT" --in examples/spans.json >"$SERVE_LOG" 2>&1 &
SERVE_PID=$!
CORS_PID=""
cleanup_serve() {
  if [ -n "${CORS_PID:-}" ] && kill -0 "$CORS_PID" 2>/dev/null; then
    kill "$CORS_PID" 2>/dev/null || true
    wait "$CORS_PID" 2>/dev/null || true
  fi
  if [ -n "${SERVE_PID:-}" ] && kill -0 "$SERVE_PID" 2>/dev/null; then
    kill "$SERVE_PID" 2>/dev/null || true
    wait "$SERVE_PID" 2>/dev/null || true
  fi
}
trap cleanup_serve EXIT

for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "serve did not become healthy"
    cat "$SERVE_LOG" || true
    exit 1
  fi
done

curl -sf "http://127.0.0.1:$PORT/health" -o out/serve-health.json
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' out/serve-health.json
node -e '
const d=require("./out/serve-health.json");
if (d.spanCount !== 6) {
  console.error("main demo file should stay 6 spans under default cap", d);
  process.exit(1);
}
console.log("main_demo_spanCount", d.spanCount);
'

echo "==> GET /ready (always 200 {ok:true, service} — snapshot, no circuit/queue)"
READY="$(curl -s -o out/serve-ready.json -D out/serve-ready.h -w '%{http_code}' "http://127.0.0.1:$PORT/ready")"
echo "ready_status=$READY body=$(cat out/serve-ready.json)"
test "$READY" = "200"
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' out/serve-ready.json
grep -q otel-ai-cost out/serve-ready.json
grep -qiE '^x-request-id:' out/serve-ready.h
RID_READY="mvp-ready-rid-e1"
curl -s -o /tmp/e-ready-custom.json -D /tmp/e-ready-custom.h   "http://127.0.0.1:$PORT/ready" -H "X-Request-Id: $RID_READY" >/dev/null
grep -qiE "^x-request-id:[[:space:]]*${RID_READY}" /tmp/e-ready-custom.h
echo "ready_ok"

echo "==> X-Request-Id omitted → generated UUID echoed on every response"
curl -s -o /tmp/e-health-rid.json -D /tmp/e-health-rid.h "http://127.0.0.1:$PORT/health" >/dev/null
grep -qiE '^x-request-id:' /tmp/e-health-rid.h
GEN_RID="$(tr -d '\r' < /tmp/e-health-rid.h | awk 'tolower($0) ~ /^x-request-id:/{print $2; exit}')"
echo "generated_request_id=$GEN_RID"
echo "$GEN_RID" | grep -qE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
echo "request_id_generated_ok"

echo "==> X-Request-Id custom id echoed on /health"
RID_HEALTH="mvp-health-rid-e1"
curl -s -o /tmp/e-health-custom.json -D /tmp/e-health-custom.h \
  "http://127.0.0.1:$PORT/health" -H "X-Request-Id: $RID_HEALTH" >/dev/null
grep -qiE "^x-request-id:[[:space:]]*${RID_HEALTH}" /tmp/e-health-custom.h
echo "request_id_health_custom_ok"

curl -sf "http://127.0.0.1:$PORT/" -o out/serve-index.html
grep -q '<svg' out/serve-index.html
grep -q 'TOTAL' out/serve-index.html
grep -q 'by day (UTC)' out/serve-index.html

curl -sf "http://127.0.0.1:$PORT/report.json" -o out/serve-report.json
node -e '
const d=require("./out/serve-report.json");
if(typeof d.totalUsd!=="number") { console.error("missing totalUsd", d); process.exit(1); }
if(d.groupBy!=="day") { console.error("expected groupBy day (default)", d); process.exit(1); }
if(!Array.isArray(d.days) || !d.days.length) { console.error("expected days[]", d); process.exit(1); }
if(!Array.isArray(d.byTenant) || !d.byTenant.some((t)=>t.tenant==="acme" && Number.isFinite(Number(t.usd)))) {
  console.error("missing byTenant acme", d.byTenant); process.exit(1);
}
console.log("serve report.json ok", {totalUsd:d.totalUsd, days:d.days.length, tenants:d.byTenant.length});
'

echo "==> GET /v1/costs.csv (finance CSV)"
CSV_CODE="$(curl -s -o out/serve-costs.csv -D out/serve-costs.h -w "%{http_code}" "http://127.0.0.1:$PORT/v1/costs.csv")"
echo "costs_csv_status=$CSV_CODE"
test "$CSV_CODE" = "200"
grep -qiE "^content-type:[[:space:]]*text/csv" out/serve-costs.h
grep -qiE "^x-request-id:" out/serve-costs.h
test -s out/serve-costs.csv
node --input-type=module -e '
import fs from "node:fs";
const raw = fs.readFileSync("out/serve-costs.csv", "utf8");
const lines = raw.trimEnd().split(/\n/);
if (!lines[0].startsWith("date,model,spanCount,usd") || !lines[0].split(",").includes("tenant")) {
  console.error("bad csv header", lines[0]);
  process.exit(1);
}
const data = lines.filter((ln) => ln && ln !== lines[0] && !ln.startsWith("TOTAL") && !ln.startsWith("#"));
if (!data.length) {
  console.error("expected csv data row", raw);
  process.exit(1);
}
const usd = Number(data[0].split(",")[3]);
if (!Number.isFinite(usd)) {
  console.error("unparseable usd", data[0]);
  process.exit(1);
}
if (!raw.includes("acme")) {
  console.error("expected tenant acme in csv", raw);
  process.exit(1);
}
console.log("serve /v1/costs.csv ok", { rows: data.length, usd });
'
CSV_Q="$(curl -s -o out/serve-costs-q.csv -D out/serve-costs-q.h -w "%{http_code}" "http://127.0.0.1:$PORT/v1/costs?format=csv")"
echo "costs_format_csv_status=$CSV_Q"
test "$CSV_Q" = "200"
grep -qiE "^content-type:[[:space:]]*text/csv" out/serve-costs-q.h
cmp -s out/serve-costs.csv out/serve-costs-q.csv
echo "costs_csv_ok"

echo "==> GET /v1/costs.md (FinOps Markdown)"
MD_CODE="$(curl -s -o out/serve-costs.md -D out/serve-costs.md.h -w "%{http_code}" "http://127.0.0.1:$PORT/v1/costs.md")"
echo "costs_md_status=$MD_CODE"
test "$MD_CODE" = "200"
grep -qiE "^content-type:[[:space:]]*text/markdown" out/serve-costs.md.h
grep -qiE "^x-request-id:" out/serve-costs.md.h
test -s out/serve-costs.md
grep -q '# ' out/serve-costs.md
grep -q 'totalUsd' out/serve-costs.md
grep -q '|' out/serve-costs.md
grep -q '| model | usd | spans |' out/serve-costs.md
grep -q '| tenant | usd | spans |' out/serve-costs.md
grep -q acme out/serve-costs.md
MD_Q="$(curl -s -o out/serve-costs-q.md -D out/serve-costs-q.md.h -w "%{http_code}" "http://127.0.0.1:$PORT/v1/costs?format=md")"
echo "costs_format_md_status=$MD_Q"
test "$MD_Q" = "200"
grep -qiE "^content-type:[[:space:]]*text/markdown" out/serve-costs-q.md.h
cmp -s out/serve-costs.md out/serve-costs-q.md
echo "costs_md_ok"

echo "==> GET /v1/costs.gha.txt (no tenant budget on main serve → empty, no ::error)"
GHA_CODE="$(curl -s -o out/serve-costs.gha.txt -D out/serve-costs.gha.h -w "%{http_code}" "http://127.0.0.1:$PORT/v1/costs.gha.txt")"
echo "costs_gha_status=$GHA_CODE"
test "$GHA_CODE" = "200"
grep -qiE "^content-type:[[:space:]]*text/plain" out/serve-costs.gha.h
grep -qiE "^x-request-id:" out/serve-costs.gha.h
if grep -q '::error' out/serve-costs.gha.txt; then
  echo "main serve gha must be empty (no tenant/global budget)"
  cat out/serve-costs.gha.txt
  exit 1
fi
GHA_Q="$(curl -s -o out/serve-costs-q.gha.txt -D out/serve-costs-q.gha.h -w "%{http_code}" "http://127.0.0.1:$PORT/v1/costs?format=gha")"
echo "costs_format_gha_status=$GHA_Q"
test "$GHA_Q" = "200"
grep -qiE "^content-type:[[:space:]]*text/plain" out/serve-costs-q.gha.h
cmp -s out/serve-costs.gha.txt out/serve-costs-q.gha.txt
echo "costs_gha_ok"

echo "==> GET /v1/costs JSON (byTenant)"
COSTS_JSON="$(curl -s -o out/serve-costs.json -D out/serve-costs-json.h -w "%{http_code}" "http://127.0.0.1:$PORT/v1/costs")"
echo "costs_json_status=$COSTS_JSON"
test "$COSTS_JSON" = "200"
grep -qiE "^content-type:[[:space:]]*application/json" out/serve-costs-json.h
node -e '
const d=require("./out/serve-costs.json");
if(typeof d.totalUsd!=="number") { console.error("missing totalUsd", d); process.exit(1); }
if(!Array.isArray(d.byTenant) || !d.byTenant.some((t)=>t.tenant==="acme" && Number.isFinite(Number(t.usd)))) {
  console.error("missing byTenant acme", d.byTenant); process.exit(1);
}
console.log("serve /v1/costs json byTenant ok", {totalUsd:d.totalUsd, tenants:d.byTenant.length});
'
echo "costs_json_ok"

echo "==> GET /v1/budgets (default none → globalUsd null, tenants {})"
BUDGETS_CODE="$(curl -s -o out/serve-budgets.json -D out/serve-budgets.h -w "%{http_code}" "http://127.0.0.1:$PORT/v1/budgets")"
echo "budgets_status=$BUDGETS_CODE"
test "$BUDGETS_CODE" = "200"
grep -qiE "^content-type:[[:space:]]*application/json" out/serve-budgets.h
grep -qiE "^x-request-id:" out/serve-budgets.h
node -e '
const d=require("./out/serve-budgets.json");
if(d.ok!==true) { console.error("expected ok:true", d); process.exit(1); }
if(d.globalUsd!==null) { console.error("default globalUsd must be null", d); process.exit(1); }
if(!d.tenants || typeof d.tenants!=="object" || Array.isArray(d.tenants) || Object.keys(d.tenants).length!==0) {
  console.error("default tenants must be {}", d.tenants); process.exit(1);
}
if("token" in d || "secret" in d || JSON.stringify(d).includes("sk-")) {
  console.error("budgets leaked secret", d); process.exit(1);
}
console.log("serve /v1/budgets default none ok", d);
'
echo "budgets_empty_ok"

echo "==> GET /v1/models (pricing catalog; built-in table; rates not spend)"
MODELS_CODE="$(curl -s -o out/serve-models.json -D out/serve-models.h -w "%{http_code}" "http://127.0.0.1:$PORT/v1/models")"
echo "models_status=$MODELS_CODE"
test "$MODELS_CODE" = "200"
grep -qiE "^content-type:[[:space:]]*application/json" out/serve-models.h
grep -qiE "^x-request-id:" out/serve-models.h
node -e '
const d=require("./out/serve-models.json");
if(d.ok!==true) { console.error("expected ok:true", d); process.exit(1); }
if(!Array.isArray(d.models) || d.models.length<1) { console.error("expected models[]", d); process.exit(1); }
const ids=d.models.map((m)=>m.id);
if(!ids.includes("gpt-4o") && !ids.includes("gpt-4o-mini") && !ids.includes("claude-sonnet")) {
  console.error("expected a default-pack model id", ids); process.exit(1);
}
const gpt=d.models.find((m)=>m.id==="gpt-4o");
if(gpt && (typeof gpt.inputPerMTok!=="number" || typeof gpt.outputPerMTok!=="number")) {
  console.error("gpt-4o missing inputPerMTok/outputPerMTok", gpt); process.exit(1);
}
if("token" in d || "secret" in d || JSON.stringify(d).includes("sk-")) {
  console.error("models leaked secret", d); process.exit(1);
}
console.log("serve /v1/models catalog ok", {count:d.models.length, ids, pack:d.pack, defaultModel:d.defaultModel});
'
echo "models_catalog_ok"

echo "==> GET /v1/config (redacted knobs; no secrets)"
CFG_CODE="$(curl -s -o out/serve-config.json -D out/serve-config.h -w "%{http_code}"   "http://127.0.0.1:$PORT/v1/config" -H "X-Request-Id: mvp-config-rid")"
echo "config_status=$CFG_CODE"
test "$CFG_CODE" = "200"
grep -qiE "^content-type:[[:space:]]*application/json" out/serve-config.h
grep -qiE "^x-request-id:[[:space:]]*mvp-config-rid" out/serve-config.h
node -e '
const d=require("./out/serve-config.json");
if(d.ok!==true) { console.error("expected ok:true", d); process.exit(1); }
if(d.spanCap==null && !((d.cors||{}).origins)) { console.error("expected spanCap or cors", d); process.exit(1); }
if(!d.rateLimit || !("perMinute" in d.rateLimit)) { console.error("expected rateLimit.perMinute", d); process.exit(1); }
if(!d.webhooks || !("hasUrl" in d.webhooks) || !("hasSecret" in d.webhooks)) { console.error("expected webhooks booleans", d); process.exit(1); }
const blob=JSON.stringify(d);
for (const n of ["webhookUrl","webhookSecret","webhook_url","webhook_secret","Authorization","whsec_","sk-"]) {
  if(blob.includes(n)) { console.error("config leaked", n, d); process.exit(1); }
}
if("token" in d || "secret" in d || "models" in d) { console.error("forbidden key", d); process.exit(1); }
console.log("serve /v1/config ok", {spanCap:d.spanCap, cors:d.cors, hasUrl:(d.webhooks||{}).hasUrl, hasSecret:(d.webhooks||{}).hasSecret});
'
echo "config_ok"

echo "==> GET /v1/spans (allowlist summaries; no prompts)"
SPANS_CODE="$(curl -s -o out/serve-spans.json -D out/serve-spans.h -w "%{http_code}"   "http://127.0.0.1:$PORT/v1/spans" -H "X-Request-Id: mvp-spans-rid")"
echo "spans_status=$SPANS_CODE"
test "$SPANS_CODE" = "200"
grep -qiE "^content-type:[[:space:]]*application/json" out/serve-spans.h
grep -qiE "^x-request-id:[[:space:]]*mvp-spans-rid" out/serve-spans.h
node -e '
const d=require("./out/serve-spans.json");
if(d.ok!==true) { console.error("expected ok:true", d); process.exit(1); }
if(!Array.isArray(d.spans) || Number(d.count)<1 || d.spans.length<1) { console.error("expected count>=1", d); process.exit(1); }
const row=d.spans[0];
if(!row || !row.model) { console.error("expected model", d); process.exit(1); }
for (const k of ["id","tenant","inputTokens","outputTokens","usd","ts"]) {
  if(!(k in row)) { console.error("missing key", k, row); process.exit(1); }
}
const blob=JSON.stringify(d);
for (const n of ["SECRET_PROMPT","secret user question","confidential answer","another private prompt","gen_ai.prompt","gen_ai.completion","Authorization"]) {
  if(blob.includes(n)) { console.error("spans leaked", n, d); process.exit(1); }
}
if("attributes" in row || "prompt" in row) { console.error("forbidden key", row); process.exit(1); }
console.log("serve /v1/spans ok", {count:d.count, model:row.model, tenant:row.tenant, truncated:d.truncated});
'
echo "spans_ok"

echo "==> GET /v1/tenants (per-tenant spend rollup; no prompts)"
TENANTS_CODE="$(curl -s -o out/serve-tenants.json -D out/serve-tenants.h -w "%{http_code}"   "http://127.0.0.1:$PORT/v1/tenants" -H "X-Request-Id: mvp-tenants-rid")"
echo "tenants_status=$TENANTS_CODE"
test "$TENANTS_CODE" = "200"
grep -qiE "^content-type:[[:space:]]*application/json" out/serve-tenants.h
grep -qiE "^x-request-id:[[:space:]]*mvp-tenants-rid" out/serve-tenants.h
node -e '
const d=require("./out/serve-tenants.json");
if(d.ok!==true) { console.error("expected ok:true", d); process.exit(1); }
if(!Array.isArray(d.tenants) || Number(d.count)<1 || d.tenants.length<1) { console.error("expected count>=1", d); process.exit(1); }
const row=d.tenants[0];
if(!row || (row.id!=="acme" && row.id!=="_" && !(d.tenants.some((t)=>t.id==="acme"||t.id==="_")))) {
  console.error("expected tenant id acme or _", d); process.exit(1);
}
if(typeof row.usd!=="number" || !Number.isFinite(row.usd)) { console.error("expected numeric usd", row); process.exit(1); }
if(!Number.isInteger(row.spanCount)) { console.error("expected integer spanCount", row); process.exit(1); }
const blob=JSON.stringify(d);
for (const n of ["SECRET_PROMPT","secret user question","confidential answer","another private prompt","gen_ai.prompt","gen_ai.completion","Authorization"]) {
  if(blob.includes(n)) { console.error("tenants leaked", n, d); process.exit(1); }
}
if("attributes" in row || "prompt" in row) { console.error("forbidden key", row); process.exit(1); }
console.log("serve /v1/tenants ok", {count:d.count, id:row.id, usd:row.usd, truncated:d.truncated});
'
echo "tenants_ok"

echo "==> GET /metrics (Prometheus text)"
curl -sf "http://127.0.0.1:$PORT/metrics" -o out/serve-metrics.txt
test -s out/serve-metrics.txt
grep -q 'otel_ai_cost_total_usd' out/serve-metrics.txt
grep -q 'otel_ai_cost_by_model_usd' out/serve-metrics.txt
grep -q 'otel_ai_cost_span_count' out/serve-metrics.txt
grep -q 'otel_ai_cost_by_tenant_usd' out/serve-metrics.txt
grep -q 'otel_ai_cost_budget_remaining_usd' out/serve-metrics.txt
grep -q 'otel_ai_cost_budget_deny_total' out/serve-metrics.txt
grep -q 'otel_ai_cost_input_tokens' out/serve-metrics.txt
grep -q 'otel_ai_cost_output_tokens' out/serve-metrics.txt
echo "metrics_names_ok"

echo "==> GET /openapi.json (file-backed spec)"
RID_OA="mvp-oa-rid-e1"
curl -s -o out/serve-openapi.json -D out/serve-openapi.h \
  "http://127.0.0.1:$PORT/openapi.json" -H "X-Request-Id: $RID_OA"
test -s out/serve-openapi.json
grep -q '"openapi"' out/serve-openapi.json
grep -qiE "^x-request-id:[[:space:]]*${RID_OA}" out/serve-openapi.h
echo "request_id_openapi_custom_ok"
node -e '
const spec=require("./out/serve-openapi.json");
if(!String(spec.openapi||"").startsWith("3.")) { console.error("openapi version", spec.openapi); process.exit(1); }
const paths=spec.paths||{};
const need=["/health","/ready","/","/report.json","/v1/costs.csv","/v1/costs.md","/v1/costs.gha.txt","/v1/costs","/v1/budgets","/v1/models","/v1/config","/v1/spans","/v1/tenants","/v1/tenants.csv","/metrics","/openapi.json"];
const missing=need.filter((p)=>!paths[p] || !paths[p].get);
if(missing.length) { console.error("missing paths", missing); process.exit(1); }
for (const p of ["/health","/ready","/","/report.json","/v1/costs.csv","/v1/costs.md","/v1/costs.gha.txt","/v1/costs","/v1/budgets","/v1/models","/v1/config","/v1/spans","/v1/tenants","/v1/tenants.csv","/metrics"]) {
  const resp=(paths[p].get.responses||{});
  if(!resp["403"]) { console.error("missing 403 CORS", p, Object.keys(resp)); process.exit(1); }
}
const responses=(spec.components||{}).responses||{};
if(!responses.CorsDenied) { console.error("missing CorsDenied"); process.exit(1); }
if(!responses.RateLimited) { console.error("missing RateLimited"); process.exit(1); }
if(!(((paths["/report.json"]||{}).get||{}).responses||{})["429"]) { console.error("missing 429 report.json"); process.exit(1); }
const params=(spec.components||{}).parameters||{};
const headers=(spec.components||{}).headers||{};
if(!params.XRequestId) { console.error("missing XRequestId param"); process.exit(1); }
if(!headers.XRequestId) { console.error("missing XRequestId header"); process.exit(1); }
const desc=String((spec.info||{}).description||"");
if(!desc.includes("403") && !desc.includes("cors_denied")) { console.error("info missing CORS 403 notes"); process.exit(1); }
if(!desc.includes("X-Request-Id") && !desc.includes("requestId")) { console.error("info missing X-Request-Id note"); process.exit(1); }
if(!desc.includes("Retry-After") || !desc.includes("rate_limited")) { console.error("info missing rate-limit note"); process.exit(1); }
if(((paths["/health"]||{}).get||{}).operationId!=="getHealth") process.exit(1);
if(((paths["/ready"]||{}).get||{}).operationId!=="getReady") process.exit(1);
if(((paths["/report.json"]||{}).get||{}).operationId!=="getReport") process.exit(1);
if(((paths["/v1/costs.csv"]||{}).get||{}).operationId!=="getCostsCsv") process.exit(1);
if(((paths["/v1/costs.md"]||{}).get||{}).operationId!=="getCostsMd") process.exit(1);
if(((paths["/v1/costs.gha.txt"]||{}).get||{}).operationId!=="getCostsGha") process.exit(1);
if(((paths["/v1/costs"]||{}).get||{}).operationId!=="getCosts") process.exit(1);
if(((paths["/v1/budgets"]||{}).get||{}).operationId!=="getBudgets") process.exit(1);
if(((paths["/v1/models"]||{}).get||{}).operationId!=="getModels") process.exit(1);
if(((paths["/v1/config"]||{}).get||{}).operationId!=="getConfig") process.exit(1);
if(((paths["/v1/spans"]||{}).get||{}).operationId!=="listSpans") process.exit(1);
if(((paths["/v1/tenants"]||{}).get||{}).operationId!=="listTenants") process.exit(1);
if(((paths["/v1/tenants.csv"]||{}).get||{}).operationId!=="getTenantsCsv") process.exit(1);
if(((paths["/"]||{}).get||{}).operationId!=="getIndex") process.exit(1);
if(((paths["/openapi.json"]||{}).get||{}).operationId!=="getOpenApi") process.exit(1);
if(((paths["/metrics"]||{}).get||{}).operationId!=="getMetrics") process.exit(1);
if(((paths["/v1/traces"]||{}).post||{}).operationId!=="postTraces") { console.error("missing postTraces"); process.exit(1); }
if(!(((paths["/v1/traces"]||{}).post||{}).responses||{})["200"]) process.exit(1);
if(!(((paths["/v1/traces"]||{}).post||{}).responses||{})["400"]) process.exit(1);
if(!(((paths["/v1/traces"]||{}).post||{}).responses||{})["401"]) process.exit(1);
if(!responses.Unauthorized) { console.error("missing Unauthorized"); process.exit(1); }
if(!responses.PayloadTooLarge) { console.error("missing PayloadTooLarge"); process.exit(1); }
if(!desc.includes("/v1/traces") && !desc.includes("OTLP")) { console.error("info missing OTLP ingest"); process.exit(1); }
console.log("openapi_paths_ok", Object.keys(paths).length);
'

echo "==> default deny CORS (main serve has no --cors-origins)"
DEF_GET="$(curl -s -o out/e-def-cors.json -D out/e-def-cors.h -w "%{http_code}"   "http://127.0.0.1:$PORT/health" -H "Origin: http://localhost:3000")"
echo "default_cors_get_status=$DEF_GET"
test "$DEF_GET" = "200"
if grep -qiE "^access-control-allow-origin:" out/e-def-cors.h; then
  echo "default serve must not send ACAO"
  cat out/e-def-cors.h
  exit 1
fi
DEF_OPT="$(curl -s -o out/e-def-opt.json -D out/e-def-opt.h -w "%{http_code}"   -X OPTIONS "http://127.0.0.1:$PORT/health" -H "Origin: http://localhost:3000"   -H "Access-Control-Request-Method: GET" -H "X-Request-Id: mvp-opt-rid-404")"
echo "default_cors_options_status=$DEF_OPT"
test "$DEF_OPT" = "404"
if grep -qiE "^access-control-allow-origin:" out/e-def-opt.h; then
  echo "default OPTIONS must not send ACAO"
  cat out/e-def-opt.h
  exit 1
fi
grep -q '"not_found"' out/e-def-opt.json
grep -qiE "^x-request-id:[[:space:]]*mvp-opt-rid-404" out/e-def-opt.h

echo "==> 4xx echoes custom X-Request-Id"
MISS="$(curl -s -o out/e-missing.json -D out/e-missing.h -w "%{http_code}" \
  "http://127.0.0.1:$PORT/no-such-path" -H "X-Request-Id: mvp-4xx-rid-404")"
echo "missing_path_status=$MISS"
test "$MISS" = "404"
grep -qiE "^x-request-id:[[:space:]]*mvp-4xx-rid-404" out/e-missing.h

cleanup_serve
SERVE_PID=""
echo "serve ok (default deny CORS)"

echo "==> [cors] isolated serve --cors-origins http://localhost:3000"
CORS_PORT="${CORS_PORT:-$((PORT + 17))}"
CORS_LOG="$ROOT/out/cors-serve.log"
rm -f "$CORS_LOG"
node src/cli.js serve --port "$CORS_PORT" --in examples/spans.json   --cors-origins "http://localhost:3000" >"$CORS_LOG" 2>&1 &
CORS_PID=$!
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$CORS_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "cors serve did not become healthy"
    cat "$CORS_LOG" || true
    exit 1
  fi
done

CORS_OK="$(curl -s -o out/e-cors-ok -D out/e-cors-ok.h -w "%{http_code}"   -X OPTIONS "http://127.0.0.1:$CORS_PORT/health"   -H "Origin: http://localhost:3000"   -H "Access-Control-Request-Method: GET" -H "X-Request-Id: mvp-cors-opt-204")"
echo "cors_preflight_ok_status=$CORS_OK"
test "$CORS_OK" = "204"
grep -qiE "^access-control-allow-origin:[[:space:]]*http://localhost:3000" out/e-cors-ok.h
grep -qiE "^access-control-allow-methods:" out/e-cors-ok.h
grep -qiE "^access-control-allow-headers:" out/e-cors-ok.h
grep -qiE "^access-control-allow-headers:.*x-request-id" out/e-cors-ok.h
grep -qiE "^access-control-expose-headers:.*retry-after" out/e-cors-ok.h
grep -qiE "^x-request-id:[[:space:]]*mvp-cors-opt-204" out/e-cors-ok.h

CORS_HTML_PF="$(curl -s -o out/e-cors-html-pf -D out/e-cors-html-pf.h -w "%{http_code}"   -X OPTIONS "http://127.0.0.1:$CORS_PORT/"   -H "Origin: http://localhost:3000"   -H "Access-Control-Request-Method: GET")"
echo "cors_preflight_html_status=$CORS_HTML_PF"
test "$CORS_HTML_PF" = "204"
grep -qiE "^access-control-allow-origin:[[:space:]]*http://localhost:3000" out/e-cors-html-pf.h

CORS_OA_PF="$(curl -s -o out/e-cors-oa-pf -D out/e-cors-oa-pf.h -w "%{http_code}"   -X OPTIONS "http://127.0.0.1:$CORS_PORT/openapi.json"   -H "Origin: http://localhost:3000"   -H "Access-Control-Request-Method: GET")"
echo "cors_preflight_openapi_status=$CORS_OA_PF"
test "$CORS_OA_PF" = "204"
grep -qiE "^access-control-allow-origin:[[:space:]]*http://localhost:3000" out/e-cors-oa-pf.h

CORS_EVIL="$(curl -s -o out/e-cors-evil.json -D out/e-cors-evil.h -w "%{http_code}"   -X OPTIONS "http://127.0.0.1:$CORS_PORT/health"   -H "Origin: http://evil.example"   -H "Access-Control-Request-Method: GET" -H "X-Request-Id: mvp-cors-opt-403")"
echo "cors_preflight_evil_status=$CORS_EVIL body=$(cat out/e-cors-evil.json)"
test "$CORS_EVIL" = "403"
grep -q "cors_denied" out/e-cors-evil.json
if grep -qiE "^access-control-allow-origin:[[:space:]]*http://evil.example" out/e-cors-evil.h; then
  echo "evil origin must not receive ACAO"
  exit 1
fi
grep -qiE "^x-request-id:[[:space:]]*mvp-cors-opt-403" out/e-cors-evil.h

HEALTH_CORS="$(curl -s -o out/e-health-cors.json -D out/e-health-cors.h -w "%{http_code}"   "http://127.0.0.1:$CORS_PORT/health" -H "Origin: http://localhost:3000")"
echo "cors_get_health_status=$HEALTH_CORS"
test "$HEALTH_CORS" = "200"
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' out/e-health-cors.json
grep -qiE "^access-control-allow-origin:[[:space:]]*http://localhost:3000" out/e-health-cors.h
grep -qiE "^access-control-expose-headers:.*x-request-id" out/e-health-cors.h
grep -qiE "^access-control-expose-headers:.*retry-after" out/e-health-cors.h
grep -qiE "^x-request-id:" out/e-health-cors.h

HTML_CORS="$(curl -s -o out/e-html-cors.html -D out/e-html-cors.h -w "%{http_code}"   "http://127.0.0.1:$CORS_PORT/" -H "Origin: http://localhost:3000")"
echo "cors_get_html_status=$HTML_CORS"
test "$HTML_CORS" = "200"
grep -q '<svg' out/e-html-cors.html
grep -q 'TOTAL' out/e-html-cors.html
grep -qiE "^access-control-allow-origin:[[:space:]]*http://localhost:3000" out/e-html-cors.h

JSON_CORS="$(curl -s -o out/e-json-cors.json -D out/e-json-cors.h -w "%{http_code}"   "http://127.0.0.1:$CORS_PORT/report.json" -H "Origin: http://localhost:3000")"
echo "cors_get_report_status=$JSON_CORS"
test "$JSON_CORS" = "200"
node -e '
const d=require("./out/e-json-cors.json");
if(typeof d.totalUsd!=="number") { console.error("missing totalUsd", d); process.exit(1); }
if(d.groupBy!=="day") { console.error("expected groupBy day", d); process.exit(1); }
console.log("cors report.json ok", {totalUsd:d.totalUsd});
'
grep -qiE "^access-control-allow-origin:[[:space:]]*http://localhost:3000" out/e-json-cors.h

CSV_CORS="$(curl -s -o out/e-csv-cors.csv -D out/e-csv-cors.h -w "%{http_code}"   "http://127.0.0.1:$CORS_PORT/v1/costs.csv" -H "Origin: http://localhost:3000")"
echo "cors_get_csv_status=$CSV_CORS"
test "$CSV_CORS" = "200"
grep -q 'date,model,spanCount,usd' out/e-csv-cors.csv
grep -qiE "^content-type:[[:space:]]*text/csv" out/e-csv-cors.h
grep -qiE "^access-control-allow-origin:[[:space:]]*http://localhost:3000" out/e-csv-cors.h
grep -qiE "^x-request-id:" out/e-csv-cors.h

MD_CORS="$(curl -s -o out/e-md-cors.md -D out/e-md-cors.h -w "%{http_code}"   "http://127.0.0.1:$CORS_PORT/v1/costs.md" -H "Origin: http://localhost:3000")"
echo "cors_get_md_status=$MD_CORS"
test "$MD_CORS" = "200"
grep -q '# ' out/e-md-cors.md
grep -q 'totalUsd' out/e-md-cors.md
grep -qiE "^content-type:[[:space:]]*text/markdown" out/e-md-cors.h
grep -qiE "^access-control-allow-origin:[[:space:]]*http://localhost:3000" out/e-md-cors.h
grep -qiE "^x-request-id:" out/e-md-cors.h

OPENAPI_CORS="$(curl -s -o out/e-openapi-cors.json -D out/e-openapi-cors.h -w "%{http_code}"   "http://127.0.0.1:$CORS_PORT/openapi.json" -H "Origin: http://localhost:3000")"
echo "cors_get_openapi_status=$OPENAPI_CORS"
test "$OPENAPI_CORS" = "200"
grep -q '"openapi"' out/e-openapi-cors.json
grep -q '/report.json' out/e-openapi-cors.json
grep -qiE "^access-control-allow-origin:[[:space:]]*http://localhost:3000" out/e-openapi-cors.h
grep -qiE "^x-request-id:" out/e-openapi-cors.h

CORS_METRICS_PF="$(curl -s -o out/e-cors-metrics-pf -D out/e-cors-metrics-pf.h -w "%{http_code}"   -X OPTIONS "http://127.0.0.1:$CORS_PORT/metrics"   -H "Origin: http://localhost:3000"   -H "Access-Control-Request-Method: GET")"
echo "cors_preflight_metrics_status=$CORS_METRICS_PF"
test "$CORS_METRICS_PF" = "204"
grep -qiE "^access-control-allow-origin:[[:space:]]*http://localhost:3000" out/e-cors-metrics-pf.h

METRICS_CORS="$(curl -s -o out/e-metrics-cors.txt -D out/e-metrics-cors.h -w "%{http_code}"   "http://127.0.0.1:$CORS_PORT/metrics" -H "Origin: http://localhost:3000")"
echo "cors_get_metrics_status=$METRICS_CORS"
test "$METRICS_CORS" = "200"
grep -q 'otel_ai_cost_total_usd' out/e-metrics-cors.txt
grep -q 'otel_ai_cost_by_model_usd' out/e-metrics-cors.txt
grep -q 'otel_ai_cost_span_count' out/e-metrics-cors.txt
grep -qiE "^access-control-allow-origin:[[:space:]]*http://localhost:3000" out/e-metrics-cors.h

HEALTH_EVIL="$(curl -s -o out/e-health-evil.json -D out/e-health-evil.h -w "%{http_code}"   "http://127.0.0.1:$CORS_PORT/health" -H "Origin: http://evil.example")"
echo "cors_get_evil_status=$HEALTH_EVIL"
test "$HEALTH_EVIL" = "200"
if grep -qiE "^access-control-allow-origin:" out/e-health-evil.h; then
  echo "disallowed origin should not get ACAO"
  cat out/e-health-evil.h
  exit 1
fi

if [ -n "${CORS_PID:-}" ]; then
  kill "$CORS_PID" 2>/dev/null || true
  wait "$CORS_PID" 2>/dev/null || true
  CORS_PID=""
fi
trap - EXIT
echo "==> [cors] allow localhost:3000 / deny evil.example OK (isolated); main server default deny"

echo "==> [rate-limit] isolated serve --rate-limit 2 (third /report.json is 429; /health still 200)"
RL_PORT="${RL_PORT:-$((PORT + 40))}"
RL_LOG="$ROOT/out/rl-serve.log"
rm -f "$RL_LOG" out/e-rl-1.json out/e-rl-2.json out/e-rl-3.json out/e-rl-3.h out/e-rl-health.json
unset OTEL_AI_COST_CORS_ORIGINS || true
unset RATE_LIMIT_PER_MINUTE RATE_LIMIT_RPM || true
node src/cli.js serve --port "$RL_PORT" --in examples/spans.json --rate-limit 2 >"$RL_LOG" 2>&1 &
RL_PID=$!
cleanup_rl() {
  if [ -n "${RL_PID:-}" ] && kill -0 "$RL_PID" 2>/dev/null; then
    kill "$RL_PID" 2>/dev/null || true
    wait "$RL_PID" 2>/dev/null || true
  fi
}
trap cleanup_rl EXIT
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$RL_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "rate-limit serve did not become healthy"
    cat "$RL_LOG" || true
    exit 1
  fi
done
RL1="$(curl -s -o out/e-rl-1.json -w "%{http_code}" "http://127.0.0.1:$RL_PORT/report.json")"
RL2="$(curl -s -o out/e-rl-2.json -w "%{http_code}" "http://127.0.0.1:$RL_PORT/report.json")"
RL3="$(curl -s -o out/e-rl-3.json -D out/e-rl-3.h -w "%{http_code}" "http://127.0.0.1:$RL_PORT/report.json" -H "X-Request-Id: mvp-rl-rid-429")"
echo "rl_hit_1=$RL1 rl_hit_2=$RL2 rl_hit_3=$RL3 body=$(cat out/e-rl-3.json)"
test "$RL1" = "200"
test "$RL2" = "200"
test "$RL3" = "429"
grep -qi '^Retry-After:' out/e-rl-3.h
grep -qiE '^x-request-id:[[:space:]]*mvp-rl-rid-429' out/e-rl-3.h
grep -Eq '"ok"[[:space:]]*:[[:space:]]*false' out/e-rl-3.json
grep -Eq '"reason"[[:space:]]*:[[:space:]]*"rate_limited"' out/e-rl-3.json
RL_HEALTH="$(curl -s -o out/e-rl-health.json -w "%{http_code}" "http://127.0.0.1:$RL_PORT/health")"
RL_READY="$(curl -s -o out/e-rl-ready.json -w "%{http_code}" "http://127.0.0.1:$RL_PORT/ready")"
RL_METRICS="$(curl -s -o out/e-rl-metrics.txt -w "%{http_code}" "http://127.0.0.1:$RL_PORT/metrics")"
echo "rl_health=$RL_HEALTH rl_ready=$RL_READY rl_metrics=$RL_METRICS"
test "$RL_HEALTH" = "200"
test "$RL_READY" = "200"
test "$RL_METRICS" = "200"
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' out/e-rl-health.json
cleanup_rl
RL_PID=""
trap - EXIT
echo "==> [rate-limit] 429 + Retry-After OK (isolated); probes excluded; main serve unchanged"

echo "==> [watch] isolated serve --watch (mtime poll reload; must not hang)"
WATCH_PORT="${WATCH_PORT:-8821}"
WATCH_SPANS="$ROOT/out/watch-spans.json"
WATCH_LOG="$ROOT/out/watch-serve.log"
rm -f "$WATCH_LOG" "$WATCH_SPANS" out/watch-before.json out/watch-after.json out/watch-after-health.json
cp examples/spans.json "$WATCH_SPANS"
unset OTEL_AI_COST_CORS_ORIGINS || true
node src/cli.js serve --port "$WATCH_PORT" --in "$WATCH_SPANS" --watch >"$WATCH_LOG" 2>&1 &
WATCH_PID=$!
cleanup_watch() {
  if [ -n "${WATCH_PID:-}" ] && kill -0 "$WATCH_PID" 2>/dev/null; then
    kill "$WATCH_PID" 2>/dev/null || true
    wait "$WATCH_PID" 2>/dev/null || true
  fi
}
trap cleanup_watch EXIT

for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$WATCH_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "watch serve did not become healthy"
    cat "$WATCH_LOG" || true
    exit 1
  fi
  if ! kill -0 "$WATCH_PID" 2>/dev/null; then
    echo "watch serve exited early"
    cat "$WATCH_LOG" || true
    exit 1
  fi
done

curl -sf "http://127.0.0.1:$WATCH_PORT/report.json" -o out/watch-before.json
curl -sf "http://127.0.0.1:$WATCH_PORT/health" -o out/watch-before-health.json
BEFORE_TOTAL="$(node -e 'const d=require("./out/watch-before.json"); if(typeof d.totalUsd!=="number") process.exit(1); process.stdout.write(String(d.totalUsd));')"
BEFORE_SPANS="$(node -e 'const d=require("./out/watch-before-health.json"); if(typeof d.spanCount!=="number") process.exit(1); process.stdout.write(String(d.spanCount));')"
echo "watch_before totalUsd=$BEFORE_TOTAL spanCount=$BEFORE_SPANS"
test -n "$BEFORE_TOTAL"
test -n "$BEFORE_SPANS"

python3 -c '
import json, os, pathlib, time
p = pathlib.Path("out/watch-spans.json")
spans = json.loads(p.read_text())
spans.append({
    "name": "chat.completions",
    "timestamp": "2024-08-14T00:00:00.000Z",
    "attributes": {
        "gen_ai.request.model": "gpt-4o",
        "gen_ai.usage.input_tokens": 10000,
        "gen_ai.usage.output_tokens": 5000,
    },
})
p.write_text(json.dumps(spans, indent=2) + "\n")
now = time.time() + 1
os.utime(p, (now, now))
print("appended", len(spans))
'

REGEN_OK=0
for _ in $(seq 1 25); do
  curl -sf "http://127.0.0.1:$WATCH_PORT/report.json" -o out/watch-after.json || true
  curl -sf "http://127.0.0.1:$WATCH_PORT/health" -o out/watch-after-health.json || true
  AFTER_TOTAL=""
  AFTER_SPANS=""
  if test -s out/watch-after.json && test -s out/watch-after-health.json; then
    AFTER_TOTAL="$(node -e 'try{const d=require("./out/watch-after.json"); process.stdout.write(typeof d.totalUsd==="number"?String(d.totalUsd):""); }catch(e){}' || true)"
    AFTER_SPANS="$(node -e 'try{const d=require("./out/watch-after-health.json"); process.stdout.write(typeof d.spanCount==="number"?String(d.spanCount):""); }catch(e){}' || true)"
  fi
  if grep -q regenerated "$WATCH_LOG" 2>/dev/null; then
    curl -sf "http://127.0.0.1:$WATCH_PORT/report.json" -o out/watch-after.json || true
    curl -sf "http://127.0.0.1:$WATCH_PORT/health" -o out/watch-after-health.json || true
    REGEN_OK=1
    break
  fi
  if [ -n "$AFTER_TOTAL" ] && [ -n "$AFTER_SPANS" ]; then
    if awk -v b="$BEFORE_TOTAL" -v a="$AFTER_TOTAL" -v bs="$BEFORE_SPANS" -v as="$AFTER_SPANS" 'BEGIN { exit ((a+0) > (b+0) || (as+0) > (bs+0)) ? 0 : 1 }'; then
      REGEN_OK=1
      break
    fi
  fi
  if ! kill -0 "$WATCH_PID" 2>/dev/null; then
    echo "watch serve died before regenerate"
    cat "$WATCH_LOG" || true
    exit 1
  fi
  sleep 0.2
done

cleanup_watch
WATCH_PID=""
trap - EXIT

if [ "$REGEN_OK" != "1" ]; then
  echo "watch did not regenerate within 5s"
  echo "--- watch-serve.log ---"
  cat "$WATCH_LOG" || true
  exit 1
fi

# server is killed; use last captured after files
test -s out/watch-after.json
test -s out/watch-after-health.json
AFTER_TOTAL="$(node -e 'const d=require("./out/watch-after.json"); if(typeof d.totalUsd!=="number") process.exit(1); process.stdout.write(String(d.totalUsd));')"
AFTER_SPANS="$(node -e 'const d=require("./out/watch-after-health.json"); if(typeof d.spanCount!=="number") process.exit(1); process.stdout.write(String(d.spanCount));')"
echo "watch_after totalUsd=$AFTER_TOTAL spanCount=$AFTER_SPANS"
export BEFORE_TOTAL AFTER_TOTAL BEFORE_SPANS AFTER_SPANS
node -e '
const b=Number(process.env.BEFORE_TOTAL);
const a=Number(process.env.AFTER_TOTAL);
const bs=Number(process.env.BEFORE_SPANS);
const as=Number(process.env.AFTER_SPANS);
if (!(a > b || as > bs)) {
  console.error("expected higher totalUsd or spanCount", { beforeTotal: b, afterTotal: a, beforeSpans: bs, afterSpans: as });
  process.exit(1);
}
if (!(as > bs)) {
  console.error("expected spanCount to increase", { beforeSpans: bs, afterSpans: as });
  process.exit(1);
}
console.log("watch_reload_ok", { beforeTotal: b, afterTotal: a, beforeSpans: bs, afterSpans: as });
'
if ! grep -q regenerated "$WATCH_LOG"; then
  echo "watch regenerate detected via HTTP but missing regenerated log line"
  cat "$WATCH_LOG" || true
  exit 1
fi
grep -q "watching" "$WATCH_LOG"
echo "watch regenerate OK"

echo "==> [tenant-budget] isolated serve --tenant-budget acme=0.0001 (example spans; curl JSON budgetBreaches)"
TB_PORT="${TB_PORT:-8824}"
TB_LOG="$ROOT/out/tb-serve.log"
rm -f "$TB_LOG" out/tb-report.json out/tb-costs.json out/tb-report.h out/tb-budgets.json out/tb-budgets.h
unset OTEL_AI_COST_CORS_ORIGINS || true
unset OTEL_AI_COST_TENANT_BUDGETS TENANT_BUDGETS || true
unset RATE_LIMIT_PER_MINUTE RATE_LIMIT_RPM || true
node src/cli.js serve --port "$TB_PORT" --in examples/spans.json --tenant-budget "acme=0.0001" >"$TB_LOG" 2>&1 &
TB_PID=$!
cleanup_tb() {
  if [ -n "${TB_PID:-}" ] && kill -0 "$TB_PID" 2>/dev/null; then
    kill "$TB_PID" 2>/dev/null || true
    wait "$TB_PID" 2>/dev/null || true
  fi
}
trap cleanup_tb EXIT
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$TB_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "tenant-budget serve did not become healthy"
    cat "$TB_LOG" || true
    exit 1
  fi
done
TB_CODE="$(curl -s -o out/tb-report.json -D out/tb-report.h -w "%{http_code}" "http://127.0.0.1:$TB_PORT/report.json")"
echo "tb_report_status=$TB_CODE"
test "$TB_CODE" = "200"
grep -qiE "^content-type:[[:space:]]*application/json" out/tb-report.h
curl -sf "http://127.0.0.1:$TB_PORT/v1/costs" -o out/tb-costs.json
node -e '
const d=require("./out/tb-report.json");
const c=require("./out/tb-costs.json");
if(!Array.isArray(d.budgetBreaches) || !d.budgetBreaches.some((b)=>b.tenant==="acme" && Number(b.usd)>Number(b.budget))) {
  console.error("expected budgetBreaches acme", d.budgetBreaches, d.byTenant);
  process.exit(1);
}
const b=d.budgetBreaches.find((x)=>x.tenant==="acme");
if(!(Number(b.budget)===0.0001) || !Number.isFinite(Number(b.usd))) {
  console.error("bad acme breach", b);
  process.exit(1);
}
if(!Array.isArray(c.budgetBreaches) || !c.budgetBreaches.some((x)=>x.tenant==="acme")) {
  console.error("v1/costs missing budgetBreaches acme", c.budgetBreaches);
  process.exit(1);
}
if((d.budgetBreaches||[]).some((x)=>x.tenant==="_" )) {
  console.error("_ must not be gated without explicit budget", d.budgetBreaches);
  process.exit(1);
}
console.log("tenant_budget_http_ok", {tenant:b.tenant, usd:b.usd, budget:b.budget});
'
# CSV tenant column + html still work on this isolated server
TB_CSV="$(curl -s -o out/tb-costs.csv -w "%{http_code}" "http://127.0.0.1:$TB_PORT/v1/costs.csv")"
test "$TB_CSV" = "200"
grep -q "date,model,spanCount,usd" out/tb-costs.csv
grep -q "acme" out/tb-costs.csv
TB_HTML="$(curl -s -o out/tb-index.html -w "%{http_code}" "http://127.0.0.1:$TB_PORT/")"
test "$TB_HTML" = "200"
grep -q "<svg" out/tb-index.html
grep -q "TOTAL" out/tb-index.html
grep -q 'id="budget-remaining"' out/tb-index.html
grep -q "remaining" out/tb-index.html
grep -q "acme" out/tb-index.html
echo "remain-dash-ok"
TB_GHA="$(curl -s -o out/tb-costs.gha.txt -D out/tb-costs.gha.h -w "%{http_code}" "http://127.0.0.1:$TB_PORT/v1/costs.gha.txt")"
echo "tb_gha_status=$TB_GHA"
test "$TB_GHA" = "200"
grep -qiE "^content-type:[[:space:]]*text/plain" out/tb-costs.gha.h
grep -q "::error" out/tb-costs.gha.txt
grep -q "title=tenant/acme::" out/tb-costs.gha.txt
TB_GHA_Q="$(curl -s -o out/tb-costs-q.gha.txt -w "%{http_code}" "http://127.0.0.1:$TB_PORT/v1/costs?format=gha")"
test "$TB_GHA_Q" = "200"
cmp -s out/tb-costs.gha.txt out/tb-costs-q.gha.txt
TB_BUDGETS="$(curl -s -o out/tb-budgets.json -D out/tb-budgets.h -w "%{http_code}" "http://127.0.0.1:$TB_PORT/v1/budgets")"
echo "tb_budgets_status=$TB_BUDGETS"
test "$TB_BUDGETS" = "200"
grep -qiE "^content-type:[[:space:]]*application/json" out/tb-budgets.h
grep -qiE "^x-request-id:" out/tb-budgets.h
node -e '
const d=require("./out/tb-budgets.json");
if(d.ok!==true) { console.error("expected ok:true", d); process.exit(1); }
if(d.globalUsd!==null) { console.error("this isolate has no --budget", d); process.exit(1); }
if(Number(d.tenants && d.tenants.acme)!==0.0001) { console.error("expected tenants.acme=0.0001", d); process.exit(1); }
if("token" in d || "secret" in d || JSON.stringify(d).includes("sk-")) { console.error("secrets leaked", d); process.exit(1); }
console.log("tenant_budget_thresholds_ok", d);
'
cleanup_tb
TB_PID=""
trap - EXIT
echo "==> [tenant-budget] curl JSON budgetBreaches acme + GHA ::error + /v1/budgets OK (isolated); HTML remaining table present

echo "==> [budgets] isolated serve --tenant-budget acme=10 (GET /v1/budgets 200; thresholds not spend)"
BUDGETS_PORT="${BUDGETS_PORT:-8830}"
BUDGETS_LOG="$ROOT/out/budgets-serve.log"
rm -f "$BUDGETS_LOG" out/iso-budgets.json out/iso-budgets.h
unset OTEL_AI_COST_CORS_ORIGINS || true
unset OTEL_AI_COST_TENANT_BUDGETS TENANT_BUDGETS || true
unset RATE_LIMIT_PER_MINUTE RATE_LIMIT_RPM || true
node src/cli.js serve --port "$BUDGETS_PORT" --in examples/spans.json --tenant-budget "acme=10" >"$BUDGETS_LOG" 2>&1 &
BUDGETS_PID=$!
cleanup_budgets() {
  if [ -n "${BUDGETS_PID:-}" ] && kill -0 "$BUDGETS_PID" 2>/dev/null; then
    kill "$BUDGETS_PID" 2>/dev/null || true
    wait "$BUDGETS_PID" 2>/dev/null || true
  fi
}
trap cleanup_budgets EXIT
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$BUDGETS_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "budgets serve did not become healthy"
    cat "$BUDGETS_LOG" || true
    exit 1
  fi
done
ISO_BUDGETS="$(curl -s -o out/iso-budgets.json -D out/iso-budgets.h -w "%{http_code}" "http://127.0.0.1:$BUDGETS_PORT/v1/budgets" -H "X-Request-Id: mvp-budgets-iso-e1")"
echo "iso_budgets_status=$ISO_BUDGETS"
test "$ISO_BUDGETS" = "200"
grep -qiE "^content-type:[[:space:]]*application/json" out/iso-budgets.h
grep -qiE "^x-request-id:[[:space:]]*mvp-budgets-iso-e1" out/iso-budgets.h
node -e '
const d=require("./out/iso-budgets.json");
if(d.ok!==true) { console.error("expected ok:true", d); process.exit(1); }
if(d.globalUsd!==null) { console.error("no --budget on this isolate", d); process.exit(1); }
if(Number(d.tenants && d.tenants.acme)!==10) { console.error("expected tenants.acme=10", d); process.exit(1); }
if("token" in d || "secret" in d || JSON.stringify(d).includes("sk-")) { console.error("secrets leaked", d); process.exit(1); }
console.log("iso_budgets_acme10_ok", d);
'
ISO_TENANTS="$(curl -s -o out/iso-tenants.json -D out/iso-tenants.h -w "%{http_code}" "http://127.0.0.1:$BUDGETS_PORT/v1/tenants" -H "X-Request-Id: mvp-tenants-iso-e1")"
echo "iso_tenants_status=$ISO_TENANTS"
test "$ISO_TENANTS" = "200"
node -e '
const d=require("./out/iso-tenants.json");
if(d.ok!==true) { console.error("expected ok:true", d); process.exit(1); }
const acme=(d.tenants||[]).find((t)=>t.id==="acme");
if(!acme || Number(acme.budgetUsd)!==10) { console.error("expected acme budgetUsd=10", d); process.exit(1); }
const other=(d.tenants||[]).find((t)=>t.id!=="acme");
if(other && "budgetUsd" in other) { console.error("non-acme must omit budgetUsd", other); process.exit(1); }
console.log("iso_tenants_budgetUsd_ok", {count:d.count, acme});
'
cleanup_budgets
BUDGETS_PID=""
trap - EXIT
echo "==> [budgets] isolated --tenant-budget acme=10 curl 200 OK"

echo "==> [ingest] isolated serve POST /v1/traces (empty file; do not pollute main 8792 store)"
INGEST_PORT="${INGEST_PORT:-8827}"
INGEST_SPANS="$ROOT/out/ingest-empty-spans.json"
INGEST_LOG="$ROOT/out/ingest-serve.log"
printf '[]\n' > "$INGEST_SPANS"
rm -f "$INGEST_LOG" out/ingest-csv-before.csv out/ingest-csv-after.csv out/ingest-post.json out/ingest-post.h out/ingest-costs.json
unset OTEL_AI_COST_CORS_ORIGINS || true
unset INGEST_TOKEN || true
unset RATE_LIMIT_PER_MINUTE RATE_LIMIT_RPM || true
node src/cli.js serve --port "$INGEST_PORT" --in "$INGEST_SPANS" >"$INGEST_LOG" 2>&1 &
INGEST_PID=$!
cleanup_ingest() {
  if [ -n "${INGEST_PID:-}" ] && kill -0 "$INGEST_PID" 2>/dev/null; then
    kill "$INGEST_PID" 2>/dev/null || true
    wait "$INGEST_PID" 2>/dev/null || true
  fi
  if [ -n "${INGEST_TOK_PID:-}" ] && kill -0 "$INGEST_TOK_PID" 2>/dev/null; then
    kill "$INGEST_TOK_PID" 2>/dev/null || true
    wait "$INGEST_TOK_PID" 2>/dev/null || true
  fi
}
trap cleanup_ingest EXIT
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$INGEST_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "ingest serve did not become healthy"
    cat "$INGEST_LOG" || true
    exit 1
  fi
done

CSV_BEFORE="$(curl -s -o out/ingest-csv-before.csv -w "%{http_code}" "http://127.0.0.1:$INGEST_PORT/v1/costs.csv")"
test "$CSV_BEFORE" = "200"
grep -q "date,model,spanCount,usd" out/ingest-csv-before.csv
BEFORE_ROWS="$(grep -cvE '^(date,|#|TOTAL|$)' out/ingest-csv-before.csv || true)"

UNSIGNED="$(curl -s -o out/ingest-post.json -D out/ingest-post.h -w "%{http_code}" \
  -X POST "http://127.0.0.1:$INGEST_PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{"resourceSpans":[{"scopeSpans":[{"spans":[{"name":"chat.completions","timestamp":"2024-08-15T00:00:00.000Z","attributes":[{"key":"gen_ai.request.model","value":{"stringValue":"gpt-4o"}},{"key":"gen_ai.usage.input_tokens","value":{"intValue":"2000"}},{"key":"gen_ai.usage.output_tokens","value":{"intValue":"800"}},{"key":"tenant","value":{"stringValue":"acme"}}]}]}]}]}')"
echo "ingest_unsigned_status=$UNSIGNED body=$(cat out/ingest-post.json)"
test "$UNSIGNED" = "200"
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' out/ingest-post.json
grep -Eq '"accepted"[[:space:]]*:[[:space:]]*1' out/ingest-post.json

CSV_AFTER="$(curl -s -o out/ingest-csv-after.csv -w "%{http_code}" "http://127.0.0.1:$INGEST_PORT/v1/costs.csv")"
test "$CSV_AFTER" = "200"
grep -q "date,model,spanCount,usd" out/ingest-csv-after.csv
grep -q "gpt-4o" out/ingest-csv-after.csv
grep -q "acme" out/ingest-csv-after.csv
AFTER_ROWS="$(grep -cvE '^(date,|#|TOTAL|$)' out/ingest-csv-after.csv || true)"
echo "ingest_csv_rows before=$BEFORE_ROWS after=$AFTER_ROWS"
test "$AFTER_ROWS" -gt "$BEFORE_ROWS"

curl -sf "http://127.0.0.1:$INGEST_PORT/v1/costs" -o out/ingest-costs.json
node -e '
const d=require("./out/ingest-costs.json");
const acme=(d.byTenant||[]).find((t)=>t.tenant==="acme");
if(!acme || !(Number(acme.usd)>0)) { console.error("missing byTenant acme", d.byTenant); process.exit(1); }
if(!(d.byModel && Number(d.byModel["gpt-4o"])>0)) { console.error("missing byModel gpt-4o", d.byModel); process.exit(1); }
console.log("ingest_costs_ok", {acmeUsd:acme.usd, gpt4o:d.byModel["gpt-4o"]});
'

EMPTY="$(curl -s -o out/ingest-empty.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$INGEST_PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{"spans":[]}')"
test "$EMPTY" = "200"
grep -Eq '"accepted"[[:space:]]*:[[:space:]]*0' out/ingest-empty.json

BAD="$(curl -s -o out/ingest-bad.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$INGEST_PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d "{not json")"
echo "ingest_bad_status=$BAD"
test "$BAD" = "400"
grep -q "bad_json" out/ingest-bad.json

cleanup_ingest
INGEST_PID=""

echo "==> [ingest] isolated --ingest-token (401 without bearer; 200 with bearer)"
INGEST_TOK_PORT="${INGEST_TOK_PORT:-8828}"
INGEST_TOK_LOG="$ROOT/out/ingest-token-serve.log"
INGEST_TOK_SPANS="$ROOT/out/ingest-token-spans.json"
printf '[]\n' > "$INGEST_TOK_SPANS"
rm -f "$INGEST_TOK_LOG" out/ingest-401.json out/ingest-401.h out/ingest-tok-ok.json
unset INGEST_TOKEN || true
node src/cli.js serve --port "$INGEST_TOK_PORT" --in "$INGEST_TOK_SPANS" \
  --ingest-token "whsec_ingest_mvp" >"$INGEST_TOK_LOG" 2>&1 &
INGEST_TOK_PID=$!
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$INGEST_TOK_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "ingest-token serve did not become healthy"
    cat "$INGEST_TOK_LOG" || true
    exit 1
  fi
done
NOBEARER="$(curl -s -o out/ingest-401.json -D out/ingest-401.h -w "%{http_code}" \
  -X POST "http://127.0.0.1:$INGEST_TOK_PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{"spans":[]}')"
echo "ingest_no_bearer_status=$NOBEARER body=$(cat out/ingest-401.json)"
test "$NOBEARER" = "401"
grep -q "unauthorized" out/ingest-401.json
if grep -q "whsec_ingest_mvp" out/ingest-401.json; then
  echo "401 must not leak ingest token"
  exit 1
fi
# health still 200 without bearer
TOK_HEALTH="$(curl -s -o out/ingest-tok-health.json -w "%{http_code}" "http://127.0.0.1:$INGEST_TOK_PORT/health")"
test "$TOK_HEALTH" = "200"
WITHBEARER="$(curl -s -o out/ingest-tok-ok.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$INGEST_TOK_PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer whsec_ingest_mvp" \
  -d '{"spans":[]}')"
echo "ingest_with_bearer_status=$WITHBEARER"
test "$WITHBEARER" = "200"
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' out/ingest-tok-ok.json
cleanup_ingest
INGEST_TOK_PID=""
trap - EXIT
echo "==> [ingest] unsigned 200 + CSV new row; token 401 without bearer OK (isolated)"

echo "==> [span-max] isolated serve --span-max 2 (POST 3 tiny spans; drop oldest; GET costs spanCount=2)"
SPAN_MAX_PORT="${SPAN_MAX_PORT:-8829}"
SPAN_MAX_SPANS="$ROOT/out/span-max-empty.json"
SPAN_MAX_LOG="$ROOT/out/span-max-serve.log"
printf '[]\n' > "$SPAN_MAX_SPANS"
rm -f "$SPAN_MAX_LOG" out/span-max-post.json out/span-max-costs.json out/span-max-health.json out/span-max-csv.csv
unset OTEL_AI_COST_CORS_ORIGINS || true
unset INGEST_TOKEN || true
unset SPAN_MAX || true
unset RATE_LIMIT_PER_MINUTE RATE_LIMIT_RPM || true
node src/cli.js serve --port "$SPAN_MAX_PORT" --in "$SPAN_MAX_SPANS" --span-max 2 >"$SPAN_MAX_LOG" 2>&1 &
SPAN_MAX_PID=$!
cleanup_span_max() {
  if [ -n "${SPAN_MAX_PID:-}" ] && kill -0 "$SPAN_MAX_PID" 2>/dev/null; then
    kill "$SPAN_MAX_PID" 2>/dev/null || true
    wait "$SPAN_MAX_PID" 2>/dev/null || true
  fi
}
trap cleanup_span_max EXIT
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$SPAN_MAX_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "span-max serve did not become healthy"
    cat "$SPAN_MAX_LOG" || true
    exit 1
  fi
done

SPAN_POST="$(curl -s -o out/span-max-post.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$SPAN_MAX_PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{"spans":[{"timestamp":"2024-08-15T00:00:00.000Z","attributes":{"gen_ai.request.model":"gpt-4o-mini","gen_ai.usage.input_tokens":1,"gen_ai.usage.output_tokens":1,"tenant":"old"}},{"timestamp":"2024-08-15T01:00:00.000Z","attributes":{"gen_ai.request.model":"gpt-4o-mini","gen_ai.usage.input_tokens":1,"gen_ai.usage.output_tokens":1,"tenant":"mid"}},{"timestamp":"2024-08-15T02:00:00.000Z","attributes":{"gen_ai.request.model":"gpt-4o-mini","gen_ai.usage.input_tokens":1,"gen_ai.usage.output_tokens":1,"tenant":"new"}}]}')"
echo "span_max_post_status=$SPAN_POST body=$(cat out/span-max-post.json)"
test "$SPAN_POST" = "200"
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' out/span-max-post.json
grep -Eq '"accepted"[[:space:]]*:[[:space:]]*3' out/span-max-post.json

curl -sf "http://127.0.0.1:$SPAN_MAX_PORT/v1/costs" -o out/span-max-costs.json
curl -sf "http://127.0.0.1:$SPAN_MAX_PORT/health" -o out/span-max-health.json
curl -sf "http://127.0.0.1:$SPAN_MAX_PORT/v1/costs.csv" -o out/span-max-csv.csv
node -e '
const d=require("./out/span-max-costs.json");
const h=require("./out/span-max-health.json");
const n = Array.isArray(d.rows) ? d.rows.length : 0;
const days = (d.days || []).reduce((a, x) => a + Number(x.spanCount || 0), 0);
const tenants = (d.byTenant || []).map((t) => t.tenant);
if (h.spanCount !== 2) {
  console.error("health spanCount expected 2", h);
  process.exit(1);
}
if (n !== 2) {
  console.error("GET /v1/costs spanCount/rows expected 2", { n, days, tenants, d });
  process.exit(1);
}
if (days !== 2) {
  console.error("GET /v1/costs days spanCount expected 2", { days, tenants });
  process.exit(1);
}
if (tenants.includes("old") || !tenants.includes("mid") || !tenants.includes("new")) {
  console.error("oldest tenant old should be dropped", tenants);
  process.exit(1);
}
console.log("span_max_costs_ok", { spanCount: n, tenants });
'
grep -q "date,model,spanCount,usd" out/span-max-csv.csv
grep -q "mid" out/span-max-csv.csv
grep -q "new" out/span-max-csv.csv
if grep -q "old" out/span-max-csv.csv; then
  echo "span-max CSV still has oldest tenant old"
  cat out/span-max-csv.csv
  exit 1
fi
grep -q "spanMax=2" "$SPAN_MAX_LOG"
cleanup_span_max
SPAN_MAX_PID=""
trap - EXIT
echo "==> [span-max] accepted=3 retained=2 oldest dropped OK (isolated); main demo 6 spans unchanged"

echo "==> [config] isolated serve --webhook-url/--webhook-secret (GET /v1/config 200; secret not leaked)"
CFG_ISO_PORT="${CFG_ISO_PORT:-8831}"
CFG_ISO_LOG="$ROOT/out/config-iso-serve.log"
CFG_ISO_SECRET="http_whsec_must_not_leak"
CFG_ISO_URL="http://127.0.0.1:9/hook?token=http_url_token_must_not_leak"
rm -f "$CFG_ISO_LOG" out/iso-config.json out/iso-config.h
unset OTEL_AI_COST_CORS_ORIGINS || true
unset OTEL_AI_COST_WEBHOOK_URL OTEL_AI_COST_WEBHOOK_SECRET || true
unset OTEL_AI_COST_TENANT_BUDGETS TENANT_BUDGETS || true
unset RATE_LIMIT_PER_MINUTE RATE_LIMIT_RPM || true
node src/cli.js serve --port "$CFG_ISO_PORT" --in examples/spans.json \
  --webhook-url "$CFG_ISO_URL" --webhook-secret "$CFG_ISO_SECRET" \
  --cors-origins "http://localhost:3000" --tenant-budget "acme=10" --span-max 100 \
  >"$CFG_ISO_LOG" 2>&1 &
CFG_ISO_PID=$!
cleanup_cfg_iso() {
  if [ -n "${CFG_ISO_PID:-}" ] && kill -0 "$CFG_ISO_PID" 2>/dev/null; then
    kill "$CFG_ISO_PID" 2>/dev/null || true
    wait "$CFG_ISO_PID" 2>/dev/null || true
  fi
}
trap cleanup_cfg_iso EXIT
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$CFG_ISO_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "config isolate serve did not become healthy"
    cat "$CFG_ISO_LOG" || true
    exit 1
  fi
done
ISO_CFG="$(curl -s -o out/iso-config.json -D out/iso-config.h -w "%{http_code}" \
  "http://127.0.0.1:$CFG_ISO_PORT/v1/config" -H "X-Request-Id: mvp-config-iso-e1")"
echo "iso_config_status=$ISO_CFG"
test "$ISO_CFG" = "200"
grep -qiE "^content-type:[[:space:]]*application/json" out/iso-config.h
grep -qiE "^x-request-id:[[:space:]]*mvp-config-iso-e1" out/iso-config.h
CFG_ISO_SECRET="$CFG_ISO_SECRET" node -e '
const d=require("./out/iso-config.json");
const secret=process.env.CFG_ISO_SECRET;
if(d.ok!==true) { console.error("expected ok:true", d); process.exit(1); }
if(d.spanCap==null && !((d.cors||{}).origins)) { console.error("expected spanCap or cors", d); process.exit(1); }
if((d.webhooks||{}).hasUrl!==true || (d.webhooks||{}).hasSecret!==true) { console.error("expected webhook booleans true", d); process.exit(1); }
if(d.tenantBudgetCount!==1) { console.error("expected tenantBudgetCount 1", d); process.exit(1); }
if(d.hasGlobalBudget!==false) { console.error("no --budget on isolate", d); process.exit(1); }
const blob=JSON.stringify(d);
if(blob.includes(secret) || blob.includes("http_url_token_must_not_leak") || blob.includes("127.0.0.1:9") || blob.includes("webhookUrl") || blob.includes("webhookSecret") || blob.includes("whsec_")) {
  console.error("isolated config leaked webhook", d); process.exit(1);
}
console.log("iso_config_redacted_ok", {spanCap:d.spanCap, hasUrl:d.webhooks.hasUrl, hasSecret:d.webhooks.hasSecret});
'
cleanup_cfg_iso
CFG_ISO_PID=""
trap - EXIT
echo "==> [config] isolated webhook not leaked OK"

echo "==> [ingest-deny-webhook] isolated over-budget ingest (no URL → 200 denied:1; mock receiver POST)"
INGEST_DENY_NOWH_PORT="${INGEST_DENY_NOWH_PORT:-8842}"
INGEST_DENY_WH_PORT="${INGEST_DENY_WH_PORT:-8843}"
INGEST_DENY_PORT="${INGEST_DENY_PORT:-8844}"
INGEST_DENY_SPANS="$ROOT/out/ingest-deny-spans.json"
INGEST_DENY_NOWH_LOG="$ROOT/out/ingest-deny-nowh-serve.log"
INGEST_DENY_LOG="$ROOT/out/ingest-deny-serve.log"
INGEST_DENY_WH_OUT="$ROOT/out/ingest-deny-webhook-last.json"
INGEST_DENY_WH_HDR="$ROOT/out/ingest-deny-webhook-last.headers.json"
INGEST_DENY_WH_LOG="$ROOT/out/ingest-deny-webhook.log"
rm -f "$INGEST_DENY_NOWH_LOG" "$INGEST_DENY_LOG" "$INGEST_DENY_WH_OUT" "$INGEST_DENY_WH_HDR" "$INGEST_DENY_WH_LOG" \
  out/ingest-deny-nowh.json out/ingest-deny-post.json
printf '%s\n' '[{"timestamp":"2024-08-11T12:00:00.000Z","attributes":{"gen_ai.request.model":"gpt-4o","gen_ai.usage.input_tokens":5000,"gen_ai.usage.output_tokens":1000,"tenant":"acme"}}]' > "$INGEST_DENY_SPANS"
unset OTEL_AI_COST_WEBHOOK_URL OTEL_AI_COST_WEBHOOK_SECRET || true
unset OTEL_AI_COST_TENANT_BUDGETS TENANT_BUDGETS || true
unset INGEST_TOKEN RATE_LIMIT_PER_MINUTE RATE_LIMIT_RPM || true

node src/cli.js serve --port "$INGEST_DENY_NOWH_PORT" --in "$INGEST_DENY_SPANS" \
  --tenant-budget "acme=0.01" >"$INGEST_DENY_NOWH_LOG" 2>&1 &
INGEST_DENY_NOWH_PID=$!
cleanup_ingest_deny_nowh() {
  if [ -n "${INGEST_DENY_NOWH_PID:-}" ] && kill -0 "$INGEST_DENY_NOWH_PID" 2>/dev/null; then
    kill "$INGEST_DENY_NOWH_PID" 2>/dev/null || true
    wait "$INGEST_DENY_NOWH_PID" 2>/dev/null || true
  fi
}
trap cleanup_ingest_deny_nowh EXIT
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$INGEST_DENY_NOWH_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "ingest-deny no-webhook serve did not become healthy"
    cat "$INGEST_DENY_NOWH_LOG" || true
    exit 1
  fi
done
NOWH="$(curl -s -o out/ingest-deny-nowh.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$INGEST_DENY_NOWH_PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{"spans":[{"timestamp":"2024-08-18T00:00:00.000Z","attributes":{"gen_ai.request.model":"gpt-4o-mini","gen_ai.usage.input_tokens":10,"gen_ai.usage.output_tokens":5,"tenant":"acme","gen_ai.prompt":"SECRET_PROMPT_DENY"}}]}')"
echo "ingest_deny_nowh_status=$NOWH body=$(cat out/ingest-deny-nowh.json)"
test "$NOWH" = "200"
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' out/ingest-deny-nowh.json
grep -Eq '"denied"[[:space:]]*:[[:space:]]*1' out/ingest-deny-nowh.json
cleanup_ingest_deny_nowh
INGEST_DENY_NOWH_PID=""
trap - EXIT

node mock-webhook-receiver.js --port "$INGEST_DENY_WH_PORT" --out "$INGEST_DENY_WH_OUT" \
  --headers-out "$INGEST_DENY_WH_HDR" --secret "whsec_ingest_deny_mvp" >"$INGEST_DENY_WH_LOG" 2>&1 &
INGEST_DENY_WH_PID=$!
node src/cli.js serve --port "$INGEST_DENY_PORT" --in "$INGEST_DENY_SPANS" \
  --tenant-budget "acme=0.01" \
  --webhook-url "http://127.0.0.1:${INGEST_DENY_WH_PORT}/hook" \
  --webhook-secret "whsec_ingest_deny_mvp" >"$INGEST_DENY_LOG" 2>&1 &
INGEST_DENY_PID=$!
cleanup_ingest_deny() {
  if [ -n "${INGEST_DENY_PID:-}" ] && kill -0 "$INGEST_DENY_PID" 2>/dev/null; then
    kill "$INGEST_DENY_PID" 2>/dev/null || true
    wait "$INGEST_DENY_PID" 2>/dev/null || true
  fi
  if [ -n "${INGEST_DENY_WH_PID:-}" ] && kill -0 "$INGEST_DENY_WH_PID" 2>/dev/null; then
    kill "$INGEST_DENY_WH_PID" 2>/dev/null || true
    wait "$INGEST_DENY_WH_PID" 2>/dev/null || true
  fi
}
trap cleanup_ingest_deny EXIT
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$INGEST_DENY_WH_PORT/health" >/dev/null \
    && curl -sf "http://127.0.0.1:$INGEST_DENY_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "ingest-deny webhook serve did not become healthy"
    cat "$INGEST_DENY_WH_LOG" || true
    cat "$INGEST_DENY_LOG" || true
    exit 1
  fi
done
DENY_WH="$(curl -s -o out/ingest-deny-post.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$INGEST_DENY_PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{"spans":[{"timestamp":"2024-08-18T00:00:00.000Z","attributes":{"gen_ai.request.model":"gpt-4o-mini","gen_ai.usage.input_tokens":10,"gen_ai.usage.output_tokens":5,"tenant":"acme","gen_ai.prompt":"SECRET_PROMPT_DENY"}}]}')"
echo "ingest_deny_webhook_status=$DENY_WH body=$(cat out/ingest-deny-post.json)"
test "$DENY_WH" = "200"
grep -Eq '"denied"[[:space:]]*:[[:space:]]*1' out/ingest-deny-post.json
test -s "$INGEST_DENY_WH_OUT"
node -e '
const fs=require("fs");
const d=JSON.parse(fs.readFileSync("out/ingest-deny-webhook-last.json","utf8"));
const meta=JSON.parse(fs.readFileSync("out/ingest-deny-webhook-last.headers.json","utf8"));
const blob=JSON.stringify(d);
if(d.ok!==false || d.tenant!=="acme" || !(Number(d.spend)>0.01) || Number(d.budget)!==0.01 || Number(d.denied)!==1) {
  console.error("ingest deny webhook payload", d); process.exit(1);
}
if(blob.includes("SECRET_PROMPT_DENY") || blob.includes("gen_ai.prompt")) {
  console.error("ingest deny webhook leaked prompt", d); process.exit(1);
}
if(meta.verified!==true || !meta.timestamp) {
  console.error("ingest deny webhook HMAC/timestamp", meta); process.exit(1);
}
console.log("ingest_deny_webhook_ok", {tenant:d.tenant, spend:d.spend, budget:d.budget, denied:d.denied});
'
cleanup_ingest_deny
INGEST_DENY_PID=""
INGEST_DENY_WH_PID=""
trap - EXIT
echo "==> [ingest-deny-webhook] isolated mock receiver POST + no-URL 200 denied:1 OK"

echo "==> [would-exceed] tenant just under budget; incoming that would cross is denied (spend unchanged + webhook)"
WOULD_PORT="${WOULD_PORT:-8845}"
WOULD_WH_PORT="${WOULD_WH_PORT:-8846}"
WOULD_SPANS="$ROOT/out/would-exceed-spans.json"
WOULD_LOG="$ROOT/out/would-exceed-serve.log"
WOULD_WH_OUT="$ROOT/out/would-exceed-webhook-last.json"
WOULD_WH_HDR="$ROOT/out/would-exceed-webhook-last.headers.json"
WOULD_WH_LOG="$ROOT/out/would-exceed-webhook.log"
rm -f "$WOULD_LOG" "$WOULD_WH_OUT" "$WOULD_WH_HDR" "$WOULD_WH_LOG" \
  out/would-exceed-post.json out/would-exceed-costs-before.json out/would-exceed-costs-after.json
# gpt-4o-mini 1000 in / 0 out = $0.000150; budget $0.000200 (just under)
printf '%s\n' '[{"timestamp":"2024-08-18T00:00:00.000Z","attributes":{"gen_ai.request.model":"gpt-4o-mini","gen_ai.usage.input_tokens":1000,"gen_ai.usage.output_tokens":0,"tenant":"acme"}}]' > "$WOULD_SPANS"
unset OTEL_AI_COST_WEBHOOK_URL OTEL_AI_COST_WEBHOOK_SECRET || true
unset OTEL_AI_COST_TENANT_BUDGETS TENANT_BUDGETS || true
unset INGEST_TOKEN RATE_LIMIT_PER_MINUTE RATE_LIMIT_RPM DENY_ON_WOULD_EXCEED BUDGET_PERIOD OTEL_AI_COST_BUDGET_PERIOD || true

node mock-webhook-receiver.js --port "$WOULD_WH_PORT" --out "$WOULD_WH_OUT" \
  --headers-out "$WOULD_WH_HDR" --secret "whsec_would_exceed_mvp" >"$WOULD_WH_LOG" 2>&1 &
WOULD_WH_PID=$!
node src/cli.js serve --port "$WOULD_PORT" --in "$WOULD_SPANS" \
  --tenant-budget "acme=0.0002" \
  --webhook-url "http://127.0.0.1:${WOULD_WH_PORT}/hook" \
  --webhook-secret "whsec_would_exceed_mvp" >"$WOULD_LOG" 2>&1 &
WOULD_PID=$!
cleanup_would() {
  if [ -n "${WOULD_PID:-}" ] && kill -0 "$WOULD_PID" 2>/dev/null; then
    kill "$WOULD_PID" 2>/dev/null || true
    wait "$WOULD_PID" 2>/dev/null || true
  fi
  if [ -n "${WOULD_WH_PID:-}" ] && kill -0 "$WOULD_WH_PID" 2>/dev/null; then
    kill "$WOULD_WH_PID" 2>/dev/null || true
    wait "$WOULD_WH_PID" 2>/dev/null || true
  fi
}
trap cleanup_would EXIT
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$WOULD_WH_PORT/health" >/dev/null \
    && curl -sf "http://127.0.0.1:$WOULD_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "would-exceed serve did not become healthy"
    cat "$WOULD_WH_LOG" || true
    cat "$WOULD_LOG" || true
    exit 1
  fi
done
curl -sf "http://127.0.0.1:$WOULD_PORT/v1/costs" -o out/would-exceed-costs-before.json
WOULD_POST="$(curl -s -o out/would-exceed-post.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$WOULD_PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{"spans":[{"timestamp":"2024-08-18T01:00:00.000Z","attributes":{"gen_ai.request.model":"gpt-4o-mini","gen_ai.usage.input_tokens":1000,"gen_ai.usage.output_tokens":0,"tenant":"acme","gen_ai.prompt":"SECRET_PROMPT_WOULD_EXCEED"}}]}')"
echo "would_exceed_status=$WOULD_POST body=$(cat out/would-exceed-post.json)"
test "$WOULD_POST" = "200"
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' out/would-exceed-post.json
grep -Eq '"denied"[[:space:]]*:[[:space:]]*1' out/would-exceed-post.json
curl -sf "http://127.0.0.1:$WOULD_PORT/v1/costs" -o out/would-exceed-costs-after.json
test -s "$WOULD_WH_OUT"
node -e '
const fs=require("fs");
const before=JSON.parse(fs.readFileSync("out/would-exceed-costs-before.json","utf8"));
const after=JSON.parse(fs.readFileSync("out/would-exceed-costs-after.json","utf8"));
const hook=JSON.parse(fs.readFileSync("out/would-exceed-webhook-last.json","utf8"));
const meta=JSON.parse(fs.readFileSync("out/would-exceed-webhook-last.headers.json","utf8"));
const acmeB=(before.byTenant||[]).find((t)=>t.tenant==="acme");
const acmeA=(after.byTenant||[]).find((t)=>t.tenant==="acme");
if(!acmeB || Number(acmeB.usd)!==0.00015) { console.error("expected under-budget seed 0.00015", before.byTenant); process.exit(1); }
if(Number(acmeA && acmeA.usd)!==Number(acmeB.usd)) { console.error("spend must be unchanged", acmeB, acmeA); process.exit(1); }
const blob=JSON.stringify(hook);
if(hook.ok!==false || hook.tenant!=="acme" || Number(hook.denied)!==1 || Number(hook.budget)!==0.0002 || Number(hook.spend)!==Number(acmeB.usd)) {
  console.error("would-exceed webhook payload", hook); process.exit(1);
}
if(blob.includes("SECRET_PROMPT_WOULD_EXCEED") || blob.includes("gen_ai.prompt")) {
  console.error("would-exceed webhook leaked prompt", hook); process.exit(1);
}
if(meta.verified!==true || !meta.timestamp) {
  console.error("would-exceed webhook HMAC/timestamp", meta); process.exit(1);
}
console.log("would-exceed-ok", {spend:acmeA.usd, budget:hook.budget, denied:hook.denied});
'
cleanup_would
WOULD_PID=""
WOULD_WH_PID=""
trap - EXIT
echo "==> [would-exceed] isolated deny + spend unchanged + webhook OK"

echo "==> [cost-attr] one span with gen_ai.cost.usd; spend matches attribute (not token math)"
ATTR_PORT="${ATTR_PORT:-8847}"
ATTR_SPANS="$ROOT/out/cost-attr-spans.json"
ATTR_LOG="$ROOT/out/cost-attr-serve.log"
rm -f "$ATTR_LOG" out/cost-attr-post.json out/cost-attr-costs.json
# gpt-4o-mini 1000 in / 0 out = $0.000150; attribute is $1.23
printf '%s\n' '[]' > "$ATTR_SPANS"
unset OTEL_AI_COST_WEBHOOK_URL OTEL_AI_COST_WEBHOOK_SECRET || true
unset OTEL_AI_COST_TENANT_BUDGETS TENANT_BUDGETS || true
unset INGEST_TOKEN RATE_LIMIT_PER_MINUTE RATE_LIMIT_RPM DENY_ON_WOULD_EXCEED BUDGET_PERIOD OTEL_AI_COST_BUDGET_PERIOD || true
node src/cli.js serve --port "$ATTR_PORT" --in "$ATTR_SPANS" >"$ATTR_LOG" 2>&1 &
ATTR_PID=$!
cleanup_attr() {
  if [ -n "${ATTR_PID:-}" ] && kill -0 "$ATTR_PID" 2>/dev/null; then
    kill "$ATTR_PID" 2>/dev/null || true
    wait "$ATTR_PID" 2>/dev/null || true
  fi
}
trap cleanup_attr EXIT
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$ATTR_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "cost-attr serve did not become healthy"
    cat "$ATTR_LOG" || true
    exit 1
  fi
done
ATTR_POST="$(curl -s -o out/cost-attr-post.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$ATTR_PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{"spans":[{"timestamp":"2024-08-18T00:00:00.000Z","attributes":{"gen_ai.request.model":"gpt-4o-mini","gen_ai.usage.input_tokens":1000,"gen_ai.usage.output_tokens":0,"tenant":"acme","gen_ai.cost.usd":1.23}}]}')"
echo "cost_attr_status=$ATTR_POST body=$(cat out/cost-attr-post.json)"
test "$ATTR_POST" = "200"
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' out/cost-attr-post.json
curl -sf "http://127.0.0.1:$ATTR_PORT/v1/costs" -o out/cost-attr-costs.json
node -e '
const fs=require("fs");
const costs=JSON.parse(fs.readFileSync("out/cost-attr-costs.json","utf8"));
const acme=(costs.byTenant||[]).find((t)=>t.tenant==="acme");
if(Number(costs.totalUsd)!==1.23) { console.error("spend must match gen_ai.cost.usd=1.23 not token math 0.00015", costs); process.exit(1); }
if(!acme || Number(acme.usd)!==1.23) { console.error("acme spend must match gen_ai.cost.usd", acme); process.exit(1); }
console.log("cost-attr-ok", {totalUsd:costs.totalUsd, tenantUsd:acme.usd});
'
cleanup_attr
ATTR_PID=""
trap - EXIT
echo "==> [cost-attr] isolated ingest spend matches gen_ai.cost.usd OK"

echo "==> [export] ingest two tenants + GET /v1/tenants.csv header+rows"
EXPORT_PORT="${EXPORT_PORT:-8848}"
EXPORT_SPANS="$ROOT/out/export-spans.json"
EXPORT_LOG="$ROOT/out/export-serve.log"
printf '%s\n' '[]' > "$EXPORT_SPANS"
rm -f "$EXPORT_LOG" out/export-post.json out/export-tenants.csv out/export-tenants.json
unset OTEL_AI_COST_WEBHOOK_URL OTEL_AI_COST_WEBHOOK_SECRET || true
unset OTEL_AI_COST_TENANT_BUDGETS TENANT_BUDGETS || true
unset INGEST_TOKEN RATE_LIMIT_PER_MINUTE RATE_LIMIT_RPM DENY_ON_WOULD_EXCEED BUDGET_PERIOD OTEL_AI_COST_BUDGET_PERIOD || true
node src/cli.js serve --port "$EXPORT_PORT" --in "$EXPORT_SPANS" \
  --tenant-budget "acme=10,other=5" >"$EXPORT_LOG" 2>&1 &
EXPORT_PID=$!
cleanup_export() {
  if [ -n "${EXPORT_PID:-}" ] && kill -0 "$EXPORT_PID" 2>/dev/null; then
    kill "$EXPORT_PID" 2>/dev/null || true
    wait "$EXPORT_PID" 2>/dev/null || true
  fi
}
trap cleanup_export EXIT
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$EXPORT_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "export serve did not become healthy"
    cat "$EXPORT_LOG" || true
    exit 1
  fi
done
EXPORT_POST="$(curl -s -o out/export-post.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$EXPORT_PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{"spans":[{"timestamp":"2024-08-18T00:00:00.000Z","attributes":{"gen_ai.request.model":"gpt-4o-mini","tenant":"acme","gen_ai.cost.usd":1}},{"timestamp":"2024-08-18T00:00:01.000Z","attributes":{"gen_ai.request.model":"gpt-4o-mini","tenant":"other","gen_ai.cost.usd":2}}]}')"
echo "export_status=$EXPORT_POST body=$(cat out/export-post.json)"
test "$EXPORT_POST" = "200"
curl -sf "http://127.0.0.1:$EXPORT_PORT/v1/tenants" -o out/export-tenants.json
EXPORT_CSV_CODE="$(curl -s -o out/export-tenants.csv -D out/export-tenants-csv.h -w "%{http_code}" \
  "http://127.0.0.1:$EXPORT_PORT/v1/tenants.csv" -H "X-Request-Id: mvp-export-rid")"
test "$EXPORT_CSV_CODE" = "200"
grep -qiE "^content-type:[[:space:]]*text/csv" out/export-tenants-csv.h
node -e '
const fs=require("fs");
const json=JSON.parse(fs.readFileSync("out/export-tenants.json","utf8"));
const csv=fs.readFileSync("out/export-tenants.csv","utf8");
const lines=csv.trim().split("\n");
const ids=(json.tenants||[]).map((t)=>t.id);
if(json.ok!==true || json.count!==2 || !ids.includes("acme") || !ids.includes("other")) {
  console.error("export json tenants", json); process.exit(1);
}
if(lines[0]!=="tenant,spend_usd,budget_usd,remaining_usd,denied_count") {
  console.error("export csv header", lines[0]); process.exit(1);
}
if(lines.length!==3) { console.error("export csv rows", lines); process.exit(1); }
if(!lines.some((l)=>l.startsWith("acme,1.000000,10.000000,9.000000,"))) {
  console.error("export missing acme row", lines); process.exit(1);
}
if(!lines.some((l)=>l.startsWith("other,2.000000,5.000000,3.000000,"))) {
  console.error("export missing other row", lines); process.exit(1);
}
console.log("export-ok", {header:lines[0], rows:lines.length-1, tenants:ids});
'
cleanup_export
EXPORT_PID=""
trap - EXIT
echo "==> [export] isolated two-tenant CSV OK"


echo "==> [period] UTC-day window: old timestamp ignored, today counts, remaining/deny match"
PERIOD_PORT="${PERIOD_PORT:-8849}"
PERIOD_SPANS="$ROOT/out/period-spans.json"
PERIOD_LOG="$ROOT/out/period-serve.log"
printf '%s\n' '[]' > "$PERIOD_SPANS"
rm -f "$PERIOD_LOG" out/period-old.json out/period-today.json out/period-deny.json out/period-tenants.csv
unset OTEL_AI_COST_WEBHOOK_URL OTEL_AI_COST_WEBHOOK_SECRET || true
unset OTEL_AI_COST_TENANT_BUDGETS TENANT_BUDGETS || true
unset INGEST_TOKEN RATE_LIMIT_PER_MINUTE RATE_LIMIT_RPM DENY_ON_WOULD_EXCEED BUDGET_PERIOD OTEL_AI_COST_BUDGET_PERIOD || true
node src/cli.js serve --port "$PERIOD_PORT" --in "$PERIOD_SPANS" \
  --tenant-budget "acme=2" --budget-period day >"$PERIOD_LOG" 2>&1 &
PERIOD_PID=$!
cleanup_period() {
  if [ -n "${PERIOD_PID:-}" ] && kill -0 "$PERIOD_PID" 2>/dev/null; then
    kill "$PERIOD_PID" 2>/dev/null || true
    wait "$PERIOD_PID" 2>/dev/null || true
  fi
}
trap cleanup_period EXIT
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PERIOD_PORT/health" >/dev/null; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "period serve did not become healthy"
    cat "$PERIOD_LOG" || true
    exit 1
  fi
done
TODAY="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PERIOD_OLD="$(curl -s -o out/period-old.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$PERIOD_PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{"spans":[{"timestamp":"2024-01-15T12:00:00.000Z","attributes":{"gen_ai.request.model":"gpt-4o-mini","tenant":"acme","gen_ai.cost.usd":9}}]}')"
test "$PERIOD_OLD" = "200"
grep -Eq '"denied"[[:space:]]*:[[:space:]]*0' out/period-old.json
PERIOD_TODAY="$(curl -s -o out/period-today.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$PERIOD_PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d "{\"spans\":[{\"timestamp\":\"$TODAY\",\"attributes\":{\"gen_ai.request.model\":\"gpt-4o-mini\",\"tenant\":\"acme\",\"gen_ai.cost.usd\":1}}]}")"
test "$PERIOD_TODAY" = "200"
grep -Eq '"denied"[[:space:]]*:[[:space:]]*0' out/period-today.json
curl -sf "http://127.0.0.1:$PERIOD_PORT/v1/tenants.csv" -o out/period-tenants.csv
grep -q 'acme,1.000000,2.000000,1.000000,0' out/period-tenants.csv
PERIOD_DENY="$(curl -s -o out/period-deny.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$PERIOD_PORT/v1/traces" \
  -H "Content-Type: application/json" \
  -d "{\"spans\":[{\"timestamp\":\"$TODAY\",\"attributes\":{\"gen_ai.request.model\":\"gpt-4o-mini\",\"tenant\":\"acme\",\"gen_ai.cost.usd\":1.5}}]}")"
test "$PERIOD_DENY" = "200"
grep -Eq '"denied"[[:space:]]*:[[:space:]]*1' out/period-deny.json
curl -sf "http://127.0.0.1:$PERIOD_PORT/v1/tenants.csv" -o out/period-tenants.csv
grep -q 'acme,1.000000,2.000000,1.000000,1' out/period-tenants.csv
curl -sf "http://127.0.0.1:$PERIOD_PORT/" -o out/period-index.html
grep -q 'id="budget-remaining"' out/period-index.html
grep -q "period: UTC day" out/period-index.html
grep -q "remaining" out/period-index.html
echo "period-ok"
cleanup_period
PERIOD_PID=""
trap - EXIT
echo "==> [period] isolated UTC-day window OK"

echo "==> [otlp-demo] local OTLP ingest + tenant/budget metrics"
OTLP_DEMO_PORT="${OTLP_DEMO_PORT:-8841}" bash "$ROOT/scripts/otlp-demo.sh"

echo "e-otel-ai-cost local-mvp OK (report+serve+cors+request-id+openapi+metrics+webhook+hmac+watch+csv+md+gha+rate-limit+tenant+tenantBudget+budgets+models+config+otlpIngest+spanMax+ingestDenyWebhook+wouldExceed+costAttr+export+period+remainDash+otlpDemo)"
