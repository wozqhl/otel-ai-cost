/** Structured JSON HTTP access logs (opt-in). Default off so stack-demo greps stay stable. */

import fs from "node:fs";

export const ENV_LOG_FORMAT = "LOG_FORMAT";
export const SKIP_ACCESS_LOG_PATHS = ["/metrics", "/health", "/ready"];

/**
 * CLI `--log-json` / `--no-log-json` wins when provided; else env LOG_FORMAT=json.
 * Pass cliValue=undefined/null to read env. Default off.
 */
export function resolveLogJson(cliValue, env = process.env) {
  if (cliValue === true) return true;
  if (cliValue === false) return false;
  const raw = env && typeof env === "object" ? env[ENV_LOG_FORMAT] : "";
  return String(raw || "").trim().toLowerCase() === "json";
}

export function shouldSkipAccessLog(method, path) {
  if (String(method || "").toUpperCase() === "OPTIONS") return true;
  let p = String(path || "");
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  return SKIP_ACCESS_LOG_PATHS.includes(p);
}

/** One JSON object (no trailing newline). Does not log headers/bodies/secrets. */
export function formatAccessLog(fields = {}) {
  const rec = {
    ts: fields.ts || new Date().toISOString(),
    level: "info",
    msg: "http",
    service: fields.service || "",
    method: String(fields.method || "GET").toUpperCase(),
    path: fields.path || "/",
    status: Number(fields.status) || 0,
    durationMs: Number(fields.durationMs) || 0,
    requestId: fields.requestId == null ? "" : String(fields.requestId),
  };
  if (fields.bytesOut != null && Number.isFinite(Number(fields.bytesOut))) {
    rec.bytesOut = Number(fields.bytesOut);
  }
  if (fields.remote) rec.remote = String(fields.remote);
  return JSON.stringify(rec);
}

export function writeAccessLogLine(line) {
  const s = String(line).endsWith("\n") ? String(line) : `${line}\n`;
  try {
    fs.writeSync(1, s);
  } catch {
    console.log(String(line).replace(/\n$/, ""));
  }
}

/**
 * Emit one access line when the response completes (finish/close).
 * Skips OPTIONS, /metrics, /health, /ready. requestId must match the response header.
 */
export function attachAccessLog(req, res, { enabled, service, requestId, pathName } = {}) {
  if (!enabled) return;
  const t0 = process.hrtime.bigint();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const method = String(req?.method || "GET").toUpperCase();
    const path = pathName || "/";
    if (shouldSkipAccessLog(method, path)) return;
    const durationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - t0) / 1e6));
    const status = Number(res.statusCode) || 0;
    let bytesOut;
    const cl = typeof res.getHeader === "function" ? res.getHeader("content-length") : undefined;
    if (cl != null && cl !== "") {
      const n = Number(Array.isArray(cl) ? cl[0] : cl);
      if (Number.isFinite(n)) bytesOut = n;
    }
    const remote = req?.socket?.remoteAddress || "";
    writeAccessLogLine(
      formatAccessLog({
        service,
        method,
        path,
        status,
        durationMs,
        requestId,
        bytesOut,
        remote: remote || undefined,
      })
    );
  };
  res.on("finish", finish);
  res.on("close", finish);
}
