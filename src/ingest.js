/** OTLP JSON ingest helpers (no protobuf). Live FinOps path for serve. */

import crypto from "node:crypto";

/** Default max POST body (1 MiB), same as B `maxBodyBytes`. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export const ENV_INGEST_TOKEN = "INGEST_TOKEN";

/** Canonical ingest path + collector-style alias. */
export const INGEST_PATH = "/v1/traces";
export const INGEST_PATH_ALIAS = "/v1/otlp/v1/traces";
export const INGEST_PATHS = new Set([INGEST_PATH, INGEST_PATH_ALIAS]);

export function isIngestPath(pathName) {
  return INGEST_PATHS.has(pathName || "");
}

/**
 * CLI `--ingest-token` wins when provided (including empty → off);
 * otherwise env INGEST_TOKEN. Default off (null) so stack-demo never 401s.
 */
export function resolveIngestToken(cliValue, env = process.env) {
  if (cliValue !== null && cliValue !== undefined) {
    const s = String(cliValue).trim();
    return s || null;
  }
  const environ = env && typeof env === "object" ? env : {};
  const raw = environ[ENV_INGEST_TOKEN];
  if (raw == null || String(raw).trim() === "") return null;
  return String(raw).trim();
}

/** Parse `Authorization: Bearer <token>`. Missing/empty/non-bearer → null. */
export function bearerTokenFromReq(req) {
  const raw = req?.headers?.authorization ?? req?.headers?.Authorization;
  if (raw == null || raw === "") return null;
  const s = Array.isArray(raw) ? String(raw[0]) : String(raw);
  const m = s.match(/^\s*Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}

function tokensEqual(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  const ha = crypto.createHash("sha256").update(left).digest();
  const hb = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(ha, hb) && left.length === right.length;
}

/**
 * When token is unset/empty, ingest is open (local default).
 * When set, require Authorization Bearer matching the token.
 */
export function ingestAuthorized(req, token) {
  if (token == null || token === "") return true;
  const got = bearerTokenFromReq(req);
  if (got == null || got === "") return false;
  return tokensEqual(got, token);
}

function otlpScalar(v) {
  if (v == null) return undefined;
  if (typeof v !== "object") return v;
  if (v.stringValue != null) return v.stringValue;
  if (v.intValue != null && v.intValue !== "") {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : v.intValue;
  }
  if (v.doubleValue != null && v.doubleValue !== "") {
    const n = Number(v.doubleValue);
    return Number.isFinite(n) ? n : v.doubleValue;
  }
  if (typeof v.boolValue === "boolean") return v.boolValue;
  return undefined;
}

/** OTel AnyValue / KeyValue list → plain map cost.js already understands. */
export function attrsToMap(attrs) {
  if (!attrs) return {};
  if (Array.isArray(attrs)) {
    const out = {};
    for (const a of attrs) {
      if (!a || typeof a !== "object") continue;
      const key = a.key ?? a.name;
      if (key == null || String(key).trim() === "") continue;
      const val = Object.prototype.hasOwnProperty.call(a, "value") ? otlpScalar(a.value) : otlpScalar(a);
      if (val !== undefined) out[String(key)] = val;
    }
    return out;
  }
  if (typeof attrs === "object") {
    const out = {};
    for (const [k, v] of Object.entries(attrs)) {
      const unwrapped = otlpScalar(v);
      out[k] = unwrapped !== undefined ? unwrapped : v;
    }
    return out;
  }
  return {};
}

function normalizeSpan(span, resourceAttrs = {}) {
  if (!span || typeof span !== "object") {
    return { attributes: { ...resourceAttrs } };
  }
  const spanAttrs = attrsToMap(span.attributes);
  return {
    ...span,
    attributes: { ...resourceAttrs, ...spanAttrs },
  };
}

/**
 * Flatten ingest JSON into cost.js spans.
 * Accepts:
 *   - existing flat array
 *   - `{ spans: [] }`
 *   - simplified OTLP `ExportTraceServiceRequest` (`resourceSpans[].scopeSpans[].spans[]`)
 * Invalid/empty shapes → [] (caller maps that to accepted:0). Does not throw.
 */
export function extractIngestSpans(body) {
  if (body == null) return [];
  if (Array.isArray(body)) return body.map((s) => normalizeSpan(s));
  if (typeof body !== "object") return [];
  if (Array.isArray(body.spans)) return body.spans.map((s) => normalizeSpan(s));
  if (Array.isArray(body.resourceSpans)) {
    const out = [];
    for (const rs of body.resourceSpans) {
      const resourceAttrs = attrsToMap(rs?.resource?.attributes);
      const scopes = rs?.scopeSpans || rs?.instrumentationLibrarySpans || [];
      if (!Array.isArray(scopes)) continue;
      for (const ss of scopes) {
        const spans = ss?.spans;
        if (!Array.isArray(spans)) continue;
        for (const span of spans) {
          out.push(normalizeSpan(span, resourceAttrs));
        }
      }
    }
    return out;
  }
  return [];
}

function payloadTooLargeError() {
  const err = new Error("payload_too_large");
  err.code = "payload_too_large";
  return err;
}

function badJsonError(cause) {
  const err = new Error("bad_json");
  err.code = "bad_json";
  if (cause) err.cause = cause;
  return err;
}

/**
 * Stream/count request body bytes; reject before JSON.parse when over maxBytes.
 * Honors Content-Length early when present (B-style). Empty body → {}.
 */
export function readJsonBody(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const limit =
      typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.floor(maxBytes)
        : DEFAULT_MAX_BODY_BYTES;

    const clRaw = req.headers?.["content-length"];
    if (clRaw != null && clRaw !== "") {
      const cl = Number(Array.isArray(clRaw) ? clRaw[0] : clRaw);
      if (Number.isFinite(cl) && cl > limit) {
        req.resume();
        return reject(payloadTooLargeError());
      }
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    const failTooLarge = () => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.resume();
      reject(payloadTooLargeError());
    };

    const onData = (c) => {
      size += c.length;
      if (size > limit) {
        failTooLarge();
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(badJsonError(err));
      }
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
