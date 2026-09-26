# Kloud Kode by Kosmolopic (internal name: Komputer)

Source of truth for the project. The live copy runs on the brain host and is deployed
with `deploy/deploy.sh`. `SETUP.md` is the from-scratch guide; this file is the working memo.

## Product requirements

- Approximate native workstation use as closely as possible: operations must actually execute
  on the workstation, with faithful results, paths, shells, files, processes and application behavior.
- Keep the model on its island as thoroughly as practical. Reduce accidental host context,
  metadata and naming exposure; incomplete isolation is not a reason to stop improving it.
- Internal naming is **komputer**, without previous branded aliases. Product branding remains
  **Kloud Kode by Kosmolopic**. Run the naming regression when changing code or documentation.
- The complete application lives in `Komputer/` under the repository. Its normal Claude cwd is
  a separate neutral directory, not this checkout. See `docs/komputer-migration.md` before upgrading.
- The normal entry point is a harness on the local workstation connecting through the API.
  Direct SSH interaction with the official Claude Code CLI is optional, not the primary UX.
  Background SSH transport is not a requirement for the user to type commands into SSH.
- Our component names start with K (`komputer`, `kloud-kode-body`). The upstream product remains
  Claude Code and its executable remains `claude`; do not rename official identifiers or protocols.

## What it is

- **Brain:** official, unmodified Claude Code signed in with the owner's own Claude plan.
  `komputer-api/server.mjs` is a small OpenAI / Anthropic compatible HTTP front that spawns
  `claude -p --resume <uuid>` per turn.
- **Body:** `kloud-kode-body` on the workstation, reached from the brain through an SSH local
  forward (`komputer/tunnel-up.sh`).
- **Clients:** a local workstation harness, pointed at the brain's `/v1`. Chat UIs are optional examples,
  not remote-host dependencies. Client function tools travel over the API and execute in that harness.
  Requests without client tools retain Body MCP. See `docs/harness-api.md` for protocol limits.

## Hard rules

- Never turn this into a token proxy. The server must not read, copy, forward or imitate Claude
  OAuth tokens or Claude Code request fingerprints. Every Anthropic request comes from the real
  `claude` binary. That is the line between this and CLIProxyAPI-style tools that get banned.
- One person, one install. No multi-user features, no key sharing, no account pools. Someone else
  who wants it follows `SETUP.md` on their own Claude account.
- Public access is supported with verified HTTPS and strong API keys. Keep the default loopback
  binding; use configured TLS or a protected TLS proxy backend for public access. Do not weaken
  certificate verification to hide a networking failure. A key holder acts as the deployment owner.
- Keep the island sealed (L2): built-in local tools stay off by default, model-visible text
  (system note, MCP names/descriptions/outputs, turn prompts) describes exactly one computer
  and never narrates the split. Keep the brain's `~/.claude` free of skills, memory and CLAUDE.md.
- Do not commit `KEYS.txt`, `sessions.json`, `komputer-api/env`, body tokens, or a real `.mcp.json`.
- Keep host-specific values (hostnames, tailnet addresses, absolute paths) out of tracked files;
  they belong in `komputer-api/env`, which is git-ignored.

## Layout

| Path | Runs on |
|------|---------|
| `komputer-api/` | the brain |
| `komputer/` | the brain (tunnel) |
| `komputer-session/` | the brain (MCP configuration; `.mcp.json` token redacted here) |
| `kloud-kode-body/` | the workstation |
| `deploy/` | your own machine |

## Workflow

```bash
cd komputer-api && npm ci && npm test                  # fake claude + real protocol/TLS + failure paths
cd kloud-kode-body && node --test test/body.test.mjs      # real body process over HTTP
bash deploy/deploy.sh                                     # tests, brain pulls origin/main, restart, auto-rollback
bash deploy/deploy.sh rollback
```

For a real end-to-end check without touching production, run a second API instance on the brain
with `KOMPUTER_API_PORT=18889` and its own `KOMPUTER_SESSIONS_FILE`.

Files are LF-only (`.gitattributes`); shell scripts break on the Linux brain if CRLF sneaks in.

See `ROADMAP.md` for open work.

## Commits

Commit as the repository owner's account (DDD0s) with plain messages. Claude is credited as a
contributor here: commits Claude writes end with a `Co-Authored-By: Claude` trailer.
