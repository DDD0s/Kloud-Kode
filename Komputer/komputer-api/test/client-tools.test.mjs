import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { apiFixture, KEY, sleep } from "./helpers.mjs";
import { clientToolRequest } from "../client-tools.mjs";

const definition = (name = "lookup") => ({ type: "function", function: { name, description: "Look up a value on this computer", strict: true,
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } });
const tools = [definition()];
const messages = (text = "CLIENT_TOOL") => [{ role: "user", content: text }];
const chat = (f, body, options) => f.request("/v1/chat/completions", body, options);
const reply = (first, values = ["local result"]) => [...first.requestMessages, first.json().choices[0].message,
  ...first.json().choices[0].message.tool_calls.map((c, i) => ({ role: "tool", tool_call_id: c.id, content: values[i] }))];
async function start(f, text = "CLIENT_TOOL", extra = {}) {
  const requestMessages = messages(text);
  const response = await chat(f, { model: "komputer-sonnet", messages: requestMessages, tools, ...extra });
  assert.equal(response.status, 200, response.text);
  response.requestMessages = requestMessages;
  return response;
}
const events = (text) => text.split("\n\n").filter((s) => /(?:^|\n)data: \{/.test(s)).map((s) => JSON.parse(s.split("\n").find((l) => l.startsWith("data: ")).slice(6)));

test("OpenAI harness executes a tool locally and continues the same Claude process without Body or SSH", async (t) => {
  const f = await apiFixture(t, { env: { NO_PROXY: "", no_proxy: "" } }); await f.ready();
  const first = await start(f);
  assert.equal(first.headers.get("x-komputer-mode"), "harness");
  assert.equal(first.json().choices[0].finish_reason, "tool_calls");
  const call = first.json().choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "lookup");
  assert.deepEqual(JSON.parse(call.function.arguments), { query: "hello 世界" });
  const localFile = path.join(f.dir, "local-tool-result.txt");
  fs.writeFileSync(localFile, "harness performed the operation");
  const next = await chat(f, { model: "komputer-sonnet", messages: reply(first, [fs.readFileSync(localFile, "utf8")]), tools });
  assert.equal(next.status, 200, next.text);
  assert.equal(next.json().choices[0].finish_reason, "stop");
  assert.match(next.json().choices[0].message.content, /harness performed the operation/);
  assert.equal(f.calls().length, 1);
  assert.equal(f.calls()[0].env.loopbackBypass, true);
  assert.equal(next.json().usage.completion_tokens, 11);
  assert.equal(f.calls()[0].args[f.calls()[0].args.indexOf("--tools") + 1], "");
  assert.doesNotMatch(f.logs(), /tunnel unhealthy/);
});

test("streaming OpenAI tool calls include IDs, indexes, JSON arguments and correct stop reasons", async (t) => {
  const f = await apiFixture(t); await f.ready();
  const r = await start(f, "CLIENT_TOOL", { stream: true });
  const chunks = events(r.text);
  const call = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || [])[0];
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(call.index, 0);
  assert.equal(call.type, "function");
  assert.equal(call.function.name, "lookup");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
  assert.match(r.text, /data: \[DONE\]/);
  const follow = await chat(f, { stream: true, tools, messages: [{ role: "tool", tool_call_id: call.id, content: "streamed result" }] });
  assert.equal(follow.status, 200, follow.text);
  assert.match(follow.text, /streamed result/);
  assert.equal(events(follow.text).at(-1).choices[0].finish_reason, "stop");
  assert.equal(events(follow.text).at(-1).model, "komputer-sonnet");
  assert.equal(f.calls().length, 1);
});

test("parallel calls require the complete batch; invalid results do not release either operation", async (t) => {
  const f = await apiFixture(t); await f.ready();
  const pair = [definition("one"), definition("two")];
  const first = await start(f, "CLIENT_TOOL_PARALLEL", { tools: pair });
  assert.equal(first.json().choices[0].message.tool_calls.length, 2);
  const full = reply(first, ["one result", "two result"]);
  const incomplete = await chat(f, { tools: pair, messages: full.slice(0, -1) });
  assert.equal(incomplete.status, 400);
  assert.equal((await f.request("/healthz")).json().client_tools.pending_tools, 2);
  const final = await chat(f, { tools: pair, messages: full });
  assert.equal(final.status, 200, final.text);
  assert.match(final.json().choices[0].message.content, /one result/);
  assert.match(final.json().choices[0].message.content, /two result/);
});

