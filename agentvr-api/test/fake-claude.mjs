#!/usr/bin/env node
// Test double for the `claude` CLI: speaks --output-format stream-json and
// accepts --input-format stream-json. Behaviour is driven by keywords in the prompt.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const stateDir = process.env.FAKE_CLAUDE_STATE;
const argVal = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const resume = args.includes("--resume");
const sid = argVal("--resume") || argVal("--session-id") || null;
const sysFile = argVal("--append-system-prompt-file");
const streamInput = argVal("--input-format") === "stream-json";

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", main);

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const ev = (event) => out({ type: "stream_event", event });
const delta = (text) => ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let prompt = stdin;
  let attachments = [];
  if (streamInput) {
    const msg = JSON.parse(stdin.trim().split("\n")[0]);
    const content = msg.message.content;
    // The server sends the prompt text first, then attachment blocks.
    prompt = content[0].text;
    attachments = content.slice(1).map((b) => ({
      type: b.type,
      source_type: b.source?.type,
      media_type: b.source?.media_type,
      title: b.title,
      text: b.type === "text" ? b.text : undefined,
    }));
  }
  const system = sysFile && fs.existsSync(sysFile) ? fs.readFileSync(sysFile, "utf8") : null;
  fs.appendFileSync(
    path.join(stateDir, "calls.jsonl"),
    JSON.stringify({ args, prompt, system, attachments, pid: process.pid }) + "\n"
  );

  let previous = "";
  if (sid) {
    const sessFile = path.join(stateDir, `${sid}.txt`);
    if (!resume && fs.existsSync(sessFile)) {
      process.stderr.write(`Error: Session ID ${sid} is already in use.\n`);
      process.exit(1);
    }
    if (resume && !fs.existsSync(sessFile)) {
      process.stderr.write(`No conversation found with session ID: ${sid}\n`);
      process.exit(1);
    }
    previous = resume ? fs.readFileSync(sessFile, "utf8") : "";
    fs.writeFileSync(sessFile, prompt); // Claude persists the session as the turn starts
  }

  out({ type: "system", subtype: "init", session_id: sid });

  if (prompt.includes("FAIL_AUTH")) {
    const msg = "Failed to authenticate: OAuth session expired and could not be refreshed";
    out({ type: "result", subtype: "success", is_error: true, result: msg, session_id: sid });
    process.exit(1);
  }
  if (prompt.includes("FAIL_LIMIT")) {
    out({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Claude usage limit reached. Your limit will reset at 3pm.",
      session_id: sid,
    });
    process.exit(1);
  }
  if (prompt.includes("THINK")) {
    ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pondering" } });
  }
  if (prompt.includes("SLOW")) {
    for (let i = 0; i < 6; i++) {
      delta(`tick${i} `);
      await sleep(500);
    }
    fs.writeFileSync(path.join(stateDir, `finished-${process.pid}`), "1");
  }
  if (prompt.includes("TOOL")) {
    delta("checking");
    ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "mcp__agentvr__run_command" } });
    ev({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
  }
  const reply = resume ? `prev=${previous}|now=${prompt}` : `echo:${prompt}`;
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  delta(reply.slice(0, 5));
  delta(reply.slice(5));
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: reply,
    session_id: sid,
    usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 11 },
  });
}
