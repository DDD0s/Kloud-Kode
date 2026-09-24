# Kloud Kode by Kosmolopic (internal name: AgentVR)

Source of truth for the project. The live copy runs on the brain host and is deployed
with `deploy/deploy.sh`. `SETUP.md` is the from-scratch guide; this file is the working memo.

## What it is

- **Brain:** official, unmodified Claude Code signed in with the owner's own Claude plan.
  `agentvr-api/server.mjs` is a small OpenAI / Anthropic compatible HTTP front that spawns
  `claude -p --resume <uuid>` per turn.
- **Body:** `cloudcode-body` on the workstation, reached from the brain through an SSH local
  forward (`agentvr/tunnel-up.sh`).
- **Clients:** any OpenAI-compatible chat UI, pointed at the brain's `/v1`.

## Hard rules

- Never turn this into a token proxy. The server must not read, copy, forward or imitate Claude
  OAuth tokens or Claude Code request fingerprints. Every Anthropic request comes from the real
  `claude` binary. That is the line between this and CLIProxyAPI-style tools that get banned.
- One person, one install. No multi-user features, no key sharing, no account pools. Someone else
  who wants it follows `SETUP.md` on their own Claude account.
- Never expose the API port directly to the public internet. Reach it over Tailscale, or behind an
  authenticating proxy. A key holder can run commands on the body machine.
- Keep the island sealed (L2): built-in local tools stay off by default, model-visible text
  (system note, MCP names/descriptions/outputs, turn prompts) describes exactly one computer
  and never narrates the split. Keep the brain's `~/.claude` free of skills, memory and CLAUDE.md.
- Do not commit `KEYS.txt`, `sessions.json`, `agentvr-api/env`, body tokens, or a real `.mcp.json`.
- Keep host-specific values (hostnames, tailnet addresses, absolute paths) out of tracked files;
  they belong in `agentvr-api/env`, which is git-ignored.

## Layout

| Path | Runs on |
|------|---------|
| `agentvr-api/` | the brain |
| `agentvr/` | the brain (tunnel) |
| `agentvr-session/` | the brain (Claude Code's cwd; `.mcp.json` token redacted here) |
| `cloudcode-body/` | the workstation |
| `deploy/` | your own machine |

## Workflow

```bash
cd agentvr-api && node --test test/server.test.mjs      # fake claude + fake body, ~25 s
cd cloudcode-body && node --test test/body.test.mjs      # real body process over HTTP
bash deploy/deploy.sh                                     # tests, brain pulls origin/main, restart, auto-rollback
bash deploy/deploy.sh rollback
```

For a real end-to-end check without touching production, run a second API instance on the brain
with `AGENTVR_API_PORT=18889` and its own `AGENTVR_SESSIONS_FILE`.

Files are LF-only (`.gitattributes`); shell scripts break on the Linux brain if CRLF sneaks in.

See `ROADMAP.md` for open work.

## Commits

Commit as the repository owner's account (DDD0s) with plain messages. Claude is credited as a
contributor here: commits Claude writes end with a `Co-Authored-By: Claude` trailer.
