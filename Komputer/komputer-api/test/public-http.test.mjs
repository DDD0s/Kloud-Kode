import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import https from "node:https";
import net from "node:net";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { publicHttpConfig, privateListenAddress, AuthFailureLimiter } from "../public-http.mjs";
import { apiFixture, KEY, sleep } from "./helpers.mjs";

test("public HTTP requires an explicit protected-proxy opt-in; private listeners retain compatibility", async () => {
  for (const host of ["0.0.0.0", "::", "203.0.113.20", "api.example.invalid"]) {
    await assert.rejects(publicHttpConfig({}, [{ host }]), /require TLS/);
  }
  for (const host of ["127.0.0.1", "localhost", "::1", "10.0.0.2", "172.16.0.2", "192.168.1.2", "100.64.0.2", "fd00::1"]) {
    assert.equal(privateListenAddress(host), true);
    assert.equal((await publicHttpConfig({}, [{ host }])).tls, null);
  }
  assert.equal(privateListenAddress("fd00.example.invalid"), false);
  assert.equal((await publicHttpConfig({ KOMPUTER_ALLOW_INSECURE_HTTP: "1" }, [{ host: "0.0.0.0" }])).tls, null);
  await assert.rejects(publicHttpConfig({ KOMPUTER_TLS_CERT_FILE: "only-cert.pem" }, []), /both/);
  await assert.rejects(publicHttpConfig({ KOMPUTER_CORS_ORIGINS: "*" }, []));
  await assert.rejects(publicHttpConfig({ KOMPUTER_CORS_ORIGINS: "https://example.invalid/path" }, []), /exact/);
});