test("parallel_tool_calls=false delivers at most one tool per response and supports multiple rounds", async (t) => {
  const f = await apiFixture(t); await f.ready();
  const pair = [definition("one"), definition("two")];
  const first = await start(f, "CLIENT_TOOL_PARALLEL", { tools: pair, parallel_tool_calls: false });
  assert.equal(first.json().choices[0].message.tool_calls.length, 1);
  const second = await chat(f, { tools: pair, parallel_tool_calls: false, messages: reply(first) });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json().choices[0].message.tool_calls.length, 1);
  const call = second.json().choices[0].message.tool_calls[0];
  const final = await chat(f, { tools: pair, messages: [{ role: "tool", tool_call_id: call.id, content: "second" }] });
  assert.equal(final.json().choices[0].finish_reason, "stop");
  assert.equal(f.calls().length, 1);
});

test("a continuation can disable a queued parallel call without executing it", async (t) => {
  const f = await apiFixture(t); await f.ready();
  const pair = [definition("one"), definition("two")];
  const first = await start(f, "CLIENT_TOOL_PARALLEL", { tools: pair, parallel_tool_calls: false });
  const next = await chat(f, { tools: pair, tool_choice: "none", messages: reply(first) });
  assert.equal(next.status, 200, next.text);
  assert.equal(next.json().choices[0].finish_reason, "stop");
  assert.equal(next.json().choices[0].message.tool_calls, undefined);
  assert.match(next.json().choices[0].message.content, /not available/);
  assert.equal(f.calls().length, 1);
});

test("loopback MCP callback is authenticated and explicit cancellation closes a pending cycle", async (t) => {
  const f = await apiFixture(t); await f.ready();
  const first = await start(f);
  const args = f.calls()[0].args;
  const cfgPath = args[args.indexOf("--mcp-config") + 1];
  const config = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.komputer_use;
  assert.match(config.url, /^http:\/\/127\.0\.0\.1:/);
  const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }) };
  assert.equal((await fetch(config.url, request)).status, 403);
  assert.equal((await fetch(config.url, { ...request, headers: { ...request.headers, ...config.headers, Origin: "https://untrusted.example.invalid" } })).status, 403);
  const id = first.headers.get("x-komputer-run");
  assert.equal((await f.request(`/v1/tool-runs/${id}`, undefined, { method: "DELETE", headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await f.request(`/v1/tool-runs/${id}`, undefined, { method: "DELETE" })).status, 200);
  assert.equal(fs.existsSync(cfgPath), false, "temporary MCP credentials are removed on cancellation");
  assert.equal((await chat(f, { tools, messages: reply(first) })).status, 410);
});

test("identical initial and result retries replay stable IDs without a second model run", async (t) => {
  const f = await apiFixture(t); await f.ready();
  const first = await start(f);
  const retry = await start(f);
  assert.deepEqual(first.json().choices, retry.json().choices);
  const body = { tools, messages: reply(first) };
  const [a, b] = await Promise.all([chat(f, body), chat(f, body)]);
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  assert.deepEqual(a.json(), b.json());
  const conflicting = await chat(f, { tools, messages: reply(first, ["different result"]) });
  assert.equal(conflicting.status, 409);
  assert.equal(f.calls().length, 1);
});

test("a paused parent does not deadlock a nested harness run when compute concurrency is one", async (t) => {
  const f = await apiFixture(t, { env: { KOMPUTER_MAX_IN_FLIGHT: "1" } }); await f.ready();
  const parent = await start(f, "CLIENT_TOOL parent");
  assert.equal((await f.request("/healthz")).json().in_flight, 0);
  const child = await start(f, "CLIENT_TOOL child");
  const childResult = await chat(f, { tools, messages: reply(child, ["child completed"]) });
  assert.equal(childResult.status, 200, childResult.text);
  const parentResult = await chat(f, { tools, messages: reply(parent, [childResult.json().choices[0].message.content]) });
  assert.equal(parentResult.status, 200, parentResult.text);
  assert.match(parentResult.json().choices[0].message.content, /child completed/);
  assert.equal(f.calls().length, 2);
});

