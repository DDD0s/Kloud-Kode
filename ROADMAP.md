# AgentVR roadmap

Goal: a complete personal AI endpoint usable from any device (office PC, laptop on the road,
phone), backed by the owner's own official Claude Code. Prefer full functionality over
restrictions; keep it single-user and keep credentials inside the real `claude` binary.

## Done in 0.5.0 (2026-09-23)

- Brain built-in tools back to Claude Code's full default set (`AGENTVR_BUILTIN_TOOLS=default`).
- No cap on conversation mappings (`AGENTVR_MAX_SESSIONS=0`); concurrency still bounded by in-flight slots.
- Requests without a conversation id run stateless with full client history instead of
  consuming a session (previously the 5th such request got 429).
- Model selection (`agentvr-opus/sonnet/haiku`, any `agentvr-<alias>`, raw `claude-*` ids) and
  effort (`reasoning_effort`, `effort`, Anthropic `thinking.budget_tokens`).
- Image and PDF attachments via `--input-format stream-json` (verified against real Claude with an image).
- Thinking streamed as `reasoning_content` / Anthropic thinking blocks.
- Regenerate / edit / retry detection: reseeds a fresh Claude session from the client's history.
- Open WebUI background tasks (`### Task:`) run on haiku without tools/MCP and never touch the chat.
- `X-AgentVR-Ephemeral` for explicit one-shot turns; `/v1/messages/count_tokens`; multi-address listen.

## Done in 0.4.0 (2026-09-23)

- Real token streaming with SSE keepalive; tool progress notes; client disconnect kills `claude`.
- Prompt over stdin, system prompt via file; constant-time auth, quiet anonymous `/healthz`,
  SIGHUP key reload; clear 502/429 errors; first-turn uuid rotation; single-flight body probe.
- Test suite with a fake `claude`; deploy script with backup and auto-rollback.

## Next candidates

1. **Access from anywhere.** Devices on the tailnet already reach the brain directly, because
   userspace tailscaled forwards tailnet connections to loopback. Open: an extra listen port for
   a locked-down account, and optional HTTPS via `tailscale serve`.
2. **systemd user units** for agentvr-api and the tunnel instead of pid files, with restart on
   failure and a watchdog that re-runs `tunnel-up.sh`.
3. **Body selection.** Several bodies (home PC, laptop) with a per-request header to choose which
   machine the MCP tools act on.
4. **Client-defined tools** (OpenAI function calling) by exposing them to Claude Code through a
   small per-request MCP shim, for IDE agents that need them.
5. **Usage visibility.** Surface Claude plan usage / reset time in `/healthz`.
6. **Session housekeeping.** Prune mappings and Claude transcripts idle for N days.
