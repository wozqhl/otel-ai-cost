/** CORS allowlist: preflight OPTIONS + ACAO on GET/POST. Default: disabled (no extra CORS).
 *
 * Mirrors bets/b-mcp-gateway/src/cors.js (Node stdlib) and C/F CLI+env origins.
 * Empty origins = deny extra CORS. '*' allows any Origin.
 */
export const DEFAULT_CORS_METHODS = ["GET", "HEAD", "POST", "OPTIONS"];
export const DEFAULT_CORS_HEADERS = ["Content-Type", "Authorization", "X-Request-Id"];
export const DEFAULT_CORS_EXPOSE_HEADERS = ["Retry-After", "X-Request-Id"];

export const ENV_CORS_ORIGINS = "OTEL_AI_COST_CORS_ORIGINS";

/** Split CSV origins; empty/null/undefined → []. '*' is a valid token. */
export function parseCorsOrigins(raw) {
  if (raw == null) return [];
  return String(raw)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * CLI `--cors-origins` wins when provided (including empty string); else env.
 * Pass cliValue=null/undefined to read env.
 */
export function resolveCorsOrigins(cliValue, env = process.env) {
  if (cliValue != null) return parseCorsOrigins(cliValue);
  const environ = env && typeof env === "object" ? env : {};
  return parseCorsOrigins(environ[ENV_CORS_ORIGINS] ?? "");
}

/**
 * Missing / empty origins => disabled (null). origins including '*' allows any Origin.
 */
export function normalizeCors(origins, { methods, headers, expose } = {}) {
  const cleaned = (origins || []).map((o) => String(o).trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  const meth =
    Array.isArray(methods) && methods.length
      ? methods.map((m) => String(m).trim().toUpperCase()).filter(Boolean)
      : DEFAULT_CORS_METHODS.slice();
  const hdrs =
    Array.isArray(headers) && headers.length
      ? headers.map((h) => String(h).trim()).filter(Boolean)
      : DEFAULT_CORS_HEADERS.slice();
  const exp =
    Array.isArray(expose) && expose.length
      ? expose.map((h) => String(h).trim()).filter(Boolean)
      : DEFAULT_CORS_EXPOSE_HEADERS.slice();
  return {
    origins: cleaned,
    methods: meth.length ? meth : DEFAULT_CORS_METHODS.slice(),
    headers: hdrs.length ? hdrs : DEFAULT_CORS_HEADERS.slice(),
    expose: exp,
    allowAny: cleaned.includes("*"),
  };
}

export function requestOrigin(req) {
  const raw = req?.headers?.origin;
  if (raw == null || raw === "") return null;
  const s = Array.isArray(raw) ? String(raw[0]) : String(raw);
  const t = s.trim();
  return t || null;
}

export function originAllowed(origin, cors) {
  if (!cors) return false;
  if (cors.allowAny) return true;
  if (!origin) return false;
  return cors.origins.includes(origin);
}

export function acaoValue(origin, cors) {
  if (!cors) return null;
  if (cors.allowAny) return "*";
  if (origin && cors.origins.includes(origin)) return origin;
  return null;
}

/** Headers to merge onto a real (non-preflight) response when Origin matches. */
export function corsResponseHeaders(req, cors) {
  if (!cors) return {};
  const origin = requestOrigin(req);
  const acao = acaoValue(origin, cors);
  if (!acao) return {};
  const headers = {
    "access-control-allow-origin": acao,
  };
  if (acao !== "*") headers.vary = "Origin";
  if (cors.expose && cors.expose.length) {
    headers["access-control-expose-headers"] = cors.expose.join(", ");
  }
  return headers;
}

/**
 * OPTIONS preflight.
 * Returns null when CORS is disabled (caller 404s as usual).
 * Allowed origin → { status: 204, headers, body: null }.
 * Explicit list + origin not allowed → { status: 403, headers: {}, body }.
 */
export function handlePreflight(req, cors) {
  if (!cors) return null;
  const origin = requestOrigin(req);
  if (!originAllowed(origin, cors)) {
    return {
      status: 403,
      headers: {},
      body: { error: "forbidden", reason: "cors_denied" },
    };
  }
  const acao = cors.allowAny ? "*" : origin;
  const headers = {
    "access-control-allow-origin": acao,
    "access-control-allow-methods": cors.methods.join(", "),
    "access-control-allow-headers": cors.headers.join(", "),
    "access-control-max-age": "600",
  };
  if (acao !== "*") headers.vary = "Origin";
  if (cors.expose && cors.expose.length) {
    headers["access-control-expose-headers"] = cors.expose.join(", ");
  }
  return { status: 204, headers, body: null };
}
