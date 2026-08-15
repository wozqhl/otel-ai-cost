#!/usr/bin/env node
/**
 * Tiny mock HTTP webhook receiver for E otel-ai-cost local-mvp.
 * Writes the last POST body to --out (default out/webhook-last.json).
 * Optional --secret: verify X-Webhook-Signature HMAC-SHA256 of the raw body.
 * Optional --headers-out: persist last request headers (+ verified flag + timestamp).
 * Records X-Webhook-Timestamp when present (OSS; replay window = paid).
 *
 *   node mock-webhook-receiver.js --port 8815 --out out/webhook-last.json
 *   node mock-webhook-receiver.js --port 8818 --secret whsec_local_mvp \
 *     --out out/webhook-hmac-last.json --headers-out out/webhook-hmac-last.headers.json
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { verifyWebhookSignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./src/webhook.js";

function parseArgs(argv) {
  let port = 8815;
  let host = "127.0.0.1";
  let out = "out/webhook-last.json";
  let headersOut = null;
  let secret = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") port = Number(argv[++i]);
    else if (a === "--host") host = argv[++i];
    else if (a === "--out") out = argv[++i];
    else if (a === "--headers-out") headersOut = argv[++i];
    else if (a === "--secret") secret = argv[++i];
  }
  if (typeof secret === "string") {
    secret = secret.trim() || null;
  } else {
    secret = null;
  }
  return { port, host, out, headersOut, secret };
}

const { port, host, out, headersOut, secret } = parseArgs(process.argv);
const outAbs = path.isAbsolute(out) ? out : path.resolve(process.cwd(), out);
const headersAbs = headersOut
  ? path.isAbsolute(headersOut)
    ? headersOut
    : path.resolve(process.cwd(), headersOut)
  : secret
    ? outAbs.replace(/(\.json)?$/, ".headers.json")
    : null;

function writeFileSafe(abs, contents) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const method = (req.method || "GET").toUpperCase();

  if (method === "GET" && url.pathname === "/health") {
    const body = JSON.stringify({ ok: true, service: "mock-webhook-receiver" });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    return res.end(body);
  }

  if (method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const sigHeader = req.headers["x-webhook-signature"] || req.headers[SIGNATURE_HEADER.toLowerCase()] || "";
      const tsHeader = req.headers["x-webhook-timestamp"] || req.headers[TIMESTAMP_HEADER.toLowerCase()] || "";
      let verified = null;
      if (secret) {
        verified = verifyWebhookSignature(secret, raw, sigHeader);
      }
      try {
        writeFileSafe(outAbs, raw || "");
        if (headersAbs) {
          const meta = {
            signature: sigHeader || null,
            timestamp: tsHeader || null,
            verified,
            headers: { ...req.headers },
          };
          writeFileSafe(headersAbs, JSON.stringify(meta, null, 2) + "\n");
        }
      } catch (err) {
        const msg = JSON.stringify({ ok: false, error: String(err?.message || err) });
        res.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(msg),
        });
        return res.end(msg);
      }
      if (secret && verified === false) {
        const deny = JSON.stringify({
          ok: false,
          error: "invalid_signature",
          received: true,
          verified: false,
          bytes: Buffer.byteLength(raw),
        });
        res.writeHead(401, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(deny),
        });
        return res.end(deny);
      }
      const ack = JSON.stringify({
        ok: true,
        received: true,
        bytes: Buffer.byteLength(raw),
        verified,
      });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(ack),
      });
      res.end(ack);
    });
    req.on("error", () => {
      res.writeHead(400);
      res.end();
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, host, () => {
  console.log(
    `mock-webhook-receiver listening on http://${host}:${port} out=${outAbs}` +
      (secret ? " verify=hmac" : "") +
      (headersAbs ? ` headers=${headersAbs}` : "")
  );
});
