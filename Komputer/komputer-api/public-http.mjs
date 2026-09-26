import { promises as fs } from "node:fs";
import { isIP } from "node:net";

const enabled = (v) => /^(1|true|yes|on)$/i.test(String(v || ""));

export function privateListenAddress(host) {
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
  }
  return isIP(host) === 6 && /^(fc|fd|fe[89ab])/i.test(host);
}

export async function publicHttpConfig(env, listeners) {
  const certFile = env.KOMPUTER_TLS_CERT_FILE;
  const keyFile = env.KOMPUTER_TLS_KEY_FILE;
  if (Boolean(certFile) !== Boolean(keyFile)) throw new Error("Configure both KOMPUTER_TLS_CERT_FILE and KOMPUTER_TLS_KEY_FILE");
  const tls = certFile ? {
    cert: await fs.readFile(certFile), key: await fs.readFile(keyFile),
    ...(env.KOMPUTER_TLS_KEY_PASSPHRASE ? { passphrase: env.KOMPUTER_TLS_KEY_PASSPHRASE } : {}),
    minVersion: "TLSv1.2",
    handshakeTimeout: 15_000,
  } : null;
  if (!tls && listeners.some((l) => !privateListenAddress(l.host)) && !enabled(env.KOMPUTER_ALLOW_INSECURE_HTTP)) {
    throw new Error("Public/wildcard listeners require TLS. For a protected TLS proxy backend, explicitly set KOMPUTER_ALLOW_INSECURE_HTTP=1");
  }
  const origins = new Set((env.KOMPUTER_CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean));
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) throw new Error("KOMPUTER_CORS_ORIGINS must contain exact HTTP(S) origins, without paths or wildcards");
  }
  return { tls, origins };
}

/** No cookies or wildcard origins: browser clients must send their API key. */
export function corsRequest(req, res, origins) {
  const origin = req.headers.origin;
  if (!origin) {
    if (req.method === "OPTIONS") { res.writeHead(400); res.end(); return false; }
    return true;
  }
  if (!origins.has(origin)) { res.writeHead(403); res.end(); return false; }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Expose-Headers", "X-Komputer-Mode,X-Komputer-Run,X-Conversation-Id,X-Chat-Id,X-Komputer-Session,X-Komputer-Claude-Session,X-Komputer-Session-Recovered,Retry-After");
  if (req.method !== "OPTIONS") return true;
  if (!["GET", "POST", "DELETE"].includes(req.headers["access-control-request-method"])) { res.writeHead(405); res.end(); return false; }
  const headers = String(req.headers["access-control-request-headers"] || "").split(",").map((h) => h.trim()).filter(Boolean);
  if (headers.some((h) => !/^[a-z0-9-]{1,64}$/i.test(h))) { res.writeHead(400); res.end(); return false; }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE");
  if (headers.length) res.setHeader("Access-Control-Allow-Headers", headers.join(","));
  res.setHeader("Access-Control-Max-Age", "600");
  res.writeHead(204); res.end(); return false;
}

export class AuthFailureLimiter {
  constructor({ limit = 20, windowMs = 60_000 } = {}) {
    this.limit = limit; this.windowMs = windowMs; this.entries = new Map();
  }
  failed(address, now = Date.now()) {
    let entry = this.entries.get(address);
    if (!entry || now - entry.at >= this.windowMs) {
      if (this.entries.size >= 4096) this.entries.delete(this.entries.keys().next().value);
      entry = { at: now, count: 0 }; this.entries.set(address, entry);
    }
    entry.count++;
    return entry.count > this.limit ? Math.max(1, Math.ceil((entry.at + this.windowMs - now) / 1000)) : 0;
  }
}
