# Komputer roadmap

## 0.9.0 harness and public API

- Client-executed function tools for Chat Completions and Messages, JSON/SSE, schema validation,
  parallel/serial delivery, result retries, explicit cancellation and bounded in-memory state.
- Paused parents release compute slots, so nested harness requests do not deadlock behind them.
- Direct HTTPS, public/proxy configuration guards, strong-key checks, failed-auth limiting and opt-in CORS.
- Locked API dependencies and Linux CI for Node 22/24, including strict HTTPS verification.
- Local harness installation, cloud one-click installation and real deployment remain out of scope for this release.

## 0.8.0 naming migration (local changes, not deployed)

- Complete application under `Komputer/`; internal paths, environment, model IDs, HTTP/JSON
  metadata and generated log/temp names use komputer, with no previous branded aliases.
- Neutral per-installation Claude cwd outside the checkout; new conversations request workstation
  `system_info` before choosing commands and paths.
- Source naming guard and runtime metadata tests; deployment paths support a repository subdirectory
  and reject revisions from before the directory migration before resetting anything.
- See `docs/komputer-migration.md` for one-time configuration/client changes and state handling.
- Workstation executor renamed to `kloud-kode-body`, including its command, config directory,
  environment variables and service metadata; official Claude Code identifiers stay unchanged.
- Primary interaction is a local harness over the API. SSH interaction is optional.
  Client tool support is implemented in 0.9.0; see its documented protocol subset and validation limits.

Goal: a complete personal AI endpoint usable from any device (office PC, laptop on the road,
phone), backed by the owner's own official Claude Code. Prefer full functionality over
restrictions; keep it single-user and keep credentials inside the real `claude` binary.

## Done in 0.7.0 (2026-09-24)

- Island mode (L2) by default: `--tools ""` removes all brain-local tools, so the model
  only ever acts through the island MCP; `default` restores the legacy full set.
- Single-computer voice everywhere the model can see: new system note, `body_info`
  renamed to `system_info` with wrapper fields dropped, nested-MCP wording flattened.
- Claude child gets a minimal env allowlist plus `GIT_CEILING_DIRECTORIES`; optional
  `KOMPUTER_CLAUDE_CWD` and experimental `KOMPUTER_SYSTEM_PROMPT_FILE`.
- Fixed `komputer-session/.claude/settings.local.json` enabling a stale server name.

## Done in 0.5.0 (2026-09-23)

- Brain built-in tools back to Claude Code's full default set (`KOMPUTER_BUILTIN_TOOLS=default`).
- No cap on conversation mappings (`KOMPUTER_MAX_SESSIONS=0`); concurrency still bounded by in-flight slots.
- Requests without a conversation id run stateless with full client history instead of
  consuming a session (previously the 5th such request got 429).
- Model selection (`komputer-opus/sonnet/haiku`, any `komputer-<alias>`, raw `claude-*` ids) and
  effort (`reasoning_effort`, `effort`, Anthropic `thinking.budget_tokens`).
- Image and PDF attachments via `--input-format stream-json` (verified against real Claude with an image).
- Thinking streamed as `reasoning_content` / Anthropic thinking blocks.
- Regenerate / edit / retry detection: reseeds a fresh Claude session from the client's history.
- Open WebUI background tasks (`### Task:`) run on haiku without tools/MCP and never touch the chat.
- `X-Komputer-Ephemeral` for explicit one-shot turns; `/v1/messages/count_tokens`; multi-address listen.

## Done in 0.4.0 (2026-09-23)

- Real token streaming with SSE keepalive; tool progress notes; client disconnect kills `claude`.
- Prompt over stdin, system prompt via file; constant-time auth, quiet anonymous `/healthz`,
  SIGHUP key reload; clear 502/429 errors; first-turn uuid rotation; single-flight body probe.
- Test suite with a fake `claude`; deploy script with backup and auto-rollback.

## Next candidates

1. **Access from anywhere.** Devices on the tailnet already reach the brain directly, because
   userspace tailscaled forwards tailnet connections to loopback. Open: an extra listen port for
   a locked-down account, and optional HTTPS via `tailscale serve`.
2. **systemd user units** for komputer-api and the tunnel instead of pid files, with restart on
   failure and a watchdog that re-runs `tunnel-up.sh`.
3. **Body selection.** Several bodies (home PC, laptop) with a per-request header to choose which
   machine the MCP tools act on.
4. **Specific harness integration** and local/cloud one-click installers, after the API protocol release.
5. **Usage visibility.** Surface Claude plan usage / reset time in `/healthz`.
6. **Session housekeeping.** Prune mappings and Claude transcripts idle for N days.