test("tool choice, argument schemas, Unicode chunking and error results are preserved", async (t) => {
  const f = await apiFixture(t); await f.ready();
  const pair = [definition("one"), definition("two")];
  const first = await start(f, "CLIENT_TOOL_UNICODE", { tools: pair, tool_choice: { type: "function", function: { name: "two" } } });
  const call = first.json().choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "two");
  assert.equal(JSON.parse(call.function.arguments).query, "你好".repeat(20_000));
  const final = await chat(f, { tools: pair, messages: [{ role: "tool", tool_call_id: call.id, content: "permission denied", is_error: true }] });
  assert.match(final.json().choices[0].message.content, /isError/);
  const corrected = await start(f, "CLIENT_TOOL_BAD_ARGS");
  assert.equal(corrected.json().choices[0].message.tool_calls.length, 1);
  assert.equal(typeof JSON.parse(corrected.json().choices[0].message.tool_calls[0].function.arguments).query, "string");
  assert.equal((await chat(f, { tools, messages: reply(corrected) })).status, 200);
  const none = await chat(f, { tools, tool_choice: "none", messages: messages("CLIENT_TOOL none") });
  assert.equal(none.json().choices[0].finish_reason, "stop");
  const required = await chat(f, { tools, tool_choice: "required", messages: messages("CLIENT_TOOL_NO_CALL") });
  assert.equal(required.status, 502);
  assert.equal(required.json().error.type, "tool_choice_error");
});

test("expired tool cycles, unknown IDs, changed schemas and unauthenticated results fail safely", async (t) => {
  const f = await apiFixture(t, { env: { KOMPUTER_CLIENT_TOOL_TIMEOUT_MS: "250" } }); await f.ready();
  const first = await start(f);
  const schemaChange = await chat(f, { tools: [definition("changed")], messages: reply(first) });
  assert.equal(schemaChange.status, 409);
  const unauthorized = await chat(f, { tools, messages: reply(first) }, { headers: { authorization: "Bearer wrong" } });
  assert.equal(unauthorized.status, 401);
  await sleep(350);
  const expired = await chat(f, { tools, messages: reply(first) });
  assert.equal(expired.status, 410);
  const unknown = await chat(f, { tools, messages: [{ role: "tool", tool_call_id: "not-a-real-call", content: "x" }] });
  assert.equal(unknown.status, 410);
  assert.equal(f.calls().length, 1);
});

test("Anthropic JSON and SSE exchange tool_use/tool_result with the original Claude process", async (t) => {
  for (const stream of [false, true]) await t.test(`stream=${stream}`, async (t) => {
    const f = await apiFixture(t); await f.ready();
    const declarations = [{ name: "lookup", description: "Look up", input_schema: definition().function.parameters }];
    const first = await f.request("/v1/messages", { tools: declarations, messages: messages(), stream });
    assert.equal(first.status, 200, first.text);
    let call;
    if (stream) {
      const blocks = events(first.text);
      call = blocks.find((b) => b.type === "content_block_start" && b.content_block.type === "tool_use").content_block;
      assert.equal(blocks[0].type, "message_start");
      assert.equal(blocks.at(-2).delta.stop_reason, "tool_use");
      assert.ok(blocks.some((b) => b.delta?.type === "input_json_delta"));
    } else {
      assert.equal(first.json().stop_reason, "tool_use");
      call = first.json().content.find((b) => b.type === "tool_use");
      assert.deepEqual(call.input, { query: "hello 世界" });
    }
    const next = await f.request("/v1/messages", { tools: declarations, stream, messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: call.id, content: [{ type: "text", text: "anthropic result" }] },
    ] }] });
    assert.equal(next.status, 200, next.text);
    assert.match(next.text, /anthropic result/);
    assert.equal(stream ? events(next.text).at(-2).delta.stop_reason : next.json().stop_reason, "end_turn");
    assert.equal(f.calls().length, 1);
  });
});

test("invalid and duplicate tool definitions are rejected before creating a process", async (t) => {
  const f = await apiFixture(t); await f.ready();
  for (const invalid of [[definition(), definition()], [{ type: "custom", name: "x" }], [definition("bad name")], [definition(123)]]) {
    assert.equal((await chat(f, { tools: invalid, messages: messages() })).status, 400);
  }
  assert.equal((await chat(f, { tools: [{ ...definition(), function: { ...definition().function, parameters: { type: "object", $ref: "https://example.invalid/schema" } } }], messages: messages() })).status, 400);
  assert.equal(f.calls().length, 0);
  assert.equal((await chat(f, { tools, messages: [null] })).status, 400);
  assert.equal((await f.request("/v1/messages", { tools: [], messages: [null] })).status, 400);
  assert.equal(clientToolRequest("openai", { messages: messages("normal") }), null);
});
