---
name: ctxvitals
description: Audit the user's AI agent stack — measure real token cost of MCP servers (via live tools/list probing), skills, rules, commands, and hooks; flag security issues, duplicates, and stale configs; output an A–F grade. Use when the user asks to audit their agent setup, check MCP token cost, find context bloat, scan skills for security issues, or asks "what is my agent costing me".
---

# ctxvitals

Run the vitals check on this machine's agent stack.

## Usage

```bash
npx ctxvitals            # full audit with live MCP probing
npx ctxvitals --no-probe # static only
npx ctxvitals --json     # machine-readable
npx ctxvitals --html report.html
```

If `npx` is unavailable, run the repo directly:
`node <repo>/bin/ctxvitals.js`.

## Reading the output

- **CONTEXT BILL** — tokens consumed before the first user message, per item.
  `probed` = measured from a live `tools/list`; `static` = file-size estimate.
- **SECURITY** — HIGH needs immediate attention (exfil patterns, curl-pipe-sh,
  injection phrases, hardcoded secrets). MEDIUM is worth a look. LOW is hygiene.
- **GRADE** — A–F scorecard from measured numbers.

## After the audit

Suggest the fix, don't just report: remove duplicate servers, pin unpinned
packages, move plaintext secrets to env vars, delete stale configs, and trim
always-loaded rules/skill descriptions that no longer pull weight.
