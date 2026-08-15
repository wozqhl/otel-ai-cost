/** In-memory sliding-window HTTP rate limit (client IP).
 *
 * Mirrors bets/f-cn-work-agent rate_limit.py / bets/b-mcp-gateway policy.js
 * (Node stdlib). Identity: X-Forwarded-For first hop, else socket remoteAddress.
 */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
export const WINDOW_SECONDS = 60;
export const ENV_RATE_LIMIT_PER_MINUTE = "RATE_LIMIT_PER_MINUTE";
export const ENV_RATE_LIMIT_RPM = "RATE_LIMIT_RPM";
export const RATE_LIMIT_SKIP_PATHS = new Set(["/health", "/ready", "/metrics"]);

/** k8s probes / Prometheus scrapes must never 429. */
export function skipRateLimit(path) {
  return RATE_LIMIT_SKIP_PATHS.has(path || "/");
}

function parseLimit(raw) {
  if (raw == null || raw === "") return { present: false, value: null };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { present: false, value: null };
  const i = Math.floor(n);
  if (i <= 0) return { present: true, value: null };
  return { present: true, value: i };
}

/**
 * CLI `--rate-limit` wins when provided (including 0 = unlimited).
 * Else env RATE_LIMIT_PER_MINUTE (F), else RATE_LIMIT_RPM, else 120.
 * null means unlimited.
 */
export function resolveRateLimit(cliValue, env = process.env) {
  const fromCli = parseLimit(cliValue);
  if (fromCli.present) return fromCli.value;
  const environ = env && typeof env === "object" ? env : {};
  const fromPerMin = parseLimit(environ[ENV_RATE_LIMIT_PER_MINUTE]);
  if (fromPerMin.present) return fromPerMin.value;
  const fromRpm = parseLimit(environ[ENV_RATE_LIMIT_RPM]);
  if (fromRpm.present) return fromRpm.value;
  return DEFAULT_RATE_LIMIT_PER_MINUTE;
}

/** Sliding window: key → timestamps within the last 60s. */
export class SlidingWindowRateLimiter {
  constructor(windowSeconds = WINDOW_SECONDS) {
    this.windowMs = Number(windowSeconds) * 1000;
    this.hits = new Map();
  }

  /**
   * Record a hit if under limit.
   * Returns { allowed, retryAfter } (retryAfter in seconds, min 1 when denied).
   * limit null or <=0 → always allowed.
   */
  check(key, limit, now = Date.now()) {
    if (limit == null || limit <= 0) return { allowed: true, retryAfter: 0 };
    const ts = Number(now);
    const windowStart = ts - this.windowMs;
    let hits = (this.hits.get(key) || []).filter((t) => t >= windowStart);
    if (hits.length >= limit) {
      const oldest = hits[0];
      const retryAfter = Math.max(1, Math.ceil((oldest + this.windowMs - ts) / 1000));
      this.hits.set(key, hits);
      return { allowed: false, retryAfter };
    }
    hits.push(ts);
    this.hits.set(key, hits);
    return { allowed: true, retryAfter: 0 };
  }

  clear() {
    this.hits.clear();
  }
}

/** Best-effort client IP (X-Forwarded-For first hop, else socket). */
export function clientIpFromReq(req) {
  const raw = req?.headers?.["x-forwarded-for"];
  if (raw != null && raw !== "") {
    const s = Array.isArray(raw) ? String(raw[0]) : String(raw);
    const hop = s.split(",")[0].trim();
    if (hop) return hop;
  }
  const remote = req?.socket?.remoteAddress || req?.connection?.remoteAddress;
  if (remote) return String(remote);
  return "unknown";
}