test("failed authentication is bounded per socket address, not spoofable forwarded headers", async (t) => {
  const f = await apiFixture(t, { env: { KOMPUTER_AUTH_FAILURE_LIMIT: "2" } }); await f.ready();
  for (let i = 0; i < 2; i++) {
    const r = await f.request("/v1/models", undefined, { headers: { authorization: "Bearer wrong", "x-forwarded-for": `192.0.2.${i}` } });
    assert.equal(r.status, 401);
  }
  const limited = await f.request("/v1/models", undefined, { headers: { authorization: "Bearer wrong", "x-forwarded-for": "192.0.2.123" } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal((await f.request("/v1/models")).status, 200, "valid credentials must not be locked out by another caller");
  const limiter = new AuthFailureLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limiter.failed("a", 0), 0);
  assert.equal(limiter.failed("a", 1), 1);
  assert.equal(limiter.failed("a", 1000), 0);
});

test("browser CORS is explicit, preflight does not bypass API authentication", async (t) => {
  const origin = "https://local-harness.example.invalid";
  const f = await apiFixture(t, { env: { KOMPUTER_CORS_ORIGINS: origin } }); await f.ready();
  const preflight = await f.request("/v1/chat/completions", undefined, { method: "OPTIONS", headers: {
    origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,x-conversation-id", authorization: "",
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/);
  assert.equal((await f.request("/v1/models", undefined, { headers: { origin, authorization: "" } })).status, 401);
  assert.equal((await f.request("/v1/models", undefined, { headers: { origin } })).status, 200);
  const bad = await f.request("/v1/models", undefined, { headers: { origin: "https://untrusted.example.invalid" } });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  const native = await f.request("/v1/models");
  assert.equal(native.status, 200, "native harnesses need no Origin header");
  assert.equal(native.headers.get("cache-control"), "no-store");
});

test("a malformed absolute request target cannot crash the public server", async (t) => {
  const f = await apiFixture(t); await f.ready();
  const address = new URL(f.base());
  const response = await new Promise((resolve, reject) => {
    let text = "";
    const socket = net.connect(Number(address.port), "127.0.0.1", () => socket.write("GET http://[invalid HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
    socket.setTimeout(2000, () => socket.destroy(new Error("socket timeout")));
    socket.on("data", (d) => (text += d));
    socket.on("end", () => resolve(text)); socket.on("error", reject);
  });
  assert.match(response, /HTTP\/1\.1 400/);
  assert.equal((await f.request("/v1/models")).status, 200);
});

test("invalid TLS files fail startup before opening any listener", async (t) => {
  const f = await apiFixture(t, { env: {
    KOMPUTER_TLS_CERT_FILE: (dir) => path.join(dir, "missing-cert.pem"),
    KOMPUTER_TLS_KEY_FILE: (dir) => path.join(dir, "missing-key.pem"),
  } });
  const exit = await Promise.race([f.exited, sleep(1500).then(() => null)]);
  assert.ok(exit);
  assert.notEqual(exit[0], 0);
  assert.doesNotMatch(f.logs(), /listening on/);
});

test("public API mode refuses short keys, including behind a loopback TLS proxy", async (t) => {
  const f = await apiFixture(t, { env: { KOMPUTER_PUBLIC_API: "1" }, prepare: (dir) => fs.writeFileSync(path.join(dir, "KEYS.txt"), "api-key: short\n") });
  const exit = await Promise.race([f.exited, sleep(1500).then(() => null)]);
  assert.ok(exit);
  assert.notEqual(exit[0], 0);
  assert.match(f.logs(), /at least 32 characters/);
  assert.doesNotMatch(f.logs(), /listening on/);
});

test("HTTPS serves authenticated model metadata and a complete harness tool round trip", async (t) => {
  const openssl = process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "openssl.exe") : "openssl";
  if (spawnSync(openssl, ["version"]).error) return t.skip("openssl unavailable for a temporary test certificate");
  const f = await apiFixture(t, { env: {
    KOMPUTER_TLS_CERT_FILE: (dir) => path.join(dir, "cert.pem"),
    KOMPUTER_TLS_KEY_FILE: (dir) => path.join(dir, "key.pem"),
    KOMPUTER_CLIENT_TOOL_TIMEOUT_MS: "2000",
  }, prepare: (dir) => {
    execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { stdio: "ignore" });
  } });
  await f.ready();
  const ca = fs.readFileSync(path.join(f.dir, "cert.pem"));
  // A dedicated loopback agent trusts only this fixture certificate; it must
  // not inherit an outbound proxy configured on the user's global agent.
  const agent = new https.Agent({ ca, proxyEnv: {}, keepAlive: false });
  t.after(() => agent.destroy());
  const request = (endpoint, body, key = KEY) => new Promise((resolve, reject) => {
    let peer;
    const r = https.request(f.base() + endpoint, { agent, method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    r.on("socket", (socket) => socket.prependListener("secure", () => {
      const cert = socket.getPeerCertificate();
      peer = { subject: cert.subject, issuer: cert.issuer, fingerprint: cert.fingerprint256 };
    }));
    r.setTimeout(5000, () => r.destroy(new Error("HTTPS timeout")));
    r.on("error", (e) => {
      const expected = new X509Certificate(ca);
      reject(new Error(`TLS verification failed (${e.code}); peer=${JSON.stringify(peer)} expected=${expected.subject}/${expected.issuer}/${expected.fingerprint256}`, { cause: e }));
    });
    r.end(body ? JSON.stringify(body) : undefined);
  });
  assert.equal((await request("/v1/models", undefined, "wrong")).status, 401);
  assert.equal((await request("/v1/models")).status, 200);
  const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } }];
  const first = await request("/v1/chat/completions", { tools, messages: [{ role: "user", content: "CLIENT_TOOL" }] });
  assert.equal(first.status, 200);
  const call = first.body.choices[0].message.tool_calls[0];
  const next = await request("/v1/chat/completions", { tools, messages: [{ role: "tool", tool_call_id: call.id, content: "HTTPS tool result" }] });
  assert.equal(next.status, 200);
  assert.match(next.body.choices[0].message.content, /HTTPS tool result/);
  assert.equal(f.calls().length, 1);
});
